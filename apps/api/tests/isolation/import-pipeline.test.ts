import { describe, test, expect, beforeAll } from 'vitest';
import { createTestApp } from '../support/app.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { ImportsService } from '../../src/imports/imports.service.js';
import { DeadlinesService } from '../../src/deadlines/deadlines.service.js';
import { OCR_CLIENT, OcrError, type OcrClientPort, type OcrResult } from '../../src/imports/ocr.client.js';
import { adminScope, clientScope, internalScope, withScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

/**
 * Reprise des contrats existants — 03-import-existant.md.
 * OCR simulé sur fixtures capturées (test/fixtures/ocr/), aucun appel réseau.
 */
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../test/fixtures/ocr/${name}`, import.meta.url)), 'utf8');

class FakeOcr implements OcrClientPort {
  next: (() => Promise<OcrResult>) | null = null;
  calls = 0;
  async ocr(): Promise<OcrResult> {
    this.calls++;
    if (this.next) return this.next();
    const r = JSON.parse(fixture('ocr-response.success.json'));
    return { text: r.text, pages: r.pages, searchablePdf: Buffer.from(r.pdfBase64, 'base64') };
  }
}

let app: INestApplication;
let fx: TwoCustomerFixture;
let other: TwoCustomerFixture;
let imports: ImportsService;
const ocr = new FakeOcr();

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(OCR_CLIENT).useValue(ocr)
    .compile();
  app = await createTestApp(mod);
  imports = app.get(ImportsService);
  fx = await seedTwoCustomers();
  other = await seedTwoCustomers(); // second tenant
  const s = app.get(SessionService);
  await s.put({ sessionId: 'imp-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'imp-am-b', userId: fx.amBUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) });
  await s.put({ sessionId: 'imp-legal', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['LEGAL_REVIEWER'], scope: adminScope(fx.tenantId, fx.adminUserId) });
  await s.put({ sessionId: 'imp-client', userId: fx.customerA.clientUserId, tenantId: fx.tenantId, roles: ['CLIENT_SIGNER'], scope: clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId) });
  await s.put({ sessionId: 'imp-other-admin', userId: other.adminUserId, tenantId: other.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(other.tenantId, other.adminUserId) });
});

const http = () => request(app.getHttpServer());
const pdf = (tag: string) => Buffer.from(`%PDF-1.7\n% ${tag}\n%%EOF`, 'utf8');
const admin = () => adminScope(fx.tenantId, fx.adminUserId);

async function upload(tag: string, extra: Record<string, string> = {}) {
  let req = http().post('/v1/contracts/import').set('x-lsi-session', 'imp-am').field('customerId', fx.customerA.id);
  for (const [k, v] of Object.entries(extra)) req = req.field(k, v);
  const res = await req.attach('document', pdf(tag), { filename: `${tag}.pdf`, contentType: 'application/pdf' }).expect(201);
  return res.body as { id: string; importId: string };
}

async function ocrOf(importId: string) {
  return imports.runOcr({ importId, tenantId: fx.tenantId, customerId: fx.customerA.id }, new Date());
}

describe('dépôt : l’original est conservé tel quel, empreinte calculée à la réception', () => {
  test('LEGACY_SCAN + SHA-256 des octets reçus + transition IMPORT tracée', async () => {
    const { id } = await upload('orig-1');
    const [doc, events, c] = await withScope(admin(), async (tx) => [
      await tx.storedDocument.findFirst({ where: { contractId: id, kind: 'LEGACY_SCAN' } }),
      await tx.lifecycleEvent.findMany({ where: { contractId: id } }),
      await tx.contract.findUnique({ where: { id } }),
    ]);
    expect(doc!.sha256).toBe(createHash('sha256').update(pdf('orig-1')).digest('hex'));
    expect(doc!.origin).toBe('UPLOAD');
    expect(doc!.uploadedByUserId).toBe(fx.amUserId);
    expect(c!.status).toBe('IMPORTED_PENDING_VALIDATION');
    expect(c!.reference).toMatch(/^IMP-\d{4}-\d{4}$/); // référence générée si absente
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: null, toStatus: 'IMPORTED_PENDING_VALIDATION', event: 'IMPORT' });
  });

  test('un « PDF » dont le contenu n’en est pas un est refusé (type réel, pas déclaré)', async () => {
    await http().post('/v1/contracts/import').set('x-lsi-session', 'imp-am').field('customerId', fx.customerA.id)
      .attach('document', Buffer.from('<html>pas un pdf</html>'), { filename: 'x.pdf', contentType: 'application/pdf' })
      .expect(400);
  });

  test('champ de formulaire inconnu refusé (ex. tenantId)', async () => {
    await http().post('/v1/contracts/import').set('x-lsi-session', 'imp-am')
      .field('customerId', fx.customerA.id).field('tenantId', other.tenantId)
      .attach('document', pdf('t'), { filename: 't.pdf', contentType: 'application/pdf' })
      .expect(400);
  });
});

describe('OCR et extraction (worker)', () => {
  test('copies OCR DÉRIVÉES de l’original, extraction proposée, original intact', async () => {
    const { id, importId } = await upload('ocr-ok', { endDate: '2029-12-31' });
    expect(await ocrOf(importId)).toBe('DONE');

    const res = await http().get(`/v1/contracts/${id}/import`).set('x-lsi-session', 'imp-am').expect(200);
    expect(res.body.ocr).toMatchObject({ status: 'DONE', pages: 3 });
    expect(res.body.origin).toBe('LEGACY_IMPORT');
    expect(res.body.signatureMode).toBe('EXTERNAL_WET_SIGNATURE');
    // Extraction par règles sur le texte OCR (fixture 01) …
    expect(res.body.extraction.indiceRevision.value).toBe('SYNTEC');
    expect(res.body.extraction.indiceRevision.method).toBe('RULES');
    expect(typeof res.body.extraction.dateEffet.confidence).toBe('number');
    // … mais une valeur SAISIE au dépôt prime et reste marquée comme telle.
    expect(res.body.extraction.dateFin).toMatchObject({ value: '2029-12-31', method: 'SAISIE', confidence: 1 });
    // Rien n'est écrit sur le contrat avant validation.
    expect(res.body.contract.endDate).toBeNull();

    const docs = await withScope(admin(), (tx) => tx.storedDocument.findMany({ where: { contractId: id } }));
    const original = docs.find((d) => d.kind === 'LEGACY_SCAN')!;
    expect(original.sha256).toBe(createHash('sha256').update(pdf('ocr-ok')).digest('hex'));
    for (const k of ['OCR_PDF', 'OCR_TEXT'] as const) {
      const d = docs.find((x) => x.kind === k)!;
      expect(d.derivedFromId).toBe(original.id);
      expect(d.origin).toBe('OCR');
    }

    const copy = await http().get(`/v1/contracts/${id}/import/ocr.pdf`).set('x-lsi-session', 'imp-am').expect(200);
    expect(copy.headers['content-type']).toContain('application/pdf');
    // Le « document source » reste l'ORIGINAL, pas la copie OCR.
    const src = await http().get(`/v1/contracts/${id}/imported-document`).set('x-lsi-session', 'imp-am')
      .buffer(true).parse((r, cb) => { const b: Buffer[] = []; r.on('data', (x: Buffer) => b.push(x)); r.on('end', () => cb(null, Buffer.concat(b))); })
      .expect(200);
    expect((src.body as Buffer).equals(pdf('ocr-ok'))).toBe(true);
  });

  test('document refusé par l’OCR (415) : échec définitif, sans nouvelle tentative', async () => {
    const { id, importId } = await upload('ocr-415');
    ocr.next = async () => { throw new OcrError('not_a_pdf', 'refusé', false); };
    expect(await ocrOf(importId)).toBe('FAILED');
    ocr.next = null;
    const res = await http().get(`/v1/contracts/${id}/import`).set('x-lsi-session', 'imp-am').expect(200);
    expect(res.body.ocr).toMatchObject({ status: 'FAILED', attempts: 1 });
  });

  test('OCR saturé : réessayé, puis FAILED après 3 tentatives ; relance manuelle possible', async () => {
    const { id, importId } = await upload('ocr-503');
    ocr.next = async () => { throw new OcrError('busy', 'saturé', true); };
    expect(await ocrOf(importId)).toBe('RETRY');
    expect(await ocrOf(importId)).toBe('RETRY');
    expect(await ocrOf(importId)).toBe('FAILED');
    ocr.next = null;
    await http().post(`/v1/contracts/${id}/import/retry-ocr`).set('x-lsi-session', 'imp-am').expect(201);
    expect(await ocrOf(importId)).toBe('DONE');
  });

  test('un OCR déjà traité n’est pas rejoué (idempotence du job)', async () => {
    const { importId } = await upload('ocr-idem');
    await ocrOf(importId);
    const before = ocr.calls;
    expect(await ocrOf(importId)).toBe('SKIPPED');
    expect(ocr.calls).toBe(before);
  });
});

describe('validation humaine', () => {
  const body = { startDate: '2025-01-01', endDate: '2027-12-31', noticePeriodMonths: 3, renewalMode: 'TACIT', renewalPeriodMonths: 12, amountCents: 125000 };

  test('le commercial qui importe ne valide pas (séparation des tâches) → 403', async () => {
    const { id } = await upload('val-403');
    await http().post(`/v1/contracts/${id}/import/validate`).set('x-lsi-session', 'imp-am').send(body).expect(403);
  });

  test('le juriste valide → ACTIVE, période initiale, échéancier et alertes, trace complète', async () => {
    const { id } = await upload('val-ok');
    const res = await http().post(`/v1/contracts/${id}/import/validate`).set('x-lsi-session', 'imp-legal').send(body).expect(201);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.deadlinesCreated).toBeGreaterThanOrEqual(2);

    const [c, periods, deadlines, reminders, imp, events] = await withScope(admin(), async (tx) => [
      await tx.contract.findUnique({ where: { id } }),
      await tx.contractPeriod.findMany({ where: { contractId: id } }),
      await tx.deadline.findMany({ where: { contractId: id, status: 'OPEN' } }),
      await tx.reminder.findMany({ where: { contractId: id } }),
      await tx.contractImport.findUnique({ where: { contractId: id } }),
      await tx.lifecycleEvent.findMany({ where: { contractId: id }, orderBy: { seq: 'asc' } }),
    ]);
    expect(c).toMatchObject({ renewalMode: 'TACIT', noticePeriodMonths: 3, amountCents: 125000n });
    expect(periods).toHaveLength(1);
    expect(deadlines.map((d) => d.kind).sort()).toEqual(['NOTICE_DEADLINE', 'PERIOD_END']);
    expect(reminders.every((r) => r.deadlineId)).toBe(true);
    expect(new Set(reminders.map((r) => r.offsetDays))).toEqual(new Set([90, 60, 30, 7]));
    expect(imp!.validatedByUserId).toBe(fx.adminUserId);
    expect(events.at(-1)).toMatchObject({ fromStatus: 'IMPORTED_PENDING_VALIDATION', toStatus: 'ACTIVE', event: 'VALIDATE_IMPORT' });
  });

  test('l’état d’arrivée se déduit des dates : effet futur → SIGNED, terme passé → EXPIRED', async () => {
    const a = await upload('val-futur');
    await http().post(`/v1/contracts/${a.id}/import/validate`).set('x-lsi-session', 'imp-legal')
      .send({ startDate: '2099-01-01', endDate: '2099-12-31' }).expect(201)
      .then((r) => expect(r.body.status).toBe('SIGNED'));
    const b = await upload('val-passe');
    await http().post(`/v1/contracts/${b.id}/import/validate`).set('x-lsi-session', 'imp-legal')
      .send({ startDate: '2019-01-01', endDate: '2020-12-31' }).expect(201)
      .then((r) => expect(r.body.status).toBe('EXPIRED'));
  });

  test('corps invalide → 400 (préavis jours ET mois ; reconduction sans durée ; terme avant effet ; statut imposé)', async () => {
    const { id } = await upload('val-400');
    const post = (b: object) => http().post(`/v1/contracts/${id}/import/validate`).set('x-lsi-session', 'imp-legal').send(b);
    await post({ startDate: '2025-01-01', noticePeriodDays: 30, noticePeriodMonths: 1 }).expect(400);
    await post({ startDate: '2025-01-01', renewalMode: 'TACIT' }).expect(400);
    await post({ startDate: '2025-01-01', endDate: '2024-01-01' }).expect(400);
    await post({ startDate: '2025-01-01', status: 'ACTIVE' }).expect(400);
  });

  test('double validation → 409', async () => {
    const { id } = await upload('val-409');
    await http().post(`/v1/contracts/${id}/import/validate`).set('x-lsi-session', 'imp-legal').send(body).expect(201);
    await http().post(`/v1/contracts/${id}/import/validate`).set('x-lsi-session', 'imp-legal').send(body).expect(409);
  });
});

describe('dépôt par lot', () => {
  test('un contrat par PDF ; un fichier refusé n’annule pas le lot', async () => {
    const res = await http().post('/v1/contracts/import/batch').set('x-lsi-session', 'imp-am')
      .field('customerId', fx.customerA.id)
      .attach('documents', pdf('lot-1'), { filename: 'contrat_maintenance_2019.pdf', contentType: 'application/pdf' })
      .attach('documents', pdf('lot-2'), { filename: 'contrat-support.pdf', contentType: 'application/pdf' })
      .attach('documents', Buffer.from('texte'), { filename: 'notes.txt', contentType: 'text/plain' })
      .expect(201);
    const items = res.body.items as { filename: string; id?: string; error?: string }[];
    expect(items.filter((i) => i.id)).toHaveLength(2);
    expect(items.find((i) => i.filename === 'notes.txt')!.error).toBeTruthy();
    const c = await withScope(admin(), (tx) => tx.contract.findUnique({ where: { id: items[0]!.id! } }));
    expect(c!.title).toBe('contrat maintenance 2019');
  });

  test('lot pour un client hors portefeuille → 404, rien n’est créé', async () => {
    await http().post('/v1/contracts/import/batch').set('x-lsi-session', 'imp-am')
      .field('customerId', fx.customerB.id)
      .attach('documents', pdf('lot-b'), { filename: 'b.pdf', contentType: 'application/pdf' })
      .expect(404);
  });
});

describe('isolation', () => {
  test('le commercial du client B ne voit pas l’import du client A (404, jamais 403)', async () => {
    const { id } = await upload('iso-1');
    await http().get(`/v1/contracts/${id}/import`).set('x-lsi-session', 'imp-am-b').expect(404);
    await http().get(`/v1/contracts/${id}/import/ocr.pdf`).set('x-lsi-session', 'imp-am-b').expect(404);
  });

  test('un autre tenant ne voit ni l’import ni les échéances', async () => {
    const { id } = await upload('iso-tenant');
    await http().post(`/v1/contracts/${id}/import/validate`).set('x-lsi-session', 'imp-legal')
      .send({ startDate: '2025-01-01', endDate: '2027-12-31' }).expect(201);
    await http().get(`/v1/contracts/${id}/import`).set('x-lsi-session', 'imp-other-admin').expect(404);
    const dl = await http().get('/v1/deadlines?from=2020-01-01&to=2030-12-31').set('x-lsi-session', 'imp-other-admin').expect(200);
    expect(dl.body.items.map((d: { contractId: string }) => d.contractId)).not.toContain(id);
  });

  test('une session client n’accède pas aux imports (API interne)', async () => {
    const { id } = await upload('iso-client');
    await http().get(`/v1/contracts/${id}/import`).set('x-lsi-session', 'imp-client').expect(403);
  });
});

describe('échéancier : recalcul quotidien', () => {
  test('idempotent, et une échéance devenue sans objet passe OBSOLETE avec ses alertes', async () => {
    const { id } = await upload('dl-idem');
    await http().post(`/v1/contracts/${id}/import/validate`).set('x-lsi-session', 'imp-legal')
      .send({ startDate: '2025-01-01', endDate: '2028-06-30', noticePeriodDays: 30 }).expect(201);
    const deadlines = app.get(DeadlinesService);
    const count = () => withScope(admin(), async (tx) => ({
      d: await tx.deadline.count({ where: { contractId: id } }),
      r: await tx.reminder.count({ where: { contractId: id } }),
    }));
    const before = await count();
    await deadlines.runAll(new Date());
    expect(await count()).toEqual(before);

    // Avenant fictif : le terme change → les anciennes échéances deviennent obsolètes.
    await withScope(admin(), (tx) => tx.contract.update({ where: { id }, data: { endDate: new Date('2029-06-30') } }));
    await deadlines.runAll(new Date());
    const rows = await withScope(admin(), (tx) => tx.deadline.findMany({ where: { contractId: id } }));
    expect(rows.filter((r) => r.status === 'OBSOLETE').map((r) => r.kind).sort()).toEqual(['NOTICE_DEADLINE', 'PERIOD_END']);
    expect(rows.filter((r) => r.status === 'OPEN').map((r) => r.dueDate.toISOString().slice(0, 10)).sort())
      .toEqual(['2029-05-31', '2029-06-30']);
    const obsoleteIds = rows.filter((r) => r.status === 'OBSOLETE').map((r) => r.id);
    const pending = await withScope(admin(), (tx) =>
      tx.reminder.count({ where: { deadlineId: { in: obsoleteIds }, status: 'PENDING' } }));
    expect(pending).toBe(0);
  });
});
