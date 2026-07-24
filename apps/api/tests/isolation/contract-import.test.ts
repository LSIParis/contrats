import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'sess-tech', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['TECHNICIAN'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
});
const PDF = () => Buffer.from('%PDF-1.7 faux contrat\n%%EOF', 'utf8');

function importReq(sess: string) {
  return request(app.getHttpServer()).post('/v1/contracts/import').set('x-lsi-session', sess);
}

describe('import de contrat existant', () => {
  test('import → 201, contrat ACTIVE/IMPORTED, document récupérable', async () => {
    const res = await importReq('sess-am-a')
      .field('customerId', fx.customerA.id).field('reference', 'IMP-001').field('title', 'Bail existant')
      .field('endDate', '2027-01-01').field('amountCents', '120000')
      .attach('document', PDF(), { filename: 'bail.pdf', contentType: 'application/pdf' })
      .expect(201);
    const id = res.body.id as string;
    const detail = await request(app.getHttpServer()).get(`/v1/contracts/${id}`).set('x-lsi-session', 'sess-am-a').expect(200);
    expect(detail.body.contract.status).toBe('ACTIVE');
    expect(detail.body.contract.origin).toBe('IMPORTED');
    expect(detail.body.importedDocument?.name).toBe('bail.pdf');
    const doc = await request(app.getHttpServer()).get(`/v1/contracts/${id}/imported-document`).set('x-lsi-session', 'sess-am-a').expect(200);
    expect(doc.headers['content-type']).toContain('application/pdf');
    expect(doc.headers['content-disposition']).toContain('attachment');
  });

  test('rôle non autorisé (TECHNICIAN) → 403', async () => {
    await importReq('sess-tech').field('customerId', fx.customerA.id).field('reference', 'IMP-403').field('title', 'x')
      .attach('document', PDF(), { filename: 'x.pdf', contentType: 'application/pdf' }).expect(403);
  });

  test('client hors scope → 404', async () => {
    await importReq('sess-am-a').field('customerId', fx.customerB.id).field('reference', 'IMP-404').field('title', 'x')
      .attach('document', PDF(), { filename: 'x.pdf', contentType: 'application/pdf' }).expect(404);
  });

  test('référence en double → 409', async () => {
    const ok = () => importReq('sess-am-a').field('customerId', fx.customerA.id).field('reference', 'IMP-DUP').field('title', 'x')
      .attach('document', PDF(), { filename: 'x.pdf', contentType: 'application/pdf' });
    await ok().expect(201);
    await ok().expect(409);
  });

  test('fichier absent → 400 ; type non supporté → 400', async () => {
    await importReq('sess-am-a').field('customerId', fx.customerA.id).field('reference', 'IMP-NOFILE').field('title', 'x').expect(400);
    await importReq('sess-am-a').field('customerId', fx.customerA.id).field('reference', 'IMP-TXT').field('title', 'x')
      .attach('document', Buffer.from('texte'), { filename: 'x.txt', contentType: 'text/plain' }).expect(400);
  });
});
