import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { adminScope, internalScope } from '@lsi/persistence';
import { seedProposalContractTemplates, seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { createTestApp } from '../support/app.js';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { CONTRACT_TEMPLATES } from '../../../../packages/persistence/src/seed/contract-templates-data.js';

/**
 * Les quatre contrats types livrés pour les propositions sont UTILISABLES
 * tels quels : publiables depuis l'application, et un contrat créé à partir de
 * chacun reprend clauses, annexes et variables pré-remplies.
 */
let app: INestApplication;
let fx: TwoCustomerFixture;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = await createTestApp(mod);
  fx = await seedTwoCustomers();
  await seedProposalContractTemplates(fx.tenantSlug);
  const s = app.get(SessionService);
  await s.put({ sessionId: 'ctt-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) });
  await s.put({ sessionId: 'ctt-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
});

describe.each(CONTRACT_TEMPLATES.map((t) => [t.slug, t] as const))('contrat type %s', (slug, def) => {
  test('publiable, puis base d’un contrat complet (clauses, annexes, variables pré-remplies)', async () => {
    const list = await http().get('/v1/templates').set('x-lsi-session', 'ctt-admin').expect(200);
    const t = list.body.items.find((i: { slug: string | null }) => i.slug === slug);
    expect(t).toMatchObject({ status: 'DRAFT', slug });

    await http().post(`/v1/templates/${t.id}/publish`).set('x-lsi-session', 'ctt-admin').expect(201);
    const detail = await http().get(`/v1/templates/${t.id}`).set('x-lsi-session', 'ctt-admin').expect(200);

    const created = await http().post('/v1/contracts').set('x-lsi-session', 'ctt-am').send({
      customerId: fx.customerA.id, title: def.name, templateVersionId: detail.body.currentVersion.id,
      startDate: '2026-11-01', endDate: '2028-10-31',
    }).expect(201);
    const st = await http().get(`/v1/contracts/${created.body.id}/structure`).set('x-lsi-session', 'ctt-am').expect(200);
    expect(st.body.clauses).toHaveLength(def.clauses.length);
    expect(st.body.annexes.map((a: { kind: string }) => a.kind)).toEqual(def.annexes.map((a) => a.kind));
    // Variables pré-remplies par l'application (client, contrat).
    expect(st.body.variables.values).toMatchObject({ 'contrat.dureeMois': 24, 'contrat.dateEffet': '2026-11-01' });
    expect(st.body.variables.values['client.raisonSociale']).toBeTruthy();
    expect(st.body.variables.values['prestataire.raisonSociale']).toBeTruthy();
  });
});
