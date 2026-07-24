import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { DOCUMENT_RENDERER } from '../../src/documents/renderer.token.js';
import { DOCX_RENDERER } from '../../src/documents/docx-renderer.port.js';
import { FakeRenderer, FakeDocxRenderer } from '../support/fakes.js';
import { internalScope } from '@lsi/persistence';
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
  await s.put({ sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'sess-am-b', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amUserId) });
});
const req = (sess: string, p: string) => request(app.getHttpServer()).get(p).set('x-lsi-session', sess);

describe('export contrat', () => {
  test('export.pdf et export.docx de la version courante', async () => {
    await request(app.getHttpServer()).put(`/v1/contracts/${fx.customerA.contractId}/content`)
      .set('x-lsi-session', 'sess-am-a').send({ bodyHtml: '<p>Texte du contrat</p>' }).expect(200);

    const pdf = await req('sess-am-a', `/v1/contracts/${fx.customerA.contractId}/export.pdf`).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('attachment');
    // Nom de fichier = vrai titre du contrat slugifié ('Contrat Dupont SAS').
    expect(pdf.headers['content-disposition']).toContain('filename="Contrat-Dupont-SAS.pdf"');

    const docx = await req('sess-am-a', `/v1/contracts/${fx.customerA.contractId}/export.docx`).expect(200);
    expect(docx.headers['content-type']).toContain('officedocument.wordprocessingml.document');
    expect(docx.headers['content-disposition']).toContain('filename="Contrat-Dupont-SAS.docx"');
  });

  test('contrat hors scope → 404', async () => {
    await req('sess-am-b', `/v1/contracts/${fx.customerA.contractId}/export.pdf`).expect(404);
    await req('sess-am-b', `/v1/contracts/${fx.customerA.contractId}/export.docx`).expect(404);
  });
});
