import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { adminScope, clientScope, internalScope, withScope } from '@lsi/persistence';
import { seedProposalTemplates, seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
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
 * Lot 9 — isolation et règles de la proposition, par l'API :
 *   - un autre client (portefeuille) → 404, un lecteur ne rédige pas, un
 *     compte client du portail n'a pas accès, module désactivé = inexistant ;
 *   - un JETON ne donne accès à AUCUNE donnée d'une autre proposition (ni
 *     d'un autre client, ni d'un autre tenant) ; forme stricte, révocation ;
 *   - une version REMPLACÉE ou EXPIRÉE ne peut plus être acceptée ni signée ;
 *   - un élément TO_VALIDATE interdit le passage à PRÊTE ;
 *   - refus motivé, relances, suivi, `contrats.proposals.required`, et la
 *     protection `userModifiedAt` des modèles face au seed.
 */
let app: INestApplication;
let fx: TwoCustomerFixture;
let fx2: TwoCustomerFixture;
const email = new FakeEmailSender();
const provider = new FakeProvider();
// Identifiants de soumission propres à ce fichier : la base de test est partagée entre fichiers
// (DocuSeal, lui, garantit l'unicité des identifiants de soumission).
(provider as unknown as { counter: number }).counter = 3_200_000;
const SECRET = 'test-webhook-secret-proposals-iso';
const http = () => request(app.getHttpServer());

const AM_A = 'p-iso-am-a';
const AM_B = 'p-iso-am-b';
const ADMIN = 'p-iso-admin';
const READER = 'p-iso-reader';
const CLIENT = 'p-iso-client';
const OTHER_TENANT = 'p-iso-other';

const lastToken = () => /\/p\/([A-Za-z0-9_-]{43})/.exec(email.sent.at(-1)?.text ?? '')?.[1] ?? '';

beforeAll(async () => {
  process.env.DOCUSEAL_WEBHOOK_SECRET = SECRET;
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EMAIL_SENDER).useValue(email)
    .overrideProvider(ESIGNATURE_PROVIDER).useValue(provider)
    .overrideProvider(DOCUMENT_RENDERER).useValue(new FakeRenderer())
    .compile();
  app = await createTestApp(mod);
  fx = await seedTwoCustomers();
  fx2 = await seedTwoCustomers();
  await seedProposalTemplates(fx.tenantSlug);
  await seedProposalTemplates(fx2.tenantSlug);
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    for (const key of ['contrats.proposals.enabled', 'contrats.docuseal.enabled']) {
      await tx.tenantFeatureFlag.create({ data: { tenantId: fx.tenantId, key, enabled: true, updatedAt: now } });
    }
  });
  const s = app.get(SessionService);
  await s.put({ sessionId: AM_A, userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: AM_B, userId: fx.amBUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) });
  await s.put({ sessionId: ADMIN, userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) });
  await s.put({ sessionId: READER, userId: fx.amUserId, tenantId: fx.tenantId, roles: ['READER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: CLIENT, userId: fx.customerA.clientUserId, tenantId: fx.tenantId, roles: ['CLIENT_SIGNER'], scope: clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId) });
  await s.put({ sessionId: OTHER_TENANT, userId: fx2.adminUserId, tenantId: fx2.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx2.tenantId, fx2.adminUserId) });

  await http().post('/v1/proposal-admin/terms').set('x-lsi-session', ADMIN).send({ title: 'CGV 2026', body: 'Article 1 — Objet des présentes conditions générales.' }).expect(201);
  await http().post('/v1/proposal-admin/pending-validations/validate').set('x-lsi-session', ADMIN)
    .send({ templateSlug: 'infogerance', scope: 'SECTION', key: 'niveaux-de-service' }).expect(200);
});

/** Proposition Infogérance « petit parc » (sous le seuil de revue) prête et envoyée. */
async function sentProposal(session: string, customerId: string, recipientEmail: string, opts: { sensitive?: boolean } = {}) {
  const c = await http().post('/v1/proposals').set('x-lsi-session', session)
    .send({ customerId, templateSlug: 'infogerance', mergeContext: { 'parc.nbPostes': 5, 'parc.nbServeurs': 0, 'parc.nbEquipementsReseau': 0 } }).expect(201);
  const id: string = c.body.proposal.id;
  const sections = c.body.version.sections.map((s: any) => ({
    key: s.key, title: s.title, kind: s.kind, optional: s.optional, excluded: s.excluded, libraryItemKey: s.libraryItemKey, guidance: s.guidance,
    blocks: s.kind === 'CLIENT_INPUT' ? [{ type: 'RICH_TEXT', content: { markdown: 'Contexte rédigé.' } }] : s.blocks,
  }));
  await http().put(`/v1/proposals/${id}/sections`).set('x-lsi-session', session).send({ sections }).expect(200);
  await http().post(`/v1/proposals/${id}/recipients`).set('x-lsi-session', session).send({ fullName: 'Client Signataire', email: recipientEmail, role: 'SIGNER' }).expect(201);
  if (opts.sensitive) await http().patch(`/v1/proposals/${id}`).set('x-lsi-session', session).send({ sensitive: true }).expect(200);
  await http().post(`/v1/proposals/${id}/mark-ready`).set('x-lsi-session', session).expect(200);
  email.reset();
  await http().post(`/v1/proposals/${id}/send`).set('x-lsi-session', session).expect(200);
  return { id, token: lastToken() };
}

describe('cloisonnement de l’API interne', () => {
  let pA: { id: string; token: string };
  beforeAll(async () => {
    pA = await sentProposal(AM_A, fx.customerA.id, 'a.signataire@a.example.fr');
  });

  test('un commercial d’un autre portefeuille ne voit ni ne modifie : 404', async () => {
    for (const [method, path] of [
      ['get', `/v1/proposals/${pA.id}`], ['get', `/v1/proposals/${pA.id}/tracking`], ['get', `/v1/proposals/${pA.id}/comments`],
      ['get', `/v1/proposals/${pA.id}/pdf`], ['post', `/v1/proposals/${pA.id}/resend`], ['post', `/v1/proposals/${pA.id}/withdraw`],
    ] as const) {
      const req = http()[method](path).set('x-lsi-session', AM_B);
      const res = method === 'post' ? await req.send(path.endsWith('withdraw') ? { reason: 'Test isolation' } : {}) : await req;
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const list = await http().get('/v1/proposals').set('x-lsi-session', AM_B).expect(200);
    expect(list.body.items.map((p: any) => p.id)).not.toContain(pA.id);
    // Créer chez un client hors portefeuille : 404 (pas 403, pas d'oracle).
    await http().post('/v1/proposals').set('x-lsi-session', AM_B).send({ customerId: fx.customerA.id, templateSlug: 'infogerance' }).expect(404);
  });

  test('un autre tenant ne voit rien, et son module désactivé le rend inexistant', async () => {
    const r = await http().get(`/v1/proposals/${pA.id}`).set('x-lsi-session', OTHER_TENANT).expect(404);
    expect(r.body.code).toBe('PROPOSALS_DISABLED');
    await withScope(adminScope(fx2.tenantId, fx2.adminUserId), (tx) =>
      tx.tenantFeatureFlag.create({ data: { tenantId: fx2.tenantId, key: 'contrats.proposals.enabled', enabled: true, updatedAt: new Date() } }),
    );
    await http().get(`/v1/proposals/${pA.id}`).set('x-lsi-session', OTHER_TENANT).expect(404);
    const list = await http().get('/v1/proposals').set('x-lsi-session', OTHER_TENANT).expect(200);
    expect(list.body.items).toEqual([]);
  });

  test('lecteur : consulte mais ne rédige pas ; compte client du portail : aucun accès', async () => {
    await http().get(`/v1/proposals/${pA.id}`).set('x-lsi-session', READER).expect(200);
    await http().post('/v1/proposals').set('x-lsi-session', READER).send({ customerId: fx.customerA.id }).expect(403);
    await http().post(`/v1/proposals/${pA.id}/resend`).set('x-lsi-session', READER).send({}).expect(403);
    await http().get('/v1/proposals').set('x-lsi-session', CLIENT).expect(403);
    await http().get(`/v1/proposals/${pA.id}`).set('x-lsi-session', CLIENT).expect(403);
  });
});

describe('jeton public : aucune donnée d’une autre proposition, d’un autre client ou d’un autre tenant', () => {
  test('chaque jeton n’ouvre que sa proposition ; les écritures restent sur elle', async () => {
    const p1 = await sentProposal(AM_A, fx.customerA.id, 'p1@a.example.fr');
    const p2 = await sentProposal(AM_B, fx.customerB.id, 'p2@b.example.fr');
    const v1 = await http().get(`/v1/public/proposals/${p1.token}`).expect(200);
    const n1 = v1.body.proposal.number;
    const v2 = await http().get(`/v1/public/proposals/${p2.token}`).expect(200);
    expect(v2.body.proposal.number).not.toBe(n1);
    const dump = JSON.stringify(v1.body);
    expect(dump).not.toContain(v2.body.proposal.number);
    expect(dump).not.toContain(fx.customerB.name);
    expect(dump).not.toContain('p2@b.example.fr');
    expect(dump).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/); // aucun identifiant interne exposé
    await http().post(`/v1/public/proposals/${p1.token}/comments`).send({ body: 'Question sur p1' }).expect(201);
    const c2 = await http().get(`/v1/proposals/${p2.id}/comments`).set('x-lsi-session', AM_B).expect(200);
    expect(c2.body.items).toEqual([]);
    const c1 = await http().get(`/v1/proposals/${p1.id}/comments`).set('x-lsi-session', AM_A).expect(200);
    expect(c1.body.items.map((c: any) => c.body)).toEqual(['Question sur p1']);
  });

  test('forme stricte, jeton inconnu, jeton révoqué au renvoi, lien d’un tenant sans module', async () => {
    await http().get('/v1/public/proposals/pas-un-jeton').expect(404);
    await http().get(`/v1/public/proposals/${'A'.repeat(43)}`).expect(404);
    const p = await sentProposal(AM_A, fx.customerA.id, 'resend@a.example.fr');
    email.reset();
    await http().post(`/v1/proposals/${p.id}/resend`).set('x-lsi-session', AM_A).send({}).expect(200);
    const fresh = lastToken();
    const gone = await http().get(`/v1/public/proposals/${p.token}`).expect(410);
    expect(gone.body.code).toBe('LINK_REVOKED');
    await http().get(`/v1/public/proposals/${fresh}`).expect(200);
    const t = await http().get(`/v1/proposals/${p.id}/tracking`).set('x-lsi-session', AM_A).expect(200);
    expect(t.body.deliveries.map((d: any) => d.kind)).toEqual(expect.arrayContaining(['INITIAL', 'RESEND']));
  });

  test('proposition sensible : sans code vérifié, aucun contenu', async () => {
    const p = await sentProposal(AM_A, fx.customerA.id, 'sensible@a.example.fr', { sensitive: true });
    const v = await http().get(`/v1/public/proposals/${p.token}`).expect(200);
    expect(v.body.otp).toEqual({ required: true, verified: false });
    expect(v.body.content).toBeNull();
    await http().put(`/v1/public/proposals/${p.token}/selection`).send({ choices: { engagement: '36' } }).expect(403);
  });
});

describe('versions remplacées, expiration, prix à valider', () => {
  test('une version REMPLACÉE ne peut plus être ni consultée ni acceptée', async () => {
    const p = await sentProposal(AM_A, fx.customerA.id, 'revise@a.example.fr');
    email.reset();
    const r = await http().post(`/v1/proposals/${p.id}/revise`).set('x-lsi-session', AM_A).send({ reason: 'Ajout de l’option Microsoft 365' }).expect(200);
    expect(r.body.proposal.status).toBe('DRAFT');
    expect(r.body.version.number).toBe(2);
    expect(r.body.versions[0].supersededAt).toBeTruthy();
    expect(email.sent.at(-1)!.subject).toMatch(/nouvelle version/);
    const accept = { fullName: 'X Y', jobTitle: 'Gérant', email: 'revise@a.example.fr', consent: true };
    expect((await http().post(`/v1/public/proposals/${p.token}/accept`).send(accept).expect(410)).body.code).toBe('LINK_REVOKED');
    // La v2 repart : prête, envoyée — l'ancien lien reste mort, le nouveau fonctionne.
    await http().post(`/v1/proposals/${p.id}/mark-ready`).set('x-lsi-session', AM_A).expect(200);
    email.reset();
    await http().post(`/v1/proposals/${p.id}/send`).set('x-lsi-session', AM_A).expect(200);
    const v2 = await http().get(`/v1/public/proposals/${lastToken()}`).expect(200);
    expect(v2.body.proposal.versionNumber).toBe(2);
    await http().get(`/v1/public/proposals/${p.token}`).expect(410);
  });

  test('une proposition EXPIRÉE ne peut plus être acceptée ; réactivation motivée', async () => {
    const p = await sentProposal(AM_A, fx.customerA.id, 'expire@a.example.fr');
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.proposal.update({ where: { id: p.id }, data: { expiresAt: new Date(Date.now() - 60_000) } }),
    );
    const accept = { fullName: 'X Y', jobTitle: 'Gérant', email: 'expire@a.example.fr', consent: true };
    await http().post(`/v1/public/proposals/${p.token}/events`).send({ events: [{ type: 'OPENED' }] }).expect(202);
    const refused = await http().post(`/v1/public/proposals/${p.token}/accept`).send(accept).expect(409);
    expect(refused.body.rule).toBe('P-EXPIRED');
    await app.get(ProposalJobsService).sweep(new Date());
    const v = await http().get(`/v1/public/proposals/${p.token}`).expect(200);
    expect(v.body).toMatchObject({ expired: true, proposal: { status: 'EXPIRED' } });
    expect(v.body.actions.canAccept).toBe(false);
    await http().post(`/v1/public/proposals/${p.token}/accept`).send(accept).expect(409);
    await http().post(`/v1/proposals/${p.id}/reactivate`).set('x-lsi-session', AM_A).send({ reason: '', expiresOn: '2099-12-31' }).expect(400);
    const re = await http().post(`/v1/proposals/${p.id}/reactivate`).set('x-lsi-session', AM_A).send({ reason: 'Le client a demandé un délai', expiresOn: '2099-12-31' }).expect(200);
    expect(re.body.proposal.status).toBe('READY');
  });

  test('un élément TO_VALIDATE interdit le passage à PRÊTE (modèle Supervision)', async () => {
    const c = await http().post('/v1/proposals').set('x-lsi-session', AM_A)
      .send({ customerId: fx.customerA.id, templateSlug: 'supervision', mergeContext: { 'parc.nbServeurs': 2, 'parc.nbEquipementsReseau': 3 } }).expect(201);
    const id = c.body.proposal.id;
    const sections = c.body.version.sections.map((s: any) => ({
      key: s.key, title: s.title, kind: s.kind, optional: s.optional, libraryItemKey: s.libraryItemKey, guidance: s.guidance,
      blocks: s.kind === 'CLIENT_INPUT' ? [{ type: 'RICH_TEXT', content: { markdown: 'Contexte.' } }] : s.blocks,
    }));
    await http().put(`/v1/proposals/${id}/sections`).set('x-lsi-session', AM_A).send({ sections }).expect(200);
    await http().post(`/v1/proposals/${id}/recipients`).set('x-lsi-session', AM_A).send({ fullName: 'S', email: 'sup@a.example.fr', role: 'SIGNER' }).expect(201);
    const r = await http().post(`/v1/proposals/${id}/mark-ready`).set('x-lsi-session', AM_A).expect(409);
    expect(r.body.rule).toBe('P-TO-VALIDATE');
    const readiness = await http().get(`/v1/proposals/${id}/readiness`).set('x-lsi-session', AM_A).expect(200);
    expect(readiness.body.blocking.map((b: any) => b.key)).toEqual(expect.arrayContaining(['serveur-supervise', 'controle-sauvegardes']));
    await http().post(`/v1/proposals/${id}/submit-review`).set('x-lsi-session', AM_A).expect(409);
  });
});

describe('décision du client, relances, suivi', () => {
  test('refus motivé : REFUSÉE, relances annulées, commercial notifié', async () => {
    const p = await sentProposal(AM_A, fx.customerA.id, 'refus@a.example.fr');
    await http().post(`/v1/public/proposals/${p.token}/decline`).send({ reasonCode: 'NIMPORTE' }).expect(400);
    await http().post(`/v1/public/proposals/${p.token}/decline`).send({ reasonCode: 'PRICE', reason: 'Budget insuffisant' }).expect(200);
    const d = await http().get(`/v1/proposals/${p.id}`).set('x-lsi-session', AM_A).expect(200);
    expect(d.body.proposal).toMatchObject({ status: 'DECLINED', declineReasonCode: 'PRICE', declineReason: 'Budget insuffisant' });
    const t = await http().get(`/v1/proposals/${p.id}/tracking`).set('x-lsi-session', AM_A).expect(200);
    expect(t.body.followUps.every((f: any) => f.status === 'CANCELLED')).toBe(true);
    const notes = await http().get('/v1/notifications').set('x-lsi-session', AM_A).expect(200);
    expect(notes.body.items.map((n: any) => n.type)).toContain('proposal.declined');
    await http().post(`/v1/public/proposals/${p.token}/comments`).send({ body: 'Encore une question' }).expect(409);
  });

  test('relance due : nouveau lien envoyé, ancien révoqué ; suspendue si le client a répondu', async () => {
    const p = await sentProposal(AM_A, fx.customerA.id, 'relance@a.example.fr');
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.proposalFollowUp.updateMany({ where: { proposalId: p.id, kind: 'NO_OPEN' }, data: { dueAt: new Date(Date.now() - 1000) } }),
    );
    email.reset();
    await app.get(ProposalJobsService).sweep(new Date());
    expect(email.sent.at(-1)!.subject).toMatch(/vous attend/);
    await http().get(`/v1/public/proposals/${p.token}`).expect(410);
    const fresh = lastToken();
    await http().post(`/v1/public/proposals/${fresh}/comments`).send({ body: 'J’ai une question' }).expect(201);
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.proposalFollowUp.updateMany({ where: { proposalId: p.id, kind: 'NO_DECISION' }, data: { dueAt: new Date(Date.now() - 1000) } }),
    );
    email.reset();
    await app.get(ProposalJobsService).sweep(new Date());
    expect(email.sent).toEqual([]);
    const t = await http().get(`/v1/proposals/${p.id}/tracking`).set('x-lsi-session', AM_A).expect(200);
    expect(t.body.followUps.find((f: any) => f.kind === 'NO_DECISION')).toMatchObject({ status: 'SKIPPED' });
  });

  test('signature refusée (webhook) : retour EN DISCUSSION, nouvelle acceptation = nouvelle soumission', async () => {
    const p = await sentProposal(AM_A, fx.customerA.id, 'declin@a.example.fr');
    const accept = { fullName: 'D S', jobTitle: 'Gérant', email: 'declin@a.example.fr', consent: true };
    await http().post(`/v1/public/proposals/${p.token}/accept`).send(accept).expect(200);
    const sr = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.proposalSignatureRequest.findFirstOrThrow({ where: { proposalId: p.id }, include: { signers: true } }),
    );
    const client = sr.signers.find((s) => s.party === 'CLIENT')!;
    let body = readFileSync(fileURLToPath(new URL('../../../../test/fixtures/proposals/webhook.form-declined.json', import.meta.url)), 'utf8');
    for (const [k, v] of Object.entries({ SUBMISSION_ID: Number(sr.providerSubmissionId), CLIENT_SIGNER_ID: client.id, TENANT_ID: fx.tenantId, CUSTOMER_ID: fx.customerA.id, PROPOSAL_ID: p.id, SIGNATURE_REQUEST_ID: sr.id })) {
      body = body.split(`"__${k}__"`).join(JSON.stringify(v)).split(`__${k}__`).join(String(v));
    }
    const ts = Math.floor(Date.now() / 1000);
    const sig = `${ts}.${createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`;
    const w = await http().post('/v1/webhooks/docuseal').set('Content-Type', 'application/json').set('X-Docuseal-Signature', sig).send(body).expect(200);
    expect(w.body.status).toBe('processed');
    const d = await http().get(`/v1/proposals/${p.id}`).set('x-lsi-session', AM_A).expect(200);
    expect(d.body.proposal.status).toBe('IN_DISCUSSION');
    const before = provider.calls.length;
    await http().post(`/v1/public/proposals/${p.token}/accept`).send(accept).expect(200);
    expect(provider.calls.length).toBe(before + 1);
  });
});

describe('règles transverses', () => {
  test('contrats.proposals.required : création directe réservée à l’admin, motif obligatoire et audité', async () => {
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.tenantFeatureFlag.create({ data: { tenantId: fx.tenantId, key: 'contrats.proposals.required', enabled: true, updatedAt: new Date() } }),
    );
    try {
      const body = { customerId: fx.customerA.id, title: 'Contrat direct' };
      expect((await http().post('/v1/contracts').set('x-lsi-session', AM_A).send(body).expect(422)).body.code).toBe('PROPOSAL_REQUIRED');
      await http().post('/v1/contracts').set('x-lsi-session', ADMIN).send(body).expect(422);
      const ok = await http().post('/v1/contracts').set('x-lsi-session', ADMIN).send({ ...body, directCreationReason: 'Reprise d’un accord cadre signé hors application' }).expect(201);
      const audit = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.auditLog.findFirst({ where: { action: 'contract.direct_creation', resourceId: ok.body.id } }),
      );
      expect(audit?.after).toMatchObject({ reason: 'Reprise d’un accord cadre signé hors application' });
    } finally {
      await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.tenantFeatureFlag.update({ where: { tenantId_key: { tenantId: fx.tenantId, key: 'contrats.proposals.required' } }, data: { enabled: false, updatedAt: new Date() } }),
      );
    }
  });

  test('un modèle modifié dans l’interface porte userModifiedAt : le seed ne l’écrase plus', async () => {
    await http().patch('/v1/proposal-admin/templates/rssi').set('x-lsi-session', AM_A).send({ name: 'RSSI maison' }).expect(403);
    const r = await http().patch('/v1/proposal-admin/templates/rssi').set('x-lsi-session', ADMIN).send({ name: 'RSSI maison' }).expect(200);
    expect(r.body.userModifiedAt).toBeTruthy();
    const seed = await seedProposalTemplates(fx.tenantSlug);
    expect(seed.templates.rssi).toBe('SKIPPED_MODIFIED');
    const t = await http().get('/v1/proposal-admin/templates/rssi').set('x-lsi-session', ADMIN).expect(200);
    expect(t.body.name).toBe('RSSI maison');
    // Un contenu de bibliothèque modifié : nouvelle version, protégé aussi.
    const lib = await http().patch('/v1/proposal-admin/library/qui-sommes-nous').set('x-lsi-session', ADMIN).send({ body: 'LSI-Maintenance, MSP basé à Aix-en-Provence (texte revu).' }).expect(200);
    expect(lib.body.version).toBe(2);
    expect((await seedProposalTemplates(fx.tenantSlug)).library['qui-sommes-nous']).toBe('SKIPPED_MODIFIED');
  });

  test('prix à valider : liste réservée à l’admin, validation tracée dans l’audit', async () => {
    await http().get('/v1/proposal-admin/pending-validations').set('x-lsi-session', AM_A).expect(403);
    const list = await http().get('/v1/proposal-admin/pending-validations').set('x-lsi-session', ADMIN).expect(200);
    const target = list.body.items.find((i: any) => i.templateSlug === 'supervision' && i.key === 'minimum-mensuel');
    expect(target).toMatchObject({ scope: 'RULE', detail: { amountCents: 9900 } });
    const after = await http().post('/v1/proposal-admin/pending-validations/validate').set('x-lsi-session', ADMIN)
      .send({ templateSlug: 'supervision', scope: 'RULE', key: 'minimum-mensuel' }).expect(200);
    expect(after.body.total).toBe(list.body.total - 1);
    await http().post('/v1/proposal-admin/pending-validations/validate').set('x-lsi-session', ADMIN)
      .send({ templateSlug: 'supervision', scope: 'RULE', key: 'minimum-mensuel' }).expect(409);
    const audit = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.auditLog.findFirst({ where: { action: 'proposal_template.price_validated' }, orderBy: { seq: 'desc' } }),
    );
    expect(audit?.after).toMatchObject({ templateSlug: 'supervision', key: 'minimum-mensuel' });
  });

  test('purge RGPD : le détail des propositions décidées au-delà de la conservation disparaît, les agrégats restent', async () => {
    const p = await sentProposal(AM_A, fx.customerA.id, 'purge@a.example.fr');
    await http().post(`/v1/public/proposals/${p.token}/events`).send({ events: [{ type: 'OPENED' }] }).expect(202);
    await http().post(`/v1/public/proposals/${p.token}/decline`).send({ reasonCode: 'TIMING' }).expect(200);
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.proposal.update({ where: { id: p.id }, data: { declinedAt: new Date(Date.now() - 400 * 86_400_000) } }),
    );
    await app.get(ProposalJobsService).purge(new Date());
    const t = await http().get(`/v1/proposals/${p.id}/tracking`).set('x-lsi-session', AM_A).expect(200);
    expect(t.body.events).toEqual([]);
    expect(t.body.stats.find((s: any) => s.sectionKey === '')).toMatchObject({ opens: 1 });
  });
});
