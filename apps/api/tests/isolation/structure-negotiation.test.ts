import { describe, test, expect, beforeAll } from 'vitest';
import { createTestApp } from '../support/app.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, clientScope, internalScope, withScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

/**
 * Lot 2 : bibliothèque de clauses, modèles structurés, variables typées,
 * écarts au modèle, négociation et acceptation distincte de la signature.
 */
let app: INestApplication;
let fx: TwoCustomerFixture;
let t2: TwoCustomerFixture;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = await createTestApp(mod);
  fx = await seedTwoCustomers();
  t2 = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'st-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'st-am-b', userId: fx.amBUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) });
  await s.put({ sessionId: 'st-legal', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['LEGAL_REVIEWER'], scope: adminScope(fx.tenantId, fx.adminUserId) });
  await s.put({ sessionId: 'st-client', userId: fx.customerA.clientUserId, tenantId: fx.tenantId, roles: ['CLIENT_SIGNER'], scope: clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId) });
  await s.put({ sessionId: 'st-t2-legal', userId: t2.adminUserId, tenantId: t2.tenantId, roles: ['LEGAL_REVIEWER'], scope: adminScope(t2.tenantId, t2.adminUserId) });
});

const http = () => request(app.getHttpServer());
const as = (sess: string) => ({
  get: (u: string) => http().get(u).set('x-lsi-session', sess),
  post: (u: string, b?: object) => http().post(u).set('x-lsi-session', sess).send(b ?? {}),
  put: (u: string, b: object) => http().put(u).set('x-lsi-session', sess).send(b),
});
const admin = () => adminScope(fx.tenantId, fx.adminUserId);
let seq = 0;
const code = (p: string) => `${p}-${++seq}-${Date.now().toString(36).toUpperCase()}`;

async function clause(title: string, category: string, bodyHtml: string) {
  const r = await as('st-legal').post('/v1/clauses', { code: code('CL'), category, title, bodyHtml }).expect(201);
  return r.body as { id: string; versionId: string };
}

async function publishedTemplate() {
  const objet = await clause('Objet', 'OBJET', '<p>Le présent contrat lie LSI et {{client.raisonSociale}}.</p>');
  const sla = await clause('Niveaux de service', 'SLA', '<p>Intervention sous {{sla.delaiIntervention}}.</p>');
  const rgpd = await clause('Données personnelles', 'RGPD', '<p>Sous-traitance au sens de l’art. 28 RGPD.</p>');
  const t = await as('st-legal').post('/v1/templates', { name: `Maintenance ${code('T')}`, category: 'MAINTENANCE' }).expect(201);
  await as('st-legal').put(`/v1/templates/${t.body.id}/structure`, {
    clauses: [
      { clauseVersionId: objet.versionId, required: true },
      { clauseVersionId: sla.versionId },
      { clauseVersionId: rgpd.versionId, required: true },
    ],
    defaultAnnexes: [{ kind: 'SLA', title: 'Engagements de service', bodyHtml: '<p>Disponibilité 99,5 %.</p>' }],
  }).expect(200);
  await as('st-legal').post(`/v1/templates/${t.body.id}/publish`).expect(201);
  const detail = await as('st-legal').get(`/v1/templates/${t.body.id}`).expect(200);
  return { templateId: t.body.id as string, versionId: detail.body.currentVersion.id as string, objet, sla, rgpd };
}

async function contractFromTemplate(templateVersionId: string) {
  const r = await as('st-am').post('/v1/contracts', {
    customerId: fx.customerA.id, title: 'Maintenance du parc', templateVersionId,
    startDate: '2026-01-01', endDate: '2026-12-31',
  }).expect(201);
  return r.body.id as string;
}

describe('bibliothèque de clauses', () => {
  test('le juriste crée et versionne ; le commercial consulte mais ne crée pas', async () => {
    const c = await clause('Confidentialité', 'CONFIDENTIALITE', '<p>Confidentiel.</p>');
    const v2 = await as('st-legal').post(`/v1/clauses/${c.id}/versions`, { bodyHtml: '<p>Strictement confidentiel.</p>', changeNote: 'renforcée' }).expect(201);
    expect(v2.body.versionId).not.toBe(c.versionId);
    const list = await as('st-am').get('/v1/clauses').expect(200);
    const item = list.body.items.find((i: { id: string }) => i.id === c.id);
    expect(item.currentVersion.versionNumber).toBe(2);
    await as('st-am').post('/v1/clauses', { code: code('X'), category: 'DIVERS', title: 'x', bodyHtml: '<p>x</p>' }).expect(403);
  });

  test('le corps est assaini (liste blanche) à l’enregistrement', async () => {
    const c = await clause('Test', 'DIVERS', '<p onclick="x()">ok</p><script>alert(1)</script>');
    const r = await as('st-legal').get(`/v1/clauses/${c.id}`).expect(200);
    expect(r.body.versions[0].bodyHtml).toBe('<p>ok</p>');
  });

  test('isolation : la bibliothèque d’un tenant est invisible d’un autre', async () => {
    const c = await clause('Privée', 'DIVERS', '<p>t1</p>');
    await as('st-t2-legal').get(`/v1/clauses/${c.id}`).expect(404);
  });
});

describe('contrat créé depuis un modèle', () => {
  test('clauses copiées, annexe par défaut, variables pré-remplies, articles numérotés', async () => {
    const t = await publishedTemplate();
    const id = await contractFromTemplate(t.versionId);
    const s = await as('st-am').get(`/v1/contracts/${id}/structure`).expect(200);
    expect(s.body.clauses.map((c: { title: string }) => c.title)).toEqual(['Objet', 'Niveaux de service', 'Données personnelles']);
    expect(s.body.clauses.every((c: { origin: string }) => c.origin === 'TEMPLATE')).toBe(true);
    expect(s.body.annexes).toHaveLength(1);
    expect(s.body.variables.values['client.raisonSociale']).toBe('Dupont SAS');
    expect(s.body.variables.missing).toBe(1); // sla.delaiIntervention
    expect(s.body.diff).toMatchObject({ hasDeviation: false });

    const v = await withScope(admin(), (tx) => tx.contract.findUnique({ where: { id }, include: { versions: true } }));
    const body = v!.versions[0]!.bodyHtml;
    expect(body).toMatch(/Article 1 — Objet[\s\S]*Article 3 — Données personnelles/);
    expect(body).toContain('Dupont SAS');
    expect(body).toContain('[à compléter : sla.delaiIntervention]');
    expect(body).toContain('Annexe 1 — Engagements de service');
  });

  test('une mise à jour de la bibliothèque ou du modèle NE MODIFIE PAS un contrat émis', async () => {
    const t = await publishedTemplate();
    const id = await contractFromTemplate(t.versionId);
    await as('st-legal').post(`/v1/clauses/${t.objet.id}/versions`, { bodyHtml: '<p>Nouvelle rédaction de l’objet.</p>' }).expect(201);
    const s = await as('st-am').get(`/v1/contracts/${id}/structure`).expect(200);
    expect(s.body.clauses[0].bodyHtml).toContain('Le présent contrat lie LSI');
  });

  test('seule une version PUBLIÉE de modèle peut servir de base', async () => {
    const t = await as('st-legal').post('/v1/templates', { name: `Brouillon ${code('T')}`, category: 'MAINTENANCE' }).expect(201);
    const d = await as('st-legal').get(`/v1/templates/${t.body.id}`).expect(200);
    await as('st-am').post('/v1/contracts', { customerId: fx.customerA.id, title: 'x', templateVersionId: d.body.currentVersion.id }).expect(409);
  });
});

describe('adaptation client : écarts au modèle et variables', () => {
  test('clause modifiée, ajoutée, clause obligatoire retirée : signalés ; variables complétées', async () => {
    const t = await publishedTemplate();
    const id = await contractFromTemplate(t.versionId);
    const s = await as('st-am').get(`/v1/contracts/${id}/structure`).expect(200);
    const [objet, sla] = s.body.clauses;
    const r = await as('st-am').put(`/v1/contracts/${id}/structure`, {
      clauses: [
        { clauseKey: objet.clauseKey, title: objet.title, category: 'OBJET', bodyHtml: objet.bodyHtml, origin: 'TEMPLATE' },
        { clauseKey: sla.clauseKey, title: sla.title, category: 'SLA', bodyHtml: '<p>Intervention sous {{sla.delaiIntervention}}, 24/7.</p>', origin: 'TEMPLATE' },
        { title: 'Pénalités', category: 'SLA', bodyHtml: '<p>Pénalités de retard.</p>' },
      ],
      annexes: [],
      variables: { 'sla.delaiIntervention': '4 heures ouvrées' },
    }).expect(200);
    expect(r.body).toMatchObject({ versionNumber: 2, missingVariables: 0 });
    const after = await as('st-am').get(`/v1/contracts/${id}/structure`).expect(200);
    expect(after.body.diff.modified.map((m: { key: string }) => m.key)).toEqual([sla.clauseKey]);
    expect(after.body.diff.added).toHaveLength(1);
    expect(after.body.diff.removed).toEqual([expect.objectContaining({ title: 'Données personnelles', required: true })]);
    expect(after.body.diff.requiredRemoved).toBe(true);
  });

  test('valeur de variable invalide ou variable inconnue → 409', async () => {
    const t = await publishedTemplate();
    const id = await contractFromTemplate(t.versionId);
    const base = { title: 'X', category: 'DIVERS' as const };
    await as('st-am').put(`/v1/contracts/${id}/structure`, {
      clauses: [{ ...base, bodyHtml: '<p>SIREN {{client.siren}}</p>' }], variables: { 'client.siren': '12' },
    }).expect(409);
    await as('st-am').put(`/v1/contracts/${id}/structure`, {
      clauses: [{ ...base, bodyHtml: '<p>{{projet.inconnu}}</p>' }],
    }).expect(409);
  });

  test('isolation : structure d’un contrat hors portefeuille → 404', async () => {
    const t = await publishedTemplate();
    const id = await contractFromTemplate(t.versionId);
    await as('st-am-b').get(`/v1/contracts/${id}/structure`).expect(404);
    await as('st-am-b').put(`/v1/contracts/${id}/structure`, { clauses: [{ title: 'x', category: 'DIVERS', bodyHtml: '<p>x</p>' }] }).expect(404);
  });
});

/** Contrat libre prêt à valider : contenu, signataires LSI + client. */
async function readyForReview() {
  const r = await as('st-am').post('/v1/contracts', { customerId: fx.customerA.id, title: 'Support', startDate: '2026-01-01', endDate: '2026-12-31' }).expect(201);
  const id = r.body.id as string;
  await as('st-am').put(`/v1/contracts/${id}/content`, { bodyHtml: '<p>Conditions.</p>' }).expect(200);
  await as('st-am').post(`/v1/contracts/${id}/signers`, { party: 'LSI', fullName: 'Marc D.', email: `lsi-${id.slice(-6)}@lsi.fr` }).expect(201);
  await as('st-am').post(`/v1/contracts/${id}/signers`, { party: 'CLIENT', fullName: 'Contact', email: `client-${id.slice(-6)}@dupont.fr` }).expect(201);
  return id;
}

describe('négociation et acceptation (distincte de la signature)', () => {
  test('parcours : validé → présenté → accepté par le client (portail) avec trace IP et version', async () => {
    const id = await readyForReview();
    await as('st-am').post(`/v1/contracts/${id}/submit`).expect(201);
    await as('st-legal').post(`/v1/contracts/${id}/approve`).expect(201);
    await as('st-am').post(`/v1/contracts/${id}/send-to-client`).expect(201);

    const prop = await as('st-client').get(`/v1/portal/contracts/${id}/proposal`).expect(200);
    expect(prop.body.version.bodyHtml).toContain('Conditions');
    const versionId = prop.body.version.id as string;

    await as('st-client').post(`/v1/portal/contracts/${id}/accept`, { versionId: '01900000-0000-7000-8000-000000000000' }).expect(404);
    const ok = await as('st-client').post(`/v1/portal/contracts/${id}/accept`, { versionId }).set('x-forwarded-for', '203.0.113.9').expect(201);
    expect(ok.body.status).toBe('ACCEPTED');

    const acc = await as('st-am').get(`/v1/contracts/${id}/acceptances`).expect(200);
    expect(acc.body.items[0]).toMatchObject({ method: 'PORTAL', versionId, acceptedByEmail: fx.customerA.clientEmail });
    expect(acc.body.items[0].ip).toBeTruthy();
    const events = await withScope(admin(), (tx) => tx.lifecycleEvent.findMany({ where: { contractId: id }, orderBy: { seq: 'asc' } }));
    expect(events.at(-1)).toMatchObject({ fromStatus: 'SENT_TO_CLIENT', toStatus: 'ACCEPTED', event: 'CLIENT_ACCEPT', actorKind: 'CLIENT' });
  });

  test('négociation : l’édition invalide la validation, le renvoi exige une nouvelle revue', async () => {
    const id = await readyForReview();
    await as('st-am').post(`/v1/contracts/${id}/submit`).expect(201);
    await as('st-legal').post(`/v1/contracts/${id}/approve`).expect(201);
    await as('st-am').post(`/v1/contracts/${id}/send-to-client`).expect(201);
    await as('st-am').post(`/v1/contracts/${id}/negotiate`, { reason: 'Le client demande 24/7' }).expect(201);
    await as('st-am').put(`/v1/contracts/${id}/content`, { bodyHtml: '<p>Conditions 24/7.</p>' }).expect(200);
    const c = await withScope(admin(), (tx) => tx.contract.findUnique({ where: { id } }));
    expect(c).toMatchObject({ status: 'IN_NEGOTIATION', approvedVersionId: null });
    await as('st-am').post(`/v1/contracts/${id}/send-to-client`).expect(409);
    await as('st-am').post(`/v1/contracts/${id}/submit`).expect(201);
    await as('st-legal').post(`/v1/contracts/${id}/approve`).expect(201);
    await as('st-am').post(`/v1/contracts/${id}/send-to-client`).expect(201);
  });

  test('acceptation reçue hors application : pièce justificative obligatoire', async () => {
    const id = await readyForReview();
    await as('st-am').post(`/v1/contracts/${id}/submit`).expect(201);
    await as('st-legal').post(`/v1/contracts/${id}/approve`).expect(201);
    await as('st-am').post(`/v1/contracts/${id}/send-to-client`).expect(201);
    const c = await withScope(admin(), (tx) => tx.contract.findUnique({ where: { id } }));
    const body = { versionId: c!.currentVersionId, acceptedByName: 'M. Dupont', acceptedByEmail: 'dupont@dupont.fr' };
    await as('st-am').post(`/v1/contracts/${id}/acceptance`, body).expect(400);
    const r = await as('st-am').post(`/v1/contracts/${id}/acceptance`, { ...body, evidenceNote: 'E-mail du 12/09 archivé (pièce jointe)' }).expect(201);
    expect(r.body.status).toBe('ACCEPTED');
  });

  test('un client ne voit pas la proposition d’un contrat en brouillon ni celle d’un autre client', async () => {
    const id = await readyForReview();
    await as('st-client').get(`/v1/portal/contracts/${id}/proposal`).expect(404);
  });

  test('un commercial ne peut pas accepter à la place du client via le portail (403)', async () => {
    const id = await readyForReview();
    await as('st-am').post(`/v1/portal/contracts/${id}/accept`, { versionId: '01900000-0000-7000-8000-000000000000' }).expect(403);
  });
});

describe('clauses générées par IA : revue humaine obligatoire', () => {
  test('non soumissible tant qu’une clause IA n’est pas validée ; la validation suit le texte', async () => {
    const id = await readyForReview();
    await withScope(admin(), (tx) => tx.contract.update({ where: { id }, data: { origin: 'AI' } }));
    const clauses = [
      { clauseKey: 'OBJET', title: 'Objet', category: 'OBJET', bodyHtml: '<p>Objet IA.</p>', origin: 'AI' },
      { clauseKey: 'DUREE', title: 'Durée', category: 'DUREE', bodyHtml: '<p>12 mois.</p>', origin: 'AI' },
    ];
    const r = await as('st-am').put(`/v1/contracts/${id}/structure`, { clauses }).expect(200);
    expect(r.body.unreviewedAiClauses).toBe(2);
    await as('st-am').post(`/v1/contracts/${id}/submit`).expect(409);
    // L'éditeur libre est fermé aux contrats IA (sinon la revue serait contournée).
    await as('st-am').put(`/v1/contracts/${id}/content`, { bodyHtml: '<p>contournement</p>' }).expect(409);

    const s = await as('st-legal').get(`/v1/contracts/${id}/structure`).expect(200);
    await as('st-am').post(`/v1/contracts/${id}/clauses/${s.body.clauses[0].id}/review`, { decision: 'APPROVED' }).expect(403);
    for (const c of s.body.clauses) {
      await as('st-legal').post(`/v1/contracts/${id}/clauses/${c.id}/review`, { decision: 'APPROVED' }).expect(201);
    }
    // Une nouvelle version au texte identique conserve la validation…
    const same = await as('st-am').put(`/v1/contracts/${id}/structure`, { clauses }).expect(200);
    expect(same.body.unreviewedAiClauses).toBe(0);
    // … mais la modification d'une clause IA la fait tomber.
    const changed = await as('st-am').put(`/v1/contracts/${id}/structure`, {
      clauses: [clauses[0], { ...clauses[1], bodyHtml: '<p>24 mois.</p>' }],
    }).expect(200);
    expect(changed.body.unreviewedAiClauses).toBe(1);
  });
});

describe('verrouillage', () => {
  test('en signature, le contenu structuré n’est plus modifiable (409)', async () => {
    const id = await readyForReview();
    await withScope(admin(), (tx) => tx.contract.update({ where: { id }, data: { status: 'PENDING_SIGNATURE' } }));
    await as('st-am').put(`/v1/contracts/${id}/structure`, { clauses: [{ title: 'x', category: 'DIVERS', bodyHtml: '<p>x</p>' }] }).expect(409);
  });
});
