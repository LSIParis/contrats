import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({
    sessionId: 'sess-admin',
    userId: fx.adminUserId,
    tenantId: fx.tenantId,
    roles: ['MSP_ADMIN'],
    scope: adminScope(fx.tenantId, fx.adminUserId),
  });
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.contract.create({
      data: {
        id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id,
        reference: 'LSI-CHERCHE-XYZ', title: 'Sauvegarde datacenter', type: 'MAIN',
        status: 'DRAFT', category: 'MAINTENANCE', currency: 'EUR', billingFrequency: 'MONTHLY',
        ownerUserId: fx.amUserId, createdAt: now, updatedAt: now,
        createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
      },
    }),
  );
});

describe('GET /v1/contracts?q=', () => {
  test('la recherche filtre sur la référence', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/contracts?q=CHERCHE')
      .set('x-lsi-session', 'sess-admin')
      .expect(200);
    expect(res.body.data.some((c: any) => c.reference === 'LSI-CHERCHE-XYZ')).toBe(true);
  });

  test('la recherche filtre sur le titre', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/contracts?q=datacenter')
      .set('x-lsi-session', 'sess-admin')
      .expect(200);
    expect(res.body.data.some((c: any) => c.title === 'Sauvegarde datacenter')).toBe(true);
  });

  test('une recherche sans correspondance renvoie vide', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/contracts?q=zzz-introuvable-zzz')
      .set('x-lsi-session', 'sess-admin')
      .expect(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe('GET /v1/contracts?status= (valeur unique coercée en tableau)', () => {
  // Régression : un `?status=DRAFT` unique arrivait en CHAÎNE, donnant
  // `where.status = { in: "DRAFT" }` — Prisma exige un tableau pour `in`,
  // d'où un 500 (PrismaClientValidationError) en production.
  test('un statut unique ne plante pas et filtre bien', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/contracts?status=DRAFT')
      .set('x-lsi-session', 'sess-admin')
      .expect(200);
    expect(res.body.data.some((c: any) => c.reference === 'LSI-CHERCHE-XYZ')).toBe(true);
  });

  test('un statut unique sans correspondance renvoie vide (pas 500)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/contracts?status=TERMINATED')
      .set('x-lsi-session', 'sess-admin')
      .expect(200);
    expect(res.body.data).toHaveLength(0);
  });
});
