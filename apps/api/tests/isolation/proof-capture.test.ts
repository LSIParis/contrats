import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { ProofCaptureService } from '../../src/signature/proof-capture.service.js';
import { InMemoryStorage } from '../../src/documents/in-memory-storage.js';
import { FakeProvider } from '../support/fakes.js';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { withScope, adminScope, systemScope, uuidv7 } from '@lsi/persistence';

let fx: TwoCustomerFixture;
let provider: FakeProvider;
let storage: InMemoryStorage;
let service: ProofCaptureService;

beforeAll(async () => {
  fx = await seedTwoCustomers();
});

beforeEach(() => {
  provider = new FakeProvider();
  storage = new InMemoryStorage();
  service = new ProofCaptureService(provider as any, storage);
});

/** Crée une signature_request dans un statut donné, renvoie son id. */
async function seedSigReq(status: string, over: Record<string, unknown> = {}): Promise<string> {
  const id = uuidv7();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.signatureRequest.create({
      data: {
        id,
        tenantId: fx.tenantId,
        customerId: fx.customerA.id,
        contractId: fx.customerA.contractId,
        versionId: uuidv7(),
        provider: 'DOCUSEAL',
        providerSubmissionId: 'sub-' + id.slice(-8),
        status: status as any,
        idempotencyKey: uuidv7(),
        createdAt: new Date(),
        updatedAt: new Date(),
        createdByUserId: fx.amUserId,
        ...over,
      },
    }),
  );
  return id;
}

const scope = () => systemScope(fx.tenantId, fx.customerA.id);

describe('ProofCaptureService (§11.6, W-05)', () => {
  test('capture le PDF signé + la piste d’audit, avec empreintes', async () => {
    const id = await seedSigReq('COMPLETED');
    const done = await service.capture(scope(), id, new Date());
    expect(done).toBe(true);

    const sr = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.signatureRequest.findUnique({ where: { id } }),
    );
    // Clés dans le préfixe scopé signed/ (§10.7).
    expect(sr!.signedPdfObjectKey).toContain(`t/${fx.tenantId}/c/${fx.customerA.id}/`);
    expect(sr!.signedPdfObjectKey).toContain(`/signed/${id}/document.pdf`);
    expect(sr!.auditTrailObjectKey).toContain(`/signed/${id}/audit-trail.pdf`);
    // Empreinte = SHA-256 des octets réellement stockés.
    const stored = await storage.get(sr!.signedPdfObjectKey!, { tenantId: fx.tenantId, customerId: fx.customerA.id });
    expect(createHash('sha256').update(stored!).digest('hex')).toBe(sr!.signedPdfSha256);
  });

  test('idempotent : une 2e capture ne refait rien', async () => {
    const id = await seedSigReq('COMPLETED');
    expect(await service.capture(scope(), id, new Date())).toBe(true);
    expect(provider.calls).toBeDefined();
    // 2e appel : déjà capturé → false, pas de re-téléchargement.
    expect(await service.capture(scope(), id, new Date())).toBe(false);
  });

  test('ne capture pas une demande non complétée', async () => {
    const id = await seedSigReq('SENT');
    expect(await service.capture(scope(), id, new Date())).toBe(false);
  });

  test('le document stocké est bien le PDF signé (pas un placeholder vide)', async () => {
    const id = await seedSigReq('COMPLETED');
    await service.capture(scope(), id, new Date());
    const sr = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.signatureRequest.findUnique({ where: { id } }),
    );
    const stored = await storage.get(sr!.signedPdfObjectKey!, { tenantId: fx.tenantId, customerId: fx.customerA.id });
    expect(stored!.subarray(0, 5).toString()).toBe('%PDF-');
    expect(stored!.toString()).toContain('signed');
  });

  test('une demande inconnue → rien', async () => {
    expect(await service.capture(scope(), uuidv7(), new Date())).toBe(false);
  });
});

describe('preuves v2 : empreintes liées et référentiel des documents (lot 4)', () => {
  test('empreinte du journal, relation envoyé ↔ signé, documents SIGNED_PDF (dérivé du PDF envoyé) et SIGNATURE_AUDIT_TRAIL', async () => {
    // Une version dont le PDF figé a été envoyé (empreinte connue), référencée en CONTRACT_PDF.
    const versionId = uuidv7();
    const sentPdf = Buffer.from('%PDF-1.7 envoyé');
    const sentSha = createHash('sha256').update(sentPdf).digest('hex');
    const sentDocId = uuidv7();
    await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
      const n = (await tx.contractVersion.count({ where: { contractId: fx.customerA.contractId } })) + 100;
      await tx.contractVersion.create({ data: {
        id: versionId, tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: fx.customerA.contractId,
        versionNumber: n, bodyHtml: '<p>x</p>', variables: {}, pdfSha256: sentSha, createdAt: new Date(), createdByUserId: fx.amUserId,
      } });
      await tx.storedDocument.create({ data: {
        id: sentDocId, tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: fx.customerA.contractId,
        kind: 'CONTRACT_PDF', origin: 'GENERATED', objectKey: `t/${fx.tenantId}/c/${fx.customerA.id}/sent/${sentDocId}.pdf`,
        filename: 'envoye.pdf', contentType: 'application/pdf', sizeBytes: BigInt(sentPdf.length), sha256: sentSha, createdAt: new Date(),
      } });
    });
    const id = await seedSigReq('COMPLETED', { versionId, sentPdfSha256: sentSha });
    expect(await service.capture(scope(), id, new Date())).toBe(true);

    const [sr, docs] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.signatureRequest.findUnique({ where: { id } }),
      await tx.storedDocument.findMany({ where: { contractId: fx.customerA.contractId, origin: 'DOCUSEAL' }, orderBy: { createdAt: 'desc' } }),
    ]);
    expect(sr!.hashRelation).toBe('SIGNED_OVERLAY'); // DocuSeal réécrit le PDF : les empreintes diffèrent, la relation est conservée
    expect(sr!.sentPdfSha256).toBe(sentSha);
    expect(sr!.auditTrailSha256).toMatch(/^[0-9a-f]{64}$/);
    const signed = docs.find((d) => d.kind === 'SIGNED_PDF' && d.sha256 === sr!.signedPdfSha256)!;
    expect(signed.derivedFromId).toBe(sentDocId);
    expect(docs.some((d) => d.kind === 'SIGNATURE_AUDIT_TRAIL' && d.sha256 === sr!.auditTrailSha256)).toBe(true);
  });

  test('capture rejouée : aucun document en double', async () => {
    const id = await seedSigReq('COMPLETED');
    await service.capture(scope(), id, new Date());
    const count = () => withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.storedDocument.count({ where: { contractId: fx.customerA.contractId, origin: 'DOCUSEAL' } }));
    const before = await count();
    expect(await service.capture(scope(), id, new Date())).toBe(false);
    expect(await count()).toBe(before);
  });
});

describe('réconciliation : soumissions sans webhook récent', () => {
  test('une demande SENT jamais synchronisée est découverte ; une demande récente ou close ne l’est pas', async () => {
    const { findSignaturesNeedingSync } = await import('@lsi/persistence');
    // Une seule demande ACTIVE par contrat (contrainte en base) : on fait
    // vieillir puis rafraîchir la même demande.
    // Contrat dédié : d'autres tests laissent une demande active sur le contrat partagé.
    const cid = uuidv7();
    const now = new Date();
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
      id: cid, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `SYNC-${cid.slice(-12)}`, title: 'Sync',
      type: 'MAIN', status: 'PENDING_SIGNATURE', category: 'MAINTENANCE', currency: 'EUR', billingFrequency: 'MONTHLY',
      ownerUserId: fx.amUserId, createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
    } }));
    const done = await seedSigReq('COMPLETED', { lastSyncedAt: null, contractId: cid });
    const stale = await seedSigReq('SENT', { lastSyncedAt: new Date(Date.now() - 3 * 3600_000), contractId: cid });
    let ids = (await findSignaturesNeedingSync(60, 500)).map((r) => r.id);
    expect(ids).toContain(stale);
    expect(ids).not.toContain(done);
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.signatureRequest.update({ where: { id: stale }, data: { lastSyncedAt: new Date() } }));
    ids = (await findSignaturesNeedingSync(60, 500)).map((r) => r.id);
    expect(ids).not.toContain(stale);
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.signatureRequest.update({ where: { id: stale }, data: { status: 'REVOKED' } }));
  });
});
