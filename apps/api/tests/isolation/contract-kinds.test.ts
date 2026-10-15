import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { adminScope, clientScope, internalScope } from '@lsi/persistence';
import { seedContractKindsFor, seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { createTestApp } from '../support/app.js';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';

/**
 * Types de contrats et grilles par durée d'engagement
 * (docs/contrats/13-types-contrats.md), de bout en bout sur HTTP : types
 * prédéfinis et personnalisés (même mécanisme), codes générés, préfixe figé,
 * prix historisés, sélecteur des documents, CSV — et un tenant ne voit rien
 * de la grille d'un autre.
 */
let app: INestApplication;
let t1: TwoCustomerFixture;
let t2: TwoCustomerFixture;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = await createTestApp(mod);
  t1 = await seedTwoCustomers();
  t2 = await seedTwoCustomers();
  await seedContractKindsFor(t1.tenantSlug);
  await seedContractKindsFor(t2.tenantSlug);
  const s = app.get(SessionService);
  await s.put({ sessionId: 'ck-admin', userId: t1.adminUserId, tenantId: t1.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(t1.tenantId, t1.adminUserId) });
  await s.put({ sessionId: 'ck-am', userId: t1.amUserId, tenantId: t1.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(t1.tenantId, [t1.customerA.id], t1.amUserId) });
  await s.put({ sessionId: 'ck-client', userId: t1.customerA.clientUserId, tenantId: t1.tenantId, roles: ['CLIENT_SIGNER'], scope: clientScope(t1.tenantId, t1.customerA.id, t1.customerA.clientUserId) });
  await s.put({ sessionId: 'ck-admin2', userId: t2.adminUserId, tenantId: t2.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(t2.tenantId, t2.adminUserId) });
});

const as = (session: string) => ({
  get: (url: string) => http().get(url).set('x-lsi-session', session),
  post: (url: string, body?: object) => http().post(url).set('x-lsi-session', session).send(body ?? {}),
  put: (url: string, body: object) => http().put(url).set('x-lsi-session', session).send(body),
  del: (url: string) => http().delete(url).set('x-lsi-session', session),
});
const admin = as('ck-admin');

async function kindByPrefix(prefix: string) {
  const res = await admin.get('/v1/contract-kinds?archived=true').expect(200);
  return res.body.items.find((k: { prefix: string }) => k.prefix === prefix) as { id: string; prefix: string; prefixLocked: boolean };
}

const licence = (prices: { months: number; unitPrice: string | null; purchasePrice?: string | null }[], effectiveFrom = '2026-01-01') => ({
  label: 'Microsoft 365 Business Standard', unit: 'PER_USER', recurrence: 'MONTHLY', vatRatePercent: '20', effectiveFrom, prices,
});

describe('types de contrats', () => {
  test('les 7 types prédéfinis, lisibles par un commercial, pas par un client', async () => {
    const res = await as('ck-am').get('/v1/contract-kinds').expect(200);
    expect(res.body.items.map((k: { prefix: string }) => k.prefix)).toEqual(['HM', 'MNT', 'M365', 'NXC', 'TIP', 'DPO', 'RSSI']);
    expect(res.body.items.every((k: { isSystem: boolean }) => k.isSystem)).toBe(true);
    await as('ck-client').get('/v1/contract-kinds').expect(403);
    const terms = await as('ck-am').get('/v1/commitment-terms').expect(200);
    expect(terms.body.items.map((t: { months: number }) => t.months)).toEqual([0, 12, 24, 36]);
  });

  test('création d\'un type personnalisé : admin seulement, préfixe validé et unique', async () => {
    await as('ck-am').post('/v1/contract-kinds', { label: 'Sauvegarde', prefix: 'SAV' }).expect(403);
    await admin.post('/v1/contract-kinds', { label: 'Sauvegarde', prefix: 'sav' }).expect(400);
    await admin.post('/v1/contract-kinds', { label: 'Sauvegarde', prefix: 'S' }).expect(400);
    const res = await admin.post('/v1/contract-kinds', { label: 'Sauvegarde en ligne', prefix: 'SAV', description: 'Autre domaine' }).expect(201);
    expect(res.body).toMatchObject({ prefix: 'SAV', isSystem: false, prefixLocked: false, itemCount: 0 });
    const dup = await admin.post('/v1/contract-kinds', { label: 'Doublon', prefix: 'M365' }).expect(409);
    expect(dup.body.code).toBe('PREFIX_TAKEN');
  });

  test('type personnalisé : même mécanisme de codes que les prédéfinis', async () => {
    const sav = await kindByPrefix('SAV');
    const res = await admin.post(`/v1/contract-kinds/${sav.id}/grid/items`, licence([{ months: 12, unitPrice: '30' }])).expect(201);
    expect(res.body.code).toBe('SAV-0001');
    expect(res.body.variants.map((v: { code: string }) => v.code)).toEqual(['SAV-0001-E12']);
  });

  test('préfixe modifiable avant le premier code, figé ensuite', async () => {
    const created = await admin.post('/v1/contract-kinds', { label: 'Cloud', prefix: 'CLD' }).expect(201);
    await admin.put(`/v1/contract-kinds/${created.body.id}`, { prefix: 'CLOUD' }).expect(200);
    await admin.post(`/v1/contract-kinds/${created.body.id}/grid/items`, licence([{ months: 0, unitPrice: '5' }])).expect(201);
    const res = await admin.put(`/v1/contract-kinds/${created.body.id}`, { prefix: 'CLD' }).expect(409);
    expect(res.body.code).toBe('PREFIX_LOCKED');
    expect((await kindByPrefix('CLOUD')).prefixLocked).toBe(true);
    // Libellé toujours modifiable.
    await admin.put(`/v1/contract-kinds/${created.body.id}`, { label: 'Cloud privé' }).expect(200);
  });

  test('suppression : prédéfini → 409, avec codes → 409, personnalisé vierge → supprimé ; archivage toujours possible', async () => {
    const m365 = await kindByPrefix('M365');
    expect((await admin.del(`/v1/contract-kinds/${m365.id}`).expect(409)).body.code).toBe('SYSTEM_KIND');
    const sav = await kindByPrefix('SAV');
    expect((await admin.del(`/v1/contract-kinds/${sav.id}`).expect(409)).body.code).toBe('KIND_IN_USE');
    const vierge = await admin.post('/v1/contract-kinds', { label: 'Essai', prefix: 'ESSAI' }).expect(201);
    await admin.del(`/v1/contract-kinds/${vierge.body.id}`).expect(200);
    const hm = await kindByPrefix('HM');
    await admin.post(`/v1/contract-kinds/${hm.id}/archive`).expect(201);
    expect((await admin.get('/v1/contract-kinds').expect(200)).body.items.some((k: { prefix: string }) => k.prefix === 'HM')).toBe(false);
    await admin.post(`/v1/contract-kinds/${hm.id}/unarchive`).expect(201);
  });
});

describe('grille tarifaire', () => {
  test('codes générés, une version par durée, durée vide non proposée', async () => {
    const m365 = await kindByPrefix('M365');
    const res = await admin
      .post(`/v1/contract-kinds/${m365.id}/grid/items`, licence([
        { months: 0, unitPrice: '12.5', purchasePrice: '9.6' },
        { months: 12, unitPrice: '11.7' },
        { months: 24, unitPrice: '11.2' },
        { months: 36, unitPrice: null },
      ]))
      .expect(201);
    expect(res.body.code).toBe('M365-0001');
    expect(res.body.variants.map((v: { code: string }) => v.code)).toEqual(['M365-0001-E00', 'M365-0001-E12', 'M365-0001-E24']);
    const second = await admin.post(`/v1/contract-kinds/${m365.id}/grid/items`, { ...licence([{ months: 36, unitPrice: '20' }]), label: 'Exchange Online' }).expect(201);
    expect(second.body.code).toBe('M365-0002');
  });

  test('changement de prix : nouvelle valeur datée, ancien prix consultable', async () => {
    await admin.post('/v1/price-grid/items/M365-0001/prices', { effectiveFrom: '2026-07-01', prices: [{ months: 12, unitPrice: '12.1' }] }).expect(201);
    const m365 = await kindByPrefix('M365');
    const before = await admin.get(`/v1/contract-kinds/${m365.id}/grid?on=2026-06-30`).expect(200);
    const after = await admin.get(`/v1/contract-kinds/${m365.id}/grid?on=2026-07-01`).expect(200);
    const e12 = (g: { body: { items: { code: string; variants: { months: number; unitPrice: string }[] }[] } }) =>
      g.body.items.find((i) => i.code === 'M365-0001')!.variants.find((v) => v.months === 12)!.unitPrice;
    expect([e12(before), e12(after)]).toEqual(['11.7', '12.1']);
    const hist = await admin.get('/v1/price-grid/items/M365-0001/history').expect(200);
    const v12 = hist.body.variants.find((v: { months: number }) => v.months === 12);
    expect(v12.prices.map((p: { unitPrice: string; effectiveFrom: string }) => `${p.effectiveFrom}=${p.unitPrice}`)).toEqual(['2026-07-01=12.1', '2026-01-01=11.7']);
    // Un commercial ne modifie pas la grille.
    await as('ck-am').post('/v1/price-grid/items/M365-0001/prices', { prices: [{ months: 12, unitPrice: '1' }] }).expect(403);
  });

  test('retrait puis remise en vente d\'une durée : même code, jamais réattribué', async () => {
    await admin.post('/v1/price-grid/items/M365-0001/prices', { effectiveFrom: '2026-08-01', prices: [{ months: 24, unitPrice: null }] }).expect(201);
    let s = await admin.get('/v1/price-grid/variants?q=M365-0001&on=2026-08-15').expect(200);
    expect(s.body.items.map((i: { code: string }) => i.code)).toEqual(['M365-0001-E00', 'M365-0001-E12']);
    await admin.post('/v1/price-grid/items/M365-0001/prices', { effectiveFrom: '2026-09-01', prices: [{ months: 24, unitPrice: '11' }] }).expect(201);
    s = await admin.get('/v1/price-grid/variants?q=M365-0001&months=24&on=2026-09-15').expect(200);
    expect(s.body.items).toEqual([expect.objectContaining({ code: 'M365-0001-E24', unitPrice: '11' })]);
  });
});

describe('sélecteur des documents', () => {
  test('filtres : type, durée, texte ; version sans prix en vigueur exclue', async () => {
    const m365 = await kindByPrefix('M365');
    const byKind = await as('ck-am').get(`/v1/price-grid/variants?kindId=${m365.id}&months=36&on=2026-09-15`).expect(200);
    expect(byKind.body.items.map((i: { code: string }) => i.code)).toEqual(['M365-0002-E36']);
    const byText = await as('ck-am').get('/v1/price-grid/variants?q=exchange&on=2026-09-15').expect(200);
    expect(byText.body.items.map((i: { code: string }) => i.code)).toEqual(['M365-0002-E36']);
    // Avant la première date d'effet : rien à proposer.
    const early = await as('ck-am').get('/v1/price-grid/variants?q=M365&on=2025-12-31').expect(200);
    expect(early.body.items).toEqual([]);
  });

  test('résolution d\'un code : ce que le document copie (code, libellé, prix, TVA)', async () => {
    const res = await as('ck-am').get('/v1/price-grid/variants/M365-0001-E00?on=2026-09-15').expect(200);
    expect(res.body).toMatchObject({
      code: 'M365-0001-E00', itemCode: 'M365-0001', months: 0, label: 'Microsoft 365 Business Standard',
      unit: 'PER_USER', recurrence: 'MONTHLY', vatRatePercent: '20', unitPrice: '12.5', purchasePrice: '9.6',
      effectiveFrom: '2026-01-01', kind: { prefix: 'M365' },
    });
    await as('ck-am').get('/v1/price-grid/variants/M365-0001-E36').expect(404);
  });

  test('code archivé : plus proposé, mais l\'historique reste', async () => {
    await admin.post('/v1/price-grid/items/M365-0002/archive').expect(201);
    expect((await as('ck-am').get('/v1/price-grid/variants?q=M365-0002&on=2026-09-15').expect(200)).body.items).toEqual([]);
    expect((await as('ck-am').get('/v1/price-grid/variants/M365-0002-E36?on=2026-09-15').expect(409)).body.code).toBe('VARIANT_UNAVAILABLE');
    await admin.get('/v1/price-grid/items/M365-0002/history').expect(200);
    await admin.post('/v1/price-grid/items/M365-0002/unarchive').expect(201);
  });
});

describe('import / export CSV', () => {
  test('export puis réimport à l\'identique : aucun changement', async () => {
    const m365 = await kindByPrefix('M365');
    const csv = await admin.get(`/v1/contract-kinds/${m365.id}/grid.csv`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe('﻿code;libelle;description;unite;periodicite;tva;E00;E12;E24;E36;achat_E00;achat_E12;achat_E24;achat_E36');
    expect(csv.text).toContain('M365-0001;Microsoft 365 Business Standard;;par utilisateur;mensuelle;20;12,5;12,1;11;;9,6;;;');
    const res = await http().post(`/v1/contract-kinds/${m365.id}/grid/import`).set('x-lsi-session', 'ck-admin')
      .field('dryRun', 'false')
      .attach('file', Buffer.from(csv.text, 'utf8'), { filename: 'grille.csv', contentType: 'text/csv' })
      .expect(201);
    expect(res.body).toMatchObject({ created: [], updated: [], pricesAdded: 0, variantsWithdrawn: 0 });
  });

  test('aperçu (dryRun) sans effet, puis import : nouveau code et nouveau prix', async () => {
    const m365 = await kindByPrefix('M365');
    const file = [
      'code;libelle;description;unite;periodicite;tva;E00;E12',
      'M365-0001;Microsoft 365 Business Standard;;par utilisateur;mensuelle;20;13,00;12,1',
      ';Defender for Business;Protection des postes;PER_DEVICE;mensuelle;20;3,1;2,9',
    ].join('\n');
    const send = (dryRun: boolean) =>
      http().post(`/v1/contract-kinds/${m365.id}/grid/import`).set('x-lsi-session', 'ck-admin')
        .field('dryRun', String(dryRun)).field('effectiveFrom', '2026-10-01')
        .attach('file', Buffer.from(file, 'utf8'), { filename: 'grille.csv', contentType: 'text/csv' });
    const preview = await send(true).expect(201);
    expect(preview.body).toMatchObject({ dryRun: true, created: ['M365-0003'], updated: ['M365-0001'], pricesAdded: 3 });
    // Rien d'écrit : le numéro n'a pas été consommé.
    expect((await admin.get('/v1/price-grid/variants?q=defender&on=2026-10-15').expect(200)).body.items).toEqual([]);
    const done = await send(false).expect(201);
    expect(done.body).toMatchObject({ dryRun: false, created: ['M365-0003'], updated: ['M365-0001'], pricesAdded: 3 });
    const e00 = await admin.get('/v1/price-grid/variants/M365-0001-E00?on=2026-10-15').expect(200);
    expect(e00.body.unitPrice).toBe('13');
  });

  test('fichier invalide : refusé en bloc avec les lignes fautives', async () => {
    const m365 = await kindByPrefix('M365');
    const file = ['code;libelle;unite;periodicite;tva;E00;E48', 'MNT-0001;X;inconnue;mensuelle;20;1;1'].join('\n');
    const res = await http().post(`/v1/contract-kinds/${m365.id}/grid/import`).set('x-lsi-session', 'ck-admin')
      .attach('file', Buffer.from(file, 'utf8'), { filename: 'grille.csv', contentType: 'text/csv' })
      .expect(422);
    expect(res.body.errors).toEqual([expect.objectContaining({ line: 1, message: expect.stringMatching(/E48/) })]);
  });
});

describe('isolation entre tenants', () => {
  test('un autre tenant ne voit ni les types personnalisés ni les codes', async () => {
    const sav = await kindByPrefix('SAV');
    await as('ck-admin2').get(`/v1/contract-kinds/${sav.id}`).expect(404);
    await as('ck-admin2').get('/v1/price-grid/variants/M365-0001-E00').expect(404);
    const list = await as('ck-admin2').get('/v1/contract-kinds').expect(200);
    expect(list.body.items.some((k: { prefix: string }) => k.prefix === 'SAV')).toBe(false);
    // Les codes sont propres à chaque tenant : M365-0001 y est libre.
    const m365 = (list.body.items as { id: string; prefix: string }[]).find((k) => k.prefix === 'M365')!;
    const res = await as('ck-admin2').post(`/v1/contract-kinds/${m365.id}/grid/items`, licence([{ months: 12, unitPrice: '1' }])).expect(201);
    expect(res.body.code).toBe('M365-0001');
  });
});
