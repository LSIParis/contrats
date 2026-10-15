import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { adminScope, internalScope, withScope } from '@lsi/persistence';
import { seedContractKindsFor, seedProposalTemplates, seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { createTestApp } from '../support/app.js';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';

/**
 * Descriptions riches (HTML) des codes de la grille, des lignes de proposition
 * et des lignes de barème (13-types-contrats.md §3) : balises de mise en forme
 * conservées, tout le reste (scripts, gestionnaires d'événements, styles)
 * retiré À L'ÉCRITURE ; 20 000 caractères au plus.
 */
let app: INestApplication;
let fx: TwoCustomerFixture;
const http = () => request(app.getHttpServer());
const ADMIN = 'dh-admin';
const AM = 'dh-am';

const DIRTY = '<h3>Périmètre</h3><p onclick="x()">Licence <strong>Business</strong> <script>alert(1)</script><a href="javascript:alert(1)">lien</a></p><ul><li>Teams</li></ul>';
const CLEAN = '<h3>Périmètre</h3><p>Licence <strong>Business</strong> <a>lien</a></p><ul><li>Teams</li></ul>';

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = await createTestApp(mod);
  fx = await seedTwoCustomers();
  await seedProposalTemplates(fx.tenantSlug);
  await seedContractKindsFor(fx.tenantSlug);
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.tenantFeatureFlag.create({ data: { tenantId: fx.tenantId, key: 'contrats.proposals.enabled', enabled: true, updatedAt: new Date() } }),
  );
  const s = app.get(SessionService);
  await s.put({ sessionId: ADMIN, userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) });
  await s.put({ sessionId: AM, userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
});

describe('grille tarifaire', () => {
  test('description HTML assainie à la création et à la modification ; vide = absente', async () => {
    const kinds = await http().get('/v1/contract-kinds').set('x-lsi-session', ADMIN).expect(200);
    const m365 = kinds.body.items.find((k: { prefix: string }) => k.prefix === 'M365');
    const created = await http().post(`/v1/contract-kinds/${m365.id}/grid/items`).set('x-lsi-session', ADMIN).send({
      label: 'Business Standard', description: DIRTY, unit: 'PER_USER', recurrence: 'MONTHLY', vatRatePercent: '20',
      effectiveFrom: '2026-01-01', prices: [{ months: 12, unitPrice: '11.7' }],
    }).expect(201);
    expect(created.body.description).toBe(CLEAN);
    const emptied = await http().put(`/v1/price-grid/items/${created.body.code}`).set('x-lsi-session', ADMIN).send({ description: '<p></p>' }).expect(200);
    expect(emptied.body.description).toBeNull();
    await http().put(`/v1/price-grid/items/${created.body.code}`).set('x-lsi-session', ADMIN).send({ description: `<p>${'x'.repeat(20_001)}</p>` }).expect(400);
    // La version copiée par un document reprend la description assainie.
    await http().put(`/v1/price-grid/items/${created.body.code}`).set('x-lsi-session', ADMIN).send({ description: DIRTY }).expect(200);
    const v = await http().get(`/v1/price-grid/variants/${created.body.code}-E12?on=2026-06-01`).set('x-lsi-session', AM).expect(200);
    expect(v.body.description).toBe(CLEAN);
  });

  test('import CSV : description HTML assainie', async () => {
    const kinds = await http().get('/v1/contract-kinds').set('x-lsi-session', ADMIN).expect(200);
    const nxc = kinds.body.items.find((k: { prefix: string }) => k.prefix === 'NXC');
    const csv = ['code;libelle;description;unite;periodicite;tva;E12', `;Stockage;"${DIRTY.replace(/"/g, '""')}";forfait;mensuelle;20;30`].join('\n');
    await http().post(`/v1/contract-kinds/${nxc.id}/grid/import`).set('x-lsi-session', ADMIN)
      .field('effectiveFrom', '2026-01-01')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'g.csv', contentType: 'text/csv' }).expect(201);
    const grid = await http().get(`/v1/contract-kinds/${nxc.id}/grid?on=2026-06-01`).set('x-lsi-session', ADMIN).expect(200);
    expect(grid.body.items[0].description).toBe(CLEAN);
  });
});

describe('propositions', () => {
  test('ligne de proposition : description HTML assainie à l’enregistrement', async () => {
    const p = await http().post('/v1/proposals').set('x-lsi-session', AM).send({ customerId: fx.customerA.id, templateSlug: 'rssi' }).expect(201);
    const def = p.body.version.pricingDefinition;
    def.lines[0].description = DIRTY;
    const put = await http().put(`/v1/proposals/${p.body.proposal.id}/pricing`).set('x-lsi-session', AM).send(def).expect(200);
    expect(put.body.version.pricingDefinition.lines[0].description).toBe(CLEAN);
  });

  test('ligne de modèle : description modifiable par l’administrateur, assainie', async () => {
    const t = await http().get('/v1/proposal-admin/templates/rssi').set('x-lsi-session', ADMIN).expect(200);
    const key = t.body.definition.lines[0].key;
    const res = await http().patch(`/v1/proposal-admin/templates/rssi/lines/${key}`).set('x-lsi-session', ADMIN).send({ description: DIRTY }).expect(200);
    expect(res.body.definition.lines.find((l: { key: string }) => l.key === key).description).toBe(CLEAN);
    const cleared = await http().patch(`/v1/proposal-admin/templates/rssi/lines/${key}`).set('x-lsi-session', ADMIN).send({ description: null }).expect(200);
    expect(cleared.body.definition.lines.find((l: { key: string }) => l.key === key).description).toBeUndefined();
  });
});

describe('barèmes de contrat', () => {
  test('ligne de barème : description HTML enregistrée assainie et relue', async () => {
    const line = {
      lineKey: 'licences', articleCode: 'M365-0001-E12', label: 'Licences', description: DIRTY, unit: 'par utilisateur',
      kind: 'UNIT', mode: 'MANUAL', recurrence: 'MONTHLY', vatRatePercent: '20', quantity: '10', unitPrice: '11.7',
    };
    const res = await http().post(`/v1/contracts/${fx.customerA.contractId}/pricing/schedules`).set('x-lsi-session', AM)
      .send({ validFrom: '2026-01-01', lines: [line] }).expect(201);
    expect(res.body.lines[0].description).toBe(CLEAN);
    const res2 = await http().put(`/v1/contracts/${fx.customerA.contractId}/pricing/schedules/1`).set('x-lsi-session', AM)
      .send({ validFrom: '2026-01-01', lines: [{ ...line, description: '' }] }).expect(200);
    expect(res2.body.lines[0].description).toBeUndefined();
  });
});
