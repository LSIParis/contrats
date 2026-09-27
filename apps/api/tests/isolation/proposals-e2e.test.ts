import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { priceAt, type PricingSchedule } from '@lsi/pricing';
import { adminScope, internalScope, uuidv7, withScope } from '@lsi/persistence';
import {
  seedProposalTemplates,
  seedPublishedContractTemplate,
  seedTwoCustomers,
  type TwoCustomerFixture,
} from '@lsi/persistence/testing';
import { createTestApp } from '../support/app.js';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { EMAIL_SENDER } from '../../src/notifications/email.token.js';
import { ESIGNATURE_PROVIDER } from '../../src/signature/provider.token.js';
import { DOCUMENT_RENDERER } from '../../src/documents/renderer.token.js';
import { ProposalJobsService } from '../../src/proposals/proposal-jobs.service.js';
import { FakeEmailSender } from '../support/fake-email.js';
import { FakeProvider, FakeRenderer } from '../support/fakes.js';

/**
 * Lot 9 — test de BOUT EN BOUT sur fixtures (définition de terminé du brief) :
 * création → envoi → consultation → modification d'options → acceptation →
 * signature DocuSeal (webhook signé, fixtures test/fixtures/proposals) →
 * preuves archivées → conversion → contrat pré-rempli avec le bon barème.
 * Et : prix affiché = prix figé = barème initial du contrat, strictement.
 */
let app: INestApplication;
let fx: TwoCustomerFixture;
const email = new FakeEmailSender();
const provider = new FakeProvider();
// Identifiants de soumission propres à ce fichier : la base de test est partagée entre fichiers
// (DocuSeal, lui, garantit l'unicité des identifiants de soumission).
(provider as unknown as { counter: number }).counter = 3_100_000;
const SECRET = 'test-webhook-secret-proposals';

const http = () => request(app.getHttpServer());
const AM = 'p-e2e-am';
const ADMIN = 'p-e2e-admin';

const FIXTURES = fileURLToPath(new URL('../../../../test/fixtures/proposals/', import.meta.url));
function fixture(name: string, vars: Record<string, string | number>): string {
  let text = readFileSync(`${FIXTURES}${name}`, 'utf8');
  for (const [k, v] of Object.entries(vars)) {
    text = text.split(`"__${k}__"`).join(JSON.stringify(v));
    text = text.split(`__${k}__`).join(String(v));
  }
  return text;
}
function signedWebhook(body: string) {
  const ts = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
  return http().post('/v1/webhooks/docuseal').set('Content-Type', 'application/json').set('X-Docuseal-Signature', `${ts}.${digest}`).send(body);
}
const lastToken = () => {
  const m = /\/p\/([A-Za-z0-9_-]{43})/.exec(email.sent.at(-1)?.text ?? '');
  return m ? m[1]! : '';
};

beforeAll(async () => {
  process.env.DOCUSEAL_WEBHOOK_SECRET = SECRET;
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EMAIL_SENDER).useValue(email)
    .overrideProvider(ESIGNATURE_PROVIDER).useValue(provider)
    .overrideProvider(DOCUMENT_RENDERER).useValue(new FakeRenderer())
    .compile();
  app = await createTestApp(mod);
  fx = await seedTwoCustomers();
  await seedProposalTemplates(fx.tenantSlug);
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    for (const key of ['contrats.proposals.enabled', 'contrats.docuseal.enabled']) {
      await tx.tenantFeatureFlag.create({ data: { tenantId: fx.tenantId, key, enabled: true, updatedAt: now } });
    }
    // Un abonné aux événements sortants des propositions (outbox : un événement n'est écrit que s'il est livrable).
    await tx.webhookSubscription.create({
      data: {
        id: uuidv7(), tenantId: fx.tenantId, url: 'https://hooks.example.com/contrats', secretCiphertext: 'iv.tag.ct', secretHint: 'abcd',
        eventTypes: ['proposal.sent', 'proposal.viewed', 'proposal.accepted', 'proposal.signed', 'proposal.declined', 'proposal.expired', 'proposal.converted'],
        active: true, createdAt: now, updatedAt: now,
      },
    });
  });
  const s = app.get(SessionService);
  await s.put({ sessionId: AM, userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: ADMIN, userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) });

  // CGV publiées (jointes à chaque version) ; niveaux de service validés (écran « Prix à valider »).
  await http().post('/v1/proposal-admin/terms').set('x-lsi-session', ADMIN)
    .send({ title: 'Conditions générales de vente 2026', body: 'Article 1 — Objet. Les présentes conditions régissent les prestations de LSI-Maintenance.' })
    .expect(201);
  const pending = await http().get('/v1/proposal-admin/pending-validations').set('x-lsi-session', ADMIN).expect(200);
  expect(pending.body.items.filter((i: any) => i.templateSlug === 'infogerance')).toEqual([
    expect.objectContaining({ scope: 'SECTION', key: 'niveaux-de-service' }),
  ]);
  await http().post('/v1/proposal-admin/pending-validations/validate').set('x-lsi-session', ADMIN)
    .send({ templateSlug: 'infogerance', scope: 'SECTION', key: 'niveaux-de-service' }).expect(200);
});

describe('proposition Infogérance : de la création au contrat', () => {
  let id: string;
  let token: string;

  test('création depuis le modèle : numéro, montants du moteur, préparation incomplète', async () => {
    const r = await http().post('/v1/proposals').set('x-lsi-session', AM).send({
      customerId: fx.customerA.id,
      templateSlug: 'infogerance',
      mergeContext: { 'parc.nbPostes': 50, 'parc.nbServeurs': 2, 'parc.nbEquipementsReseau': 5 },
    }).expect(201);
    id = r.body.proposal.id;
    expect(r.body.proposal.number).toMatch(/^PROP-\d{4}-\d{4}$/);
    expect(r.body.proposal.status).toBe('DRAFT');
    // 50 × 25 + 2 × 95 + 5 × 15 (brief §12.11)
    expect(r.body.quote.totals.monthly.htCents).toBe(151500);
    expect(r.body.quote.totals.oneTime.htCents).toBe(230000);
    expect(r.body.readiness.issues.map((i: any) => i.code)).toEqual(expect.arrayContaining(['TO_COMPLETE']));
    // Sans destinataire ni contexte rédigé : pas « prête ».
    await http().post(`/v1/proposals/${id}/mark-ready`).set('x-lsi-session', AM).expect(409);
  });

  test('rédaction : contexte complété, signataire ajouté', async () => {
    const d = await http().get(`/v1/proposals/${id}`).set('x-lsi-session', AM).expect(200);
    const sections = d.body.version.sections.map((s: any) => ({
      key: s.key, title: s.title, kind: s.kind, optional: s.optional, excluded: s.excluded,
      libraryItemKey: s.libraryItemKey, guidance: s.guidance,
      blocks: s.key === 'votre-contexte'
        ? [{ type: 'RICH_TEXT', content: { markdown: 'Parc de 50 postes et 2 serveurs ; support aujourd’hui assuré en interne.' } }]
        : s.blocks,
    }));
    await http().put(`/v1/proposals/${id}/sections`).set('x-lsi-session', AM).send({ sections }).expect(200);
    await http().post(`/v1/proposals/${id}/recipients`).set('x-lsi-session', AM)
      .send({ fullName: 'Jeanne Dupont', email: 'jeanne.dupont@dupont.example.fr', jobTitle: 'Gérante', role: 'SIGNER' }).expect(201);
    const r = await http().get(`/v1/proposals/${id}/readiness`).set('x-lsi-session', AM).expect(200);
    expect(r.body.issues).toEqual([]);
  });

  test('revue interne obligatoire (montant) : le commercial ne se valide pas lui-même', async () => {
    const ready = await http().post(`/v1/proposals/${id}/mark-ready`).set('x-lsi-session', AM).expect(409);
    expect(ready.body.rule).toBe('P-REVIEW-REQUIRED');
    await http().post(`/v1/proposals/${id}/submit-review`).set('x-lsi-session', AM).expect(200);
    await http().post(`/v1/proposals/${id}/approve-review`).set('x-lsi-session', AM).expect(403);
    const ok = await http().post(`/v1/proposals/${id}/approve-review`).set('x-lsi-session', ADMIN).expect(200);
    expect(ok.body.proposal.status).toBe('READY');
  });

  test('envoi : version figée, lien personnel par e-mail au nom du commercial, relances planifiées', async () => {
    email.reset();
    const r = await http().post(`/v1/proposals/${id}/send`).set('x-lsi-session', AM).expect(200);
    expect(r.body.proposal.status).toBe('SENT');
    expect(r.body.version.lockedAt).toBeTruthy();
    expect(r.body.version.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.version.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    token = lastToken();
    expect(token).toHaveLength(43);
    expect(email.sent.at(-1)!.to).toBe('jeanne.dupont@dupont.example.fr');
    expect(email.sent.at(-1)!.fromName).toMatch(/LSI Maintenance/);
    expect(email.sent.at(-1)!.text).not.toMatch(/\{\{/);
    const t = await http().get(`/v1/proposals/${id}/tracking`).set('x-lsi-session', AM).expect(200);
    expect(t.body.followUps.map((f: any) => f.kind)).toEqual(['NO_OPEN', 'NO_DECISION', 'BEFORE_EXPIRY']);
    expect(t.body.deliveries[0]).toMatchObject({ kind: 'INITIAL', error: null });
    // Figée : plus aucune modification directe.
    await http().patch(`/v1/proposals/${id}`).set('x-lsi-session', AM).send({ title: 'Autre' }).expect(409);
  });

  test('page publique : contenu fusionné, noindex, suivi de lecture → CONSULTÉE et notification', async () => {
    const v = await http().get(`/v1/public/proposals/${token}`).expect(200);
    expect(v.headers['x-robots-tag']).toMatch(/noindex/);
    expect(v.headers['cache-control']).toBe('no-store');
    expect(v.body.proposal.status).toBe('SENT');
    expect(JSON.stringify(v.body.content.sections)).not.toMatch(/\{\{/);
    expect(v.body.content.sections.map((s: any) => s.key)).toContain('niveaux-de-service');
    expect(v.body.content.pricing.quote.totals.monthly.htCents).toBe(151500);
    expect(JSON.stringify(v.body)).not.toMatch(/priceSource|Offre monitoring/);
    await http().post(`/v1/public/proposals/${token}/events`)
      .send({ viewerId: 'navigateur-1', events: [{ type: 'OPENED' }, { type: 'SECTION_VIEWED', sectionKey: 'investissement', durationMs: 42_000 }] })
      .expect(202);
    const d = await http().get(`/v1/proposals/${id}`).set('x-lsi-session', AM).expect(200);
    expect(d.body.proposal.status).toBe('VIEWED');
    expect(d.body.stats.find((s: any) => s.sectionKey === 'investissement')).toMatchObject({ totalDurationMs: 42000 });
    const notes = await http().get('/v1/notifications').set('x-lsi-session', AM).expect(200);
    expect(notes.body.items.map((n: any) => n.type)).toContain('proposal.first_open');
    // Lien transféré : un second navigateur est signalé.
    await http().post(`/v1/public/proposals/${token}/events`).send({ viewerId: 'navigateur-2', events: [{ type: 'OPENED' }] }).expect(202);
    const t = await http().get(`/v1/proposals/${id}/tracking`).set('x-lsi-session', AM).expect(200);
    expect(t.body.events.map((e: any) => e.kind)).toContain('NEW_VIEWER');
    expect(t.body.events.every((e: any) => e.ipTruncated === null || /\.0$|::$/.test(e.ipTruncated))).toBe(true);
  });

  test('configuration par le client : recalculée par le moteur, bornes contrôlées côté serveur', async () => {
    const r = await http().put(`/v1/public/proposals/${token}/selection`).send({ choices: { engagement: '36' } }).expect(200);
    expect(r.body.quote.totals.monthly.htCents).toBe(136250);
    expect(r.body.quote.totals.commitment.htCents).toBe(4905000);
    await http().put(`/v1/public/proposals/${token}/selection`).send({ quantities: { 'mes-poste': 1 } }).expect(400);
    await http().put(`/v1/public/proposals/${token}/selection`).send({ selectedOptions: ['poste-travail'] }).expect(400);
    const over = await http().put(`/v1/public/proposals/${token}/selection`).send({ quantities: { 'poste-travail': 900 } }).expect(200);
    expect(over.body.quote.errors.join()).toMatch(/maximum/);
    await http().put(`/v1/public/proposals/${token}/selection`).send({ quantities: { 'poste-travail': 50 } }).expect(200);
    await http().post(`/v1/public/proposals/${token}/comments`).send({ body: 'Le support couvre-t-il les imprimantes ?', sectionKey: 'perimetre' }).expect(201);
    const d = await http().get(`/v1/proposals/${id}`).set('x-lsi-session', AM).expect(200);
    expect(d.body.proposal.status).toBe('IN_DISCUSSION');
    await http().post(`/v1/proposals/${id}/comments`).set('x-lsi-session', AM).send({ body: 'Oui, les imprimantes réseau sont incluses.' }).expect(201);
  });

  let displayed: any;
  test('acceptation : configuration figée (PricingSnapshot), PDF haché AVANT DocuSeal, EN_SIGNATURE', async () => {
    displayed = (await http().get(`/v1/public/proposals/${token}`).expect(200)).body.content.pricing.quote;
    await http().post(`/v1/public/proposals/${token}/accept`).send({ fullName: 'Jeanne Dupont', jobTitle: 'Gérante', email: 'jeanne.dupont@dupont.example.fr' }).expect(400);
    const r = await http().post(`/v1/public/proposals/${token}/accept`)
      .send({ fullName: 'Jeanne Dupont', jobTitle: 'Gérante', email: 'jeanne.dupont@dupont.example.fr', consent: true }).expect(200);
    expect(r.body.status, JSON.stringify(r.body)).toBe('PENDING_SIGNATURE');
    const call = provider.calls.at(-1)!;
    expect(call.delivery).toBe('EMBEDDED');
    expect(call.submitters.map((s) => s.party)).toEqual(['CLIENT', 'LSI']);
    const sr = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.proposalSignatureRequest.findFirstOrThrow({ where: { proposalId: id } }));
    expect(sr.sentPdfSha256).toBe(call.pdfSha256);
    // Une seconde acceptation (double clic) ne crée pas de seconde soumission.
    await http().post(`/v1/public/proposals/${token}/accept`)
      .send({ fullName: 'Jeanne Dupont', jobTitle: 'Gérante', email: 'jeanne.dupont@dupont.example.fr', consent: true }).expect(409);
    expect(provider.calls.filter((c) => c.metadata.proposal_id === id)).toHaveLength(1);
  });

  let contractId: string;
  test('signature (webhook signé) → preuves archivées → SIGNÉE ; contrat type manquant = conversion refusée explicitement', async () => {
    const sr = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.proposalSignatureRequest.findFirstOrThrow({ where: { proposalId: id }, include: { signers: true } }),
    );
    const client = sr.signers.find((s) => s.party === 'CLIENT')!;
    const lsi = sr.signers.find((s) => s.party === 'LSI')!;
    const vars = {
      SUBMISSION_ID: Number(sr.providerSubmissionId), CLIENT_SIGNER_ID: client.id, LSI_SIGNER_ID: lsi.id,
      TENANT_ID: fx.tenantId, CUSTOMER_ID: fx.customerA.id, PROPOSAL_ID: id, SIGNATURE_REQUEST_ID: sr.id,
    };
    const body = fixture('webhook.submission-completed.json', vars);
    const w = await signedWebhook(body).expect(200);
    expect(w.body.status).toBe('processed');
    expect((await signedWebhook(body).expect(200)).body.status).toBe('duplicate_ignored');
    // Le job (balayage) rapatrie les preuves puis passe SIGNÉE, puis tente la conversion.
    await app.get(ProposalJobsService).sweep(new Date());
    const d = await http().get(`/v1/proposals/${id}`).set('x-lsi-session', AM).expect(200);
    expect(d.body.proposal.status).toBe('SIGNED');
    expect(d.body.signature.signedPdfSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.body.proposal.conversionError).toMatch(/infogerance/);
    const cust = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.customer.findUniqueOrThrow({ where: { id: fx.customerA.id } }));
    expect(cust.commercialStatus).toBe('CLIENT');
  });

  test('conversion : contrat BROUILLON origin=PROPOSAL, lié, barème initial = PricingSnapshot = prix affiché', async () => {
    await seedPublishedContractTemplate(fx.tenantId, 'infogerance');
    await app.get(ProposalJobsService).sweep(new Date());
    const d = await http().get(`/v1/proposals/${id}`).set('x-lsi-session', AM).expect(200);
    expect(d.body.proposal.status).toBe('CONVERTED');
    contractId = d.body.proposal.contractId;
    const { c, schedule, snapshot } = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
      const c = await tx.contract.findUniqueOrThrow({ where: { id: contractId }, include: { signers: true } });
      const schedule = await tx.pricingSchedule.findFirstOrThrow({ where: { contractId }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
      const p = await tx.proposal.findUniqueOrThrow({ where: { id } });
      const snapshot = await tx.pricingSnapshot.findUniqueOrThrow({ where: { id: p.acceptedSnapshotId! } });
      return { c, schedule, snapshot };
    });
    expect(c).toMatchObject({ origin: 'PROPOSAL', proposalId: id, status: 'DRAFT', customerId: fx.customerA.id, signedViaProposal: false });
    expect(c.signers.map((s) => s.email)).toEqual(['jeanne.dupont@dupont.example.fr']);
    expect(schedule.commitmentMonths).toBe(36);

    // Prix figé = prix affiché au moment de l'acceptation.
    expect(Number(snapshot.monthlyCents)).toBe(displayed.totals.monthly.htCents);
    expect(Number(snapshot.oneTimeCents)).toBe(displayed.totals.oneTime.htCents);
    expect(Number(snapshot.commitmentTotalCents)).toBe(displayed.totals.commitment.htCents);
    // Barème initial du contrat = barème figé, recalculé par le moteur : totaux IDENTIQUES.
    const frozen = snapshot.engineSchedule as unknown as PricingSchedule;
    const contractSchedule: PricingSchedule = {
      id: schedule.id, validFrom: frozen.validFrom, validTo: null, currency: 'EUR',
      lines: schedule.lines.map((l: any) => ({
        id: l.lineKey, code: l.articleCode, label: l.label, unit: l.unit, kind: l.kind, mode: l.mode,
        vatRatePercent: l.vatRatePercent.toFixed(),
        ...(l.recurrence ? { recurrence: l.recurrence } : {}),
        ...(l.unitPrice != null ? { unitPrice: l.unitPrice.toFixed() } : {}),
        ...(l.kind !== 'DISCOUNT' ? { quantity: { source: 'FIXED' as const, value: l.quantity.toFixed() } } : {}),
        ...(l.params?.discount ? { discount: l.params.discount } : {}),
      })),
    };
    const a = priceAt({ schedules: [frozen] }, frozen.validFrom).totals;
    const b = priceAt({ schedules: [contractSchedule] }, frozen.validFrom).totals;
    expect(b).toEqual(a);
    expect(Number(a.monthlyLinesCents)).toBe(displayed.totals.monthly.htCents);
    expect(schedule.lines.map((l: any) => l.lineKey)).toEqual(frozen.lines.map((l) => l.id));
  });

  test('idempotence : conversion rejouée → même contrat ; webhook rejoué → sans effet', async () => {
    const again = await http().post(`/v1/proposals/${id}/convert`).set('x-lsi-session', AM).expect(200);
    expect(again.body).toEqual({ contractId, created: false });
    const n = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.count({ where: { proposalId: id } }));
    expect(n).toBe(1);
  });

  test('traçabilité : journal des transitions complet, audit chaîné, événements sortants proposal.*', async () => {
    const t = await http().get(`/v1/proposals/${id}/tracking`).set('x-lsi-session', AM).expect(200);
    expect(t.body.lifecycle.map((e: any) => e.toStatus)).toEqual([
      'DRAFT', 'IN_INTERNAL_REVIEW', 'READY', 'SENT', 'VIEWED', 'IN_DISCUSSION', 'ACCEPTED', 'PENDING_SIGNATURE', 'SIGNED', 'CONVERTED',
    ]);
    const events = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.webhookEvent.findMany({ where: { resourceId: id }, orderBy: { occurredAt: 'asc' } }),
    );
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['proposal.sent', 'proposal.viewed', 'proposal.accepted', 'proposal.signed', 'proposal.converted']),
    );
    expect(JSON.stringify(events.map((e) => e.payload))).not.toMatch(/Jeanne|dupont\.example|151500/);
  });
});

describe('acceptation par clic (petite proposition) : e-mail vérifié par code', () => {
  test('proposition vierge → prix validé par l’admin → envoi → code → acceptation → SIGNÉE → contrat', async () => {
    const created = await http().post('/v1/proposals').set('x-lsi-session', AM)
      .send({ customerId: fx.customerA.id, title: 'Petite intervention', acceptanceMode: 'CLICK_ACCEPT' }).expect(201);
    const id = created.body.proposal.id;
    const def = created.body.version.pricingDefinition;
    def.lines[0].pricing = { unitPriceCents: 9_900 };
    def.lines[0].priceStatus = 'VALIDATED'; // tentative d'auto-validation : ignorée
    const put = await http().put(`/v1/proposals/${id}/pricing`).set('x-lsi-session', AM).send(def).expect(200);
    expect(put.body.version.pricingDefinition.lines[0].priceStatus).toBe('TO_VALIDATE');
    await http().post(`/v1/proposals/${id}/pricing/validate`).set('x-lsi-session', AM).send({ scope: 'LINE', key: 'prestation' }).expect(403);
    await http().post(`/v1/proposals/${id}/pricing/validate`).set('x-lsi-session', ADMIN).send({ scope: 'LINE', key: 'prestation' }).expect(200);
    const d = await http().get(`/v1/proposals/${id}`).set('x-lsi-session', AM).expect(200);
    const sections = d.body.version.sections.map((s: any) => ({
      key: s.key, title: s.title, kind: s.kind, blocks: s.key === 'contexte' ? [{ type: 'RICH_TEXT', content: { markdown: 'Intervention ponctuelle.' } }] : s.blocks,
    }));
    await http().put(`/v1/proposals/${id}/sections`).set('x-lsi-session', AM).send({ sections }).expect(200);
    await http().post(`/v1/proposals/${id}/recipients`).set('x-lsi-session', AM)
      .send({ fullName: 'Paul Martin', email: 'paul.martin@dupont.example.fr', role: 'DECISION_MAKER' }).expect(201);
    await http().post(`/v1/proposals/${id}/mark-ready`).set('x-lsi-session', AM).expect(200);
    email.reset();
    await http().post(`/v1/proposals/${id}/send`).set('x-lsi-session', AM).expect(200);
    const token = lastToken();

    const accept = { fullName: 'Paul Martin', jobTitle: 'Directeur', email: 'paul.martin@dupont.example.fr', consent: true };
    const refused = await http().post(`/v1/public/proposals/${token}/accept`).send(accept).expect(403);
    expect(refused.body.code).toBe('OTP_REQUIRED');
    await http().post(`/v1/public/proposals/${token}/otp`).expect(200);
    const code = /code à usage unique : (\d{6})/.exec(email.sent.at(-1)!.text)![1]!;
    await http().post(`/v1/public/proposals/${token}/otp/verify`).send({ code: code === '000000' ? '000001' : '000000' }).expect(403);
    const v = await http().post(`/v1/public/proposals/${token}/otp/verify`).send({ code }).expect(200);
    const ok = await http().post(`/v1/public/proposals/${token}/accept`).set('x-proposal-otp', v.body.otpSession).send(accept).expect(200);
    expect(ok.body.status).toBe('SIGNED');
    const proof = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.proposalAcceptance.findFirstOrThrow({ where: { proposalId: id } }));
    expect(proof).toMatchObject({ mode: 'CLICK_ACCEPT', acceptedByName: 'Paul Martin', acceptedByFunction: 'Directeur' });
    expect(proof.emailVerifiedAt).not.toBeNull();
    await app.get(ProposalJobsService).sweep(new Date());
    const after = await http().get(`/v1/proposals/${id}`).set('x-lsi-session', AM).expect(200);
    expect(after.body.proposal.status).toBe('CONVERTED');
  });
});
