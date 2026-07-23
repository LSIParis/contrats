import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { CONTRACT_DRAFTER, type ContractDrafter } from '../../src/ai-drafting/contract-drafter.port.js';

// Stub : renvoie un HTML fixe avec un <script> (preuve de sanitisation) et des
// placeholders (preuve d'extraction). Aucun appel réseau.
const stubDrafter: ContractDrafter = {
  async draft() {
    return {
      bodyHtml: '<p>Client {{client_nom}}, montant {{montant}}.</p><script>alert(1)</script>',
      suggestedVariables: ['ignore_moi'],
    };
  },
};

let app: INestApplication; let fx: TwoCustomerFixture;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CONTRACT_DRAFTER).useValue(stubDrafter).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) }, 3600);
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});
const req = (s: string, m: 'get'|'post', p: string) => request(app.getHttpServer())[m](p).set('x-lsi-session', s);

describe('aide IA à la rédaction', () => {
  test('rôle non autorisé (ACCOUNT_MANAGER) → 403', async () => {
    await req('sess-am', 'post', '/v1/templates/ai-draft').send({ prompt: 'x' }).expect(403);
  });

  test('prompt vide → 400', async () => {
    await req('sess-admin', 'post', '/v1/templates/ai-draft').send({ prompt: '' }).expect(400);
  });

  test('génère un brouillon sanitisé + variables extraites du HTML nettoyé', async () => {
    const res = await req('sess-admin', 'post', '/v1/templates/ai-draft')
      .send({ prompt: 'Un contrat de maintenance', category: 'MAINTENANCE' }).expect(201);
    expect(res.body.bodyHtml).not.toContain('<script>');
    expect(res.body.suggestedVariables.sort()).toEqual(['client_nom', 'montant']);
  });

  test('ne persiste aucun modèle ni version', async () => {
    const before = (await req('sess-admin', 'get', '/v1/templates').expect(200)).body.items.length;
    await req('sess-admin', 'post', '/v1/templates/ai-draft').send({ prompt: 'Autre contrat' }).expect(201);
    const after = (await req('sess-admin', 'get', '/v1/templates').expect(200)).body.items.length;
    expect(after).toBe(before);
  });
});
