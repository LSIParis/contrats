import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { setTransitionContext, systemScope, uuidv7, withScope, type Scope } from '@lsi/persistence';
import {
  applyEvent, BusinessRuleError, extractContractMetadata, InvalidTransitionError,
  type ContractEvent, type ExtractedContractMetadata,
} from '@lsi/domain';
import { z } from 'zod';
import { assertKeyMatchesScope, DOCUMENT_STORAGE, type DocumentStorage } from '../documents/document-storage.port.js';
import { JOB_QUEUE, type JobQueue } from '../jobs/job-queue.port.js';
import { persistTransition, toContractSnapshot } from '../contracts/snapshot.js';
import { DeadlinesService } from '../deadlines/deadlines.service.js';
import { TenantConfigService } from '../tenant/tenant-config.service.js';
import type { UploadedDocument } from '../common/http-io.js';
import { OCR_CLIENT, OcrError, type OcrClientPort } from './ocr.client.js';

/**
 * Reprise des contrats existants (03-import-existant.md).
 *
 * Invariants de valeur probante :
 *   - l'ORIGINAL est stocké tel que reçu, empreinte calculée AVANT tout
 *     traitement, ligne stored_documents en écriture unique ;
 *   - l'OCR produit des copies DÉRIVÉES, jamais substituées à l'original ;
 *   - l'extraction est une PROPOSITION : rien n'est écrit sur le contrat
 *     avant la validation humaine (VALIDATE_IMPORT, rôle imports.validate).
 */

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_ATTEMPTS = 3;

/** Entier transmis en champ de formulaire (multipart : tout arrive en chaîne). */
const formInt = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().min(0));

export const ImportMetaSchema = z
  .object({
    customerId: z.uuid(),
    reference: z.string().trim().min(1).max(100).optional(),
    title: z.string().trim().min(1).max(300).optional(),
    category: z.enum(['MAINTENANCE', 'SUPPORT', 'HOSTING', 'SLA', 'OTHER']).optional(),
    // Indications SAISIES au dépôt (formulaire historique). Ce sont des
    // PROPOSITIONS, au même titre que l'extraction : rien n'est écrit sur le
    // contrat avant la validation humaine.
    startDate: z.iso.date().optional(),
    endDate: z.iso.date().optional(),
    signedAt: z.iso.date().optional(),
    noticePeriodDays: formInt.optional(),
    amountCents: formInt.optional(),
  })
  .strict();
export type ImportMeta = z.infer<typeof ImportMetaSchema>;

const isoDate = z.iso.date();

/** Champs retenus par le valideur. Le statut d'arrivée n'en fait PAS partie : le domaine le déduit des dates. */
export const ValidateImportSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    category: z.enum(['MAINTENANCE', 'SUPPORT', 'HOSTING', 'SLA', 'OTHER']).optional(),
    signedAt: isoDate.nullable().optional(),
    startDate: isoDate,
    endDate: isoDate.nullable().optional(),
    noticePeriodDays: z.number().int().min(0).max(3650).nullable().optional(),
    noticePeriodMonths: z.number().int().min(0).max(60).nullable().optional(),
    renewalMode: z.enum(['NONE', 'TACIT', 'EXPRESS']).default('NONE'),
    renewalPeriodMonths: z.number().int().min(1).max(120).nullable().optional(),
    amountCents: z.number().int().min(0).nullable().optional(),
    billingFrequency: z.enum(['MONTHLY', 'QUARTERLY', 'YEARLY', 'ONE_OFF']).optional(),
    chatelNotice: z.boolean().nullable().optional(),
    /** Commentaire du valideur (écarts avec la proposition, pièces consultées). */
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((v) => v.noticePeriodDays == null || v.noticePeriodMonths == null, {
    message: 'Le préavis s’exprime en jours ou en mois, pas les deux.',
    path: ['noticePeriodMonths'],
  })
  .refine((v) => v.renewalMode === 'NONE' || v.renewalPeriodMonths != null, {
    message: 'Une reconduction exige sa durée (renewalPeriodMonths).',
    path: ['renewalPeriodMonths'],
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, {
    message: 'Le terme ne peut pas précéder la date d’effet.',
    path: ['endDate'],
  });
export type ValidateImport = z.infer<typeof ValidateImportSchema>;

export interface ImportOcrJob {
  readonly importId: string;
  readonly tenantId: string;
  readonly customerId: string;
}

@Injectable()
export class ImportsService {
  private readonly log = new Logger(ImportsService.name);

  constructor(
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
    @Inject(OCR_CLIENT) private readonly ocrClient: OcrClientPort,
    private readonly deadlines: DeadlinesService,
    private readonly config: TenantConfigService,
  ) {}

  // -------------------------------------------------------------------------
  // Dépôt
  // -------------------------------------------------------------------------

  async importOne(scope: Scope, meta: ImportMeta, file: UploadedDocument, now: Date): Promise<{ id: string; importId: string }> {
    const kind = sniff(file);
    const created = await withScope(scope, async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: meta.customerId } });
      if (!customer) throw new NotFoundException('Client introuvable');

      const reference = meta.reference ?? (await this.nextImportReference(tx, now));
      const dup = await tx.contract.findFirst({ where: { reference }, select: { id: true } });
      if (dup) throw new ConflictException({ code: 'REF_DUP', detail: 'Un contrat avec cette référence existe déjà.' });

      const id = uuidv7();
      const importId = uuidv7();
      const docId = uuidv7();
      const objectScope = { tenantId: scope.tenantId, customerId: meta.customerId };
      // Empreinte calculée sur les octets REÇUS, avant tout traitement.
      const sha256 = createHash('sha256').update(file.buffer).digest('hex');
      const key = `t/${scope.tenantId}/c/${meta.customerId}/imports/${id}/original.${kind === PDF ? 'pdf' : 'docx'}`;
      assertKeyMatchesScope(key, objectScope);
      await this.storage.put(key, file.buffer, objectScope, kind);

      const title = meta.title ?? titleFromFilename(file.originalname);
      await setTransitionContext(tx, { event: 'IMPORT', reason: `Import de « ${file.originalname} »` });
      try {
        await tx.contract.create({
          data: {
            id, tenantId: scope.tenantId, customerId: meta.customerId, reference, title,
            type: 'MAIN', status: 'IMPORTED_PENDING_VALIDATION', origin: 'IMPORTED',
            category: meta.category ?? 'MAINTENANCE', billingFrequency: 'MONTHLY',
            // Colonnes historiques conservées (API interne existante).
            importedDocumentKey: key, importedDocumentName: file.originalname,
            importedDocumentSha256: sha256, importedDocumentContentType: kind,
            ownerUserId: scope.userId, createdAt: now, updatedAt: now,
            createdByUserId: scope.userId, updatedByUserId: scope.userId,
          },
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') {
          throw new ConflictException({ code: 'REF_DUP', detail: 'Un contrat avec cette référence existe déjà.' });
        }
        throw e;
      }
      await tx.storedDocument.create({
        data: {
          id: docId, tenantId: scope.tenantId, customerId: meta.customerId, contractId: id,
          kind: 'LEGACY_SCAN', origin: 'UPLOAD', objectKey: key, filename: file.originalname,
          contentType: kind, sizeBytes: BigInt(file.size), sha256,
          uploadedByUserId: scope.userId, createdAt: now,
        },
      });
      const declared = declaredProposal(meta);
      await tx.contractImport.create({
        data: {
          id: importId, tenantId: scope.tenantId, customerId: meta.customerId, contractId: id,
          originalDocumentId: docId,
          extraction: declared as never,
          extractionMethod: declared ? 'RULES' : null,
          extractedAt: declared ? now : null,
          // L'OCR ne s'applique qu'aux PDF ; un DOCX a déjà son texte.
          ocrStatus: kind === PDF ? 'PENDING' : 'SKIPPED',
          createdByUserId: scope.userId, createdAt: now, updatedAt: now,
        },
      });
      return { id, importId, needsOcr: kind === PDF };
    });

    // APRÈS commit : le worker ne doit pas lire une ligne non encore visible.
    if (created.needsOcr) {
      await this.jobs.enqueueImportOcr({ importId: created.importId, tenantId: scope.tenantId, customerId: meta.customerId });
    }
    return { id: created.id, importId: created.importId };
  }

  async importBatch(scope: Scope, customerId: string, files: UploadedDocument[], now: Date) {
    if (files.length === 0) throw new BadRequestException('Aucun document.');
    const results: { filename: string; id?: string; error?: string }[] = [];
    // Un fichier refusé n'annule pas le lot : chaque import est indépendant et
    // le résultat dit, fichier par fichier, ce qui a été fait.
    for (const f of files) {
      try {
        const r = await this.importOne(scope, { customerId }, f, now);
        results.push({ filename: f.originalname, id: r.id });
      } catch (e) {
        if (e instanceof NotFoundException) throw e; // client hors scope : tout le lot est refusé
        results.push({ filename: f.originalname, error: (e as Error).message });
      }
    }
    return { items: results };
  }

  // -------------------------------------------------------------------------
  // OCR + extraction (worker)
  // -------------------------------------------------------------------------

  async runOcr(job: ImportOcrJob, now: Date): Promise<'DONE' | 'FAILED' | 'RETRY' | 'SKIPPED'> {
    const scope = systemScope(job.tenantId, job.customerId);
    const objectScope = { tenantId: job.tenantId, customerId: job.customerId };

    const claimed = await withScope(scope, async (tx) => {
      const imp = await tx.contractImport.findUnique({ where: { id: job.importId }, include: { original: true } });
      if (!imp || imp.ocrStatus !== 'PENDING') return null;
      await tx.contractImport.update({
        where: { id: imp.id },
        data: { ocrStatus: 'RUNNING', ocrAttempts: { increment: 1 }, updatedAt: now },
      });
      return imp;
    });
    if (!claimed) return 'SKIPPED';

    try {
      const original = await this.storage.get(claimed.original.objectKey, objectScope);
      if (!original) throw new OcrError('original_missing', 'Document original introuvable dans le stockage', false);
      const result = await this.ocrClient.ocr(original);
      // Les valeurs SAISIES au dépôt priment sur l'extraction automatique.
      const extraction = {
        ...toStoredExtraction(extractContractMetadata(result.text)),
        ...nonNull(claimed.extraction as Record<string, unknown> | null),
      };

      const base = `t/${job.tenantId}/c/${job.customerId}/imports/${claimed.contractId}`;
      const pdfKey = `${base}/ocr-${claimed.ocrAttempts + 1}.pdf`;
      const txtKey = `${base}/ocr-${claimed.ocrAttempts + 1}.txt`;
      const text = Buffer.from(result.text, 'utf8');
      await this.storage.put(pdfKey, result.searchablePdf, objectScope, PDF);
      await this.storage.put(txtKey, text, objectScope, 'text/plain; charset=utf-8');

      await withScope(scope, async (tx) => {
        const pdfId = uuidv7();
        const txtId = uuidv7();
        for (const [id, key, kind, buf, type] of [
          [pdfId, pdfKey, 'OCR_PDF', result.searchablePdf, PDF],
          [txtId, txtKey, 'OCR_TEXT', text, 'text/plain; charset=utf-8'],
        ] as const) {
          await tx.storedDocument.create({
            data: {
              id, tenantId: job.tenantId, customerId: job.customerId, contractId: claimed.contractId,
              kind, origin: 'OCR', objectKey: key, filename: key.split('/').pop()!, contentType: type,
              sizeBytes: BigInt(buf.length), sha256: createHash('sha256').update(buf).digest('hex'),
              derivedFromId: claimed.originalDocumentId, createdAt: now,
            },
          });
        }
        await tx.contractImport.update({
          where: { id: claimed.id },
          data: {
            ocrStatus: 'DONE', ocrPages: result.pages, ocrError: null,
            ocrPdfDocumentId: pdfId, ocrTextDocumentId: txtId,
            extraction: extraction as never, extractionMethod: 'RULES', extractedAt: now, updatedAt: now,
          },
        });
      });
      return 'DONE';
    } catch (e) {
      const retryable = e instanceof OcrError ? e.retryable : true;
      const exhausted = claimed.ocrAttempts + 1 >= MAX_ATTEMPTS;
      const status = retryable && !exhausted ? 'PENDING' : 'FAILED';
      await withScope(scope, (tx) =>
        tx.contractImport.update({
          where: { id: claimed.id },
          data: { ocrStatus: status, ocrError: (e as Error).message.slice(0, 500), updatedAt: now },
        }),
      );
      this.log.warn(`OCR de l'import ${claimed.id} : ${status} (${(e as Error).message})`);
      return status === 'PENDING' ? 'RETRY' : 'FAILED';
    }
  }

  async retryOcr(scope: Scope, contractId: string, now: Date): Promise<{ ocrStatus: string }> {
    const imp = await withScope(scope, async (tx) => {
      const i = await tx.contractImport.findUnique({ where: { contractId } });
      if (!i) throw new NotFoundException('Import introuvable');
      if (i.ocrStatus !== 'FAILED') throw new ConflictException({ code: 'OCR_NOT_FAILED', detail: 'Seul un OCR en échec peut être relancé.' });
      await tx.contractImport.update({ where: { id: i.id }, data: { ocrStatus: 'PENDING', ocrAttempts: 0, ocrError: null, updatedAt: now } });
      return i;
    });
    await this.jobs.enqueueImportOcr({ importId: imp.id, tenantId: imp.tenantId, customerId: imp.customerId });
    return { ocrStatus: 'PENDING' };
  }

  // -------------------------------------------------------------------------
  // Lecture (écran de validation côte à côte)
  // -------------------------------------------------------------------------

  async get(scope: Scope, contractId: string) {
    return withScope(scope, async (tx) => {
      const imp = await tx.contractImport.findUnique({
        where: { contractId },
        include: {
          contract: {
            select: {
              id: true, reference: true, title: true, status: true, category: true, customerId: true,
              startDate: true, endDate: true, signedAt: true, noticePeriodDays: true, noticePeriodMonths: true,
              renewalMode: true, renewalPeriodMonths: true, amountCents: true, billingFrequency: true,
            },
          },
          original: { select: { id: true, filename: true, contentType: true, sizeBytes: true, sha256: true, createdAt: true, uploadedByUserId: true } },
          ocrPdf: { select: { id: true, sizeBytes: true, sha256: true } },
        },
      });
      if (!imp) throw new NotFoundException('Import introuvable');
      return {
        contract: imp.contract,
        origin: 'LEGACY_IMPORT' as const,
        signatureMode: 'EXTERNAL_WET_SIGNATURE' as const,
        original: imp.original,
        ocr: { status: imp.ocrStatus, attempts: imp.ocrAttempts, pages: imp.ocrPages, error: imp.ocrError, searchablePdf: imp.ocrPdf },
        extraction: imp.extraction,
        extractionMethod: imp.extractionMethod,
        validated: imp.validatedAt
          ? { at: imp.validatedAt, byUserId: imp.validatedByUserId, fields: imp.validatedFields }
          : null,
      };
    });
  }

  async ocrPdf(scope: Scope, contractId: string): Promise<{ buffer: Buffer; reference: string }> {
    const found = await withScope(scope, async (tx) => {
      const imp = await tx.contractImport.findUnique({
        where: { contractId },
        include: { ocrPdf: true, contract: { select: { reference: true } } },
      });
      if (!imp?.ocrPdf) throw new NotFoundException('Copie OCR indisponible');
      return { key: imp.ocrPdf.objectKey, customerId: imp.customerId, reference: imp.contract.reference };
    });
    const buffer = await this.storage.get(found.key, { tenantId: scope.tenantId, customerId: found.customerId });
    if (!buffer) throw new NotFoundException('Copie OCR indisponible');
    return { buffer, reference: found.reference };
  }

  // -------------------------------------------------------------------------
  // Validation humaine
  // -------------------------------------------------------------------------

  async validate(scope: Scope, contractId: string, v: ValidateImport, now: Date) {
    const thresholds = (await this.config.setting(scope, 'alerts.thresholdsDays')) as number[];
    return withScope(scope, async (tx) => {
      const imp = await tx.contractImport.findUnique({ where: { contractId } });
      const c = await tx.contract.findUnique({ where: { id: contractId } });
      if (!imp || !c) throw new NotFoundException('Import introuvable');
      if (c.status !== 'IMPORTED_PENDING_VALIDATION') {
        throw new ConflictException({ code: 'IMPORT_ALREADY_VALIDATED', detail: `Ce contrat est au statut ${c.status}.` });
      }

      const fields = {
        title: v.title ?? c.title,
        category: v.category ?? c.category,
        signedAt: v.signedAt ? new Date(v.signedAt) : null,
        startDate: new Date(v.startDate),
        endDate: v.endDate ? new Date(v.endDate) : null,
        noticePeriodDays: v.noticePeriodDays ?? null,
        noticePeriodMonths: v.noticePeriodMonths ?? null,
        renewalMode: v.renewalMode,
        renewalPeriodMonths: v.renewalPeriodMonths ?? null,
        amountCents: v.amountCents != null ? BigInt(v.amountCents) : null,
        billingFrequency: v.billingFrequency ?? c.billingFrequency,
        chatelNotice: v.chatelNotice ?? null,
      };
      const updated = await tx.contract.update({
        where: { id: contractId },
        data: { ...fields, updatedAt: now, updatedByUserId: scope.userId },
      });

      const event: ContractEvent = { type: 'VALIDATE_IMPORT', actorUserId: scope.userId };
      let next;
      try {
        next = applyEvent(toContractSnapshot(updated), event, now);
      } catch (e) {
        if (e instanceof InvalidTransitionError || e instanceof BusinessRuleError) {
          throw new ConflictException({ code: (e as { code: string }).code, detail: e.message });
        }
        throw e;
      }
      await persistTransition(tx, contractId, event, next, now, scope.userId);

      await tx.contractImport.update({
        where: { id: imp.id },
        data: {
          validatedFields: { ...v, retainedAt: now.toISOString() } as never,
          validatedByUserId: scope.userId, validatedAt: now, updatedAt: now,
        },
      });

      if (fields.endDate) {
        await tx.contractPeriod.create({
          data: {
            id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId,
            periodNumber: 1, kind: 'INITIAL', startDate: fields.startDate, endDate: fields.endDate,
            createdByUserId: scope.userId, createdAt: now,
          },
        });
      }
      const deadlines = await this.deadlines.recompute(tx, contractId, thresholds, now);
      return { id: contractId, status: next.status, deadlinesCreated: deadlines.created };
    });
  }

  private async nextImportReference(tx: any, now: Date): Promise<string> {
    const prefix = `IMP-${now.getUTCFullYear()}-`;
    const count = await tx.contract.count({ where: { reference: { startsWith: prefix } } });
    return `${prefix}${String(count + 1).padStart(4, '0')}`;
  }
}

/**
 * Type RÉEL du fichier, par ses premiers octets : le Content-Type déclaré par
 * le client ne prouve rien. Un « PDF » qui n'en est pas un est refusé.
 */
function sniff(file: UploadedDocument): typeof PDF | typeof DOCX {
  const head = file.buffer.subarray(0, 5).toString('latin1');
  if (file.mimetype === PDF && head === '%PDF-') return PDF;
  if (file.mimetype === DOCX && head.startsWith('PK')) return DOCX;
  throw new BadRequestException('Format non supporté ou contenu incohérent (PDF ou DOCX attendu).');
}

function titleFromFilename(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return (base || 'Contrat importé').slice(0, 300);
}

/** Proposition stockée : chaque champ annoté de sa méthode d'obtention. */
function toStoredExtraction(m: ExtractedContractMetadata): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(m)) out[k] = f ? { ...f, method: 'RULES' } : null;
  return out;
}

/** Indications saisies au dépôt → proposition (confiance 1, méthode SAISIE). */
function declaredProposal(meta: ImportMeta): Record<string, unknown> | null {
  const f = (value: unknown) => ({ value, confidence: 1, evidence: null, method: 'SAISIE' });
  const out: Record<string, unknown> = {};
  if (meta.startDate) out.dateEffet = f(meta.startDate);
  if (meta.endDate) out.dateFin = f(meta.endDate);
  if (meta.signedAt) out.dateSignature = f(meta.signedAt);
  if (meta.noticePeriodDays != null) out.preavis = f({ quantite: meta.noticePeriodDays, unite: 'JOURS' });
  if (meta.amountCents != null) out.montantCentimes = f(meta.amountCents);
  return Object.keys(out).length ? out : null;
}

function nonNull(o: Record<string, unknown> | null): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v != null));
}

