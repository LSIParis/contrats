import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { DOCUMENT_RENDERER } from '../../src/documents/renderer.token.js';
import { DOCX_RENDERER } from '../../src/documents/docx-renderer.port.js';
import { FakeRenderer, FakeDocxRenderer } from '../support/fakes.js';
import { adminScope, internalScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DOCUMENT_RENDERER).useValue(new FakeRenderer())
    .overrideProvider(DOCX_RENDERER).useValue(new FakeDocxRenderer())
    .compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) });
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
});
const post = (p: string, b: any) => request(app.getHttpServer()).post(p).set('x-lsi-session', 'sess-admin').send(b);
const getAs = (sess: string, p: string) => request(app.getHttpServer()).get(p).set('x-lsi-session', sess);

async function newTemplateWithBody(body: string) {
  const id = (await post('/v1/templates', { name: 'Maintenance standard', category: 'MAINTENANCE' }).expect(201)).body.id as string;
  await request(app.getHttpServer()).put(`/v1/templates/${id}/content`).set('x-lsi-session', 'sess-admin').send({ bodyHtml: body }).expect(200);
  return id;
}

describe('export modèle', () => {
  test('export.pdf et export.docx du modèle (avec {{variables}})', async () => {
    const id = await newTemplateWithBody('<p>Client {{client_nom}}</p>');
    const pdf = await getAs('sess-admin', `/v1/templates/${id}/export.pdf`).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('attachment');
    const docx = await getAs('sess-admin', `/v1/templates/${id}/export.docx`).expect(200);
    expect(docx.headers['content-type']).toContain('officedocument.wordprocessingml.document');
  });

  test('rôle non autorisé (ACCOUNT_MANAGER) → 403', async () => {
    const id = await newTemplateWithBody('<p>x</p>');
    await getAs('sess-am', `/v1/templates/${id}/export.pdf`).expect(403);
    await getAs('sess-am', `/v1/templates/${id}/export.docx`).expect(403);
  });

  test('modèle inexistant → 404 ; corps vide → 422', async () => {
    await getAs('sess-admin', '/v1/templates/00000000-0000-7000-8000-000000000000/export.pdf').expect(404);
    const empty = (await post('/v1/templates', { name: 'Vide', category: 'MAINTENANCE' }).expect(201)).body.id as string;
    await getAs('sess-admin', `/v1/templates/${empty}/export.pdf`).expect(422);
  });
});
