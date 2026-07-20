import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope, withScope } from '@lsi/persistence';
import { seedTwoCustomers, assignAdminRole, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: TwoCustomerFixture;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  // seedTwoCustomers ne pose PAS de ligne user_roles MSP_ADMIN sur fx.adminUserId
  // (son statut admin vient uniquement du scope adminScope() posé en session,
  // pas d'un rôle persisté). Le test « dernier MSP_ADMIN » a besoin d'un rôle
  // MSP_ADMIN réellement en base pour que la garde ait un sens : sans cela, le
  // compte des « autres MSP_ADMIN actifs » démarrerait à 0 même AVANT toute
  // désactivation, et le test passerait pour une mauvaise raison.
  await assignAdminRole(fx.tenantId, fx.adminUserId);
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) });
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
});
const post = (body: object, sess = 'sess-admin') => request(app.getHttpServer()).post('/v1/users').set('x-lsi-session', sess).send(body);

describe('gestion des utilisateurs (MSP_ADMIN)', () => {
  test('créer un utilisateur INTERNE avec des rôles', async () => {
    const res = await post({ kind: 'INTERNAL', email: 'interne1@lsi.fr', fullName: 'Jean Interne', roles: ['ACCOUNT_MANAGER'] }).expect(201);
    const u = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.user.findUnique({ where: { id: res.body.id }, include: { roles: { include: { role: true } } } }));
    expect(u).toMatchObject({ kind: 'INTERNAL', email: 'interne1@lsi.fr', status: 'ACTIVE', customerId: null });
    expect(u!.roles.map((r: any) => r.role.code)).toContain('ACCOUNT_MANAGER');
  });

  test('créer un utilisateur CLIENT rattaché à un client', async () => {
    const res = await post({ kind: 'CLIENT', email: 'client1@acme.fr', fullName: 'Nathalie', customerId: fx.customerA.id, roles: ['CLIENT_VIEWER'] }).expect(201);
    const u = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.user.findUnique({ where: { id: res.body.id } }));
    expect(u).toMatchObject({ kind: 'CLIENT', customerId: fx.customerA.id });
  });

  test('CLIENT sans customerId → 422', async () => {
    await post({ kind: 'CLIENT', email: 'c2@acme.fr', fullName: 'X', roles: ['CLIENT_VIEWER'] }).expect(422);
  });
  test('CLIENT avec un rôle interne → 422', async () => {
    await post({ kind: 'CLIENT', email: 'c3@acme.fr', fullName: 'X', customerId: fx.customerA.id, roles: ['ACCOUNT_MANAGER'] }).expect(422);
  });
  test('INTERNE avec un rôle client → 422', async () => {
    await post({ kind: 'INTERNAL', email: 'i2@lsi.fr', fullName: 'X', roles: ['CLIENT_VIEWER'] }).expect(422);
  });
  test('email déjà pris → 409', async () => {
    await post({ kind: 'INTERNAL', email: 'dup@lsi.fr', fullName: 'A', roles: ['TECHNICIAN'] }).expect(201);
    await post({ kind: 'INTERNAL', email: 'dup@lsi.fr', fullName: 'B', roles: ['TECHNICIAN'] }).expect(409);
  });
  test('non-MSP_ADMIN → 403', async () => {
    await post({ kind: 'INTERNAL', email: 'x@lsi.fr', fullName: 'X', roles: ['TECHNICIAN'] }, 'sess-am').expect(403);
  });

  test('GET /v1/users liste les utilisateurs du tenant', async () => {
    const res = await request(app.getHttpServer()).get('/v1/users').set('x-lsi-session', 'sess-admin').expect(200);
    expect(res.body.items.some((u: any) => u.email === 'interne1@lsi.fr')).toBe(true);
    expect(res.body.items[0]).toHaveProperty('roles');
  });

  test('PATCH désactive et modifie les rôles', async () => {
    const id = (await post({ kind: 'INTERNAL', email: 'patch@lsi.fr', fullName: 'P', roles: ['TECHNICIAN'] }).expect(201)).body.id;
    await request(app.getHttpServer()).patch(`/v1/users/${id}`).set('x-lsi-session', 'sess-admin').send({ status: 'DISABLED', roles: ['LEGAL_REVIEWER'] }).expect(200);
    const u = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.user.findUnique({ where: { id }, include: { roles: { include: { role: true } } } }));
    expect(u!.status).toBe('DISABLED');
    expect(u!.roles.map((r: any) => r.role.code)).toEqual(['LEGAL_REVIEWER']);
  });

  test('on ne peut pas retirer le dernier MSP_ADMIN actif → 409', async () => {
    // fx.adminUserId est le seul MSP_ADMIN actif : le désactiver doit échouer.
    await request(app.getHttpServer()).patch(`/v1/users/${fx.adminUserId}`).set('x-lsi-session', 'sess-admin').send({ status: 'DISABLED' }).expect(409);
  });
});
