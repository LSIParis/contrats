import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { DOCUMENT_RENDERER } from '../../src/documents/renderer.token.js';
import { FakeRenderer } from '../support/fakes.js';
import { internalScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;
let renderer: FakeRenderer;

beforeAll(async () => {
  renderer = new FakeRenderer();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DOCUMENT_RENDERER).useValue(renderer).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({
    sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId),
  });
});

describe('GET /v1/contracts/:id/preview.pdf', () => {
  test('sans version courante → 422', async () => {
    // customerB.contractId n'a pas de contenu ; on s'authentifie comme admin B ?
    // Plus simple : le contrat A n'a pas encore de version au tout début.
    await request(app.getHttpServer())
      .get(`/v1/contracts/${fx.customerA.contractId}/preview.pdf`).set('x-lsi-session', 'sess-am-a').expect(422);
  });

  test('avec une version → PDF rendu par la chaîne réelle', async () => {
    await request(app.getHttpServer())
      .put(`/v1/contracts/${fx.customerA.contractId}/content`)
      .set('x-lsi-session', 'sess-am-a').send({ bodyHtml: '<p>Texte du contrat</p>' }).expect(200);

    const res = await request(app.getHttpServer())
      .get(`/v1/contracts/${fx.customerA.contractId}/preview.pdf`).set('x-lsi-session', 'sess-am-a').expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    // Le FakeRenderer a bien reçu le bodyHtml de la version.
    expect(renderer.lastHtml).toContain('Texte du contrat');
  });
});
