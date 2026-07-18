import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope, adminScope, clientScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture as Fixture } from '@lsi/persistence/testing';

let app: INestApplication;
let fx: Fixture;

/** Session d'un account manager dont le portefeuille = customerA SEULEMENT. */
const SESS_AM_A = 'sess-am-a';
/** Session d'un account manager dont le portefeuille = customerB SEULEMENT. */
const SESS_AM_B = 'sess-am-b';
const SESS_ADMIN = 'sess-admin';
const SESS_CLIENT_A = 'sess-client-a';

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Un champ inconnu dans le body fait ÉCHOUER la requête au lieu d'être
      // silencieusement ignoré. Sans cela, un `tenantId` envoyé par un client
      // serait dropped sans bruit — et le jour où un développeur lit le body
      // brut quelque part, il serait là.
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();

  fx = await seedTwoCustomers();

  const sessions = app.get(SessionService);
  await sessions.put({
    sessionId: SESS_AM_A,
    userId: fx.amUserId,
    tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'],
    scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId),
  });
  await sessions.put({
    sessionId: SESS_AM_B,
    userId: fx.amBUserId,
    tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'],
    scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId),
  });
  await sessions.put({
    sessionId: SESS_ADMIN,
    userId: fx.adminUserId,
    tenantId: fx.tenantId,
    roles: ['MSP_ADMIN'],
    scope: adminScope(fx.tenantId, fx.adminUserId),
  });
  await sessions.put({
    sessionId: SESS_CLIENT_A,
    userId: fx.customerA.clientUserId,
    tenantId: fx.tenantId,
    roles: ['CLIENT_SIGNER'],
    scope: clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId),
  });
});

const as = (sess: string) => (r: request.Test) => r.set('x-lsi-session', sess);

describe('authentification', () => {
  test('sans session → 401', async () => {
    await request(app.getHttpServer()).get('/v1/contracts').expect(401);
  });

  test('session inconnue → 401', async () => {
    await request(app.getHttpServer())
      .get('/v1/contracts')
      .set('x-lsi-session', 'forgée')
      .expect(401);
  });

  test('le healthcheck est public', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });
});

/**
 * §16.4-B — le test matriciel IDOR.
 *
 * Pour chaque endpoint prenant un :id, un acteur du client A tente
 * d'atteindre la ressource du client B. 404 attendu partout — jamais 403.
 *
 * Un 403 confirmerait l'existence de la ressource et transformerait l'API
 * en oracle d'énumération (RM-30).
 */
describe('§16.4-B — matrice IDOR : acteur du client A → ressource du client B', () => {
  const endpoints = [
    { method: 'get' as const, path: (id: string) => `/v1/contracts/${id}`, body: undefined },
    { method: 'get' as const, path: (id: string) => `/v1/contracts/${id}/allowed-actions`, body: undefined },
    { method: 'post' as const, path: (id: string) => `/v1/contracts/${id}/submit`, body: {} },
    { method: 'post' as const, path: (id: string) => `/v1/contracts/${id}/cancel`, body: { reason: 'x' } },
  ];

  test.each(endpoints)('$method $path → 404 sur la ressource du client B', async (ep) => {
    const res = await as(SESS_AM_A)(
      request(app.getHttpServer())[ep.method](ep.path(fx.customerB.contractId)),
    ).send(ep.body as object);

    expect(res.status, `${ep.method} ${ep.path(fx.customerB.contractId)}`).toBe(404);
    // Aucune fuite de contenu dans la réponse d'erreur.
    expect(JSON.stringify(res.body)).not.toContain(fx.customerB.name);
  });

  test.each(endpoints)('$method $path → succès sur SA PROPRE ressource', async (ep) => {
    const res = await as(SESS_AM_A)(
      request(app.getHttpServer())[ep.method](ep.path(fx.customerA.contractId)),
    ).send(ep.body as object);

    // Le contrat existe et est visible : pas de 404. Un 409 est acceptable
    // (transition invalide) — c'est le contrôle d'ÉTAT, pas de scope.
    expect(res.status, `${ep.method} → ${res.status}`).not.toBe(404);
    expect(res.status).not.toBe(401);
  });
});

describe('RM-30 — 404 et non 403 sur une ressource hors scope', () => {
  test('un contrat existant mais hors portefeuille est indiscernable d’un contrat inexistant', async () => {
    const horsScope = await as(SESS_AM_A)(
      request(app.getHttpServer()).get(`/v1/contracts/${fx.customerB.contractId}`),
    );
    const inexistant = await as(SESS_AM_A)(
      request(app.getHttpServer()).get(`/v1/contracts/${uuidv7()}`),
    );

    // Les deux réponses doivent être identiques. Toute différence — code,
    // corps, message — est un oracle d'existence.
    expect(horsScope.status).toBe(404);
    expect(inexistant.status).toBe(404);
    expect(horsScope.body.message).toEqual(inexistant.body.message);
  });
});

describe('listes et scope', () => {
  test('l’AM de A ne voit que le contrat de A', async () => {
    const res = await as(SESS_AM_A)(request(app.getHttpServer()).get('/v1/contracts')).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(fx.customerA.contractId);
  });

  test('l’AM de B ne voit que le contrat de B', async () => {
    const res = await as(SESS_AM_B)(request(app.getHttpServer()).get('/v1/contracts')).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(fx.customerB.contractId);
  });

  test('l’admin voit les deux', async () => {
    const res = await as(SESS_ADMIN)(request(app.getHttpServer()).get('/v1/contracts')).expect(200);
    expect(res.body.data).toHaveLength(2);
  });

  test('filtrer sur le customerId d’un autre client ne l’élargit PAS — liste vide', async () => {
    // Le filtre RESTREINT dans le scope, il ne s'y substitue pas.
    const res = await as(SESS_AM_A)(
      request(app.getHttpServer()).get(`/v1/contracts?customerId=${fx.customerB.id}`),
    ).expect(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('RM-29 — le scope ne peut pas être forgé depuis le réseau', () => {
  test('envoyer un tenantId dans le body est REJETÉ, pas ignoré', async () => {
    const res = await as(SESS_AM_A)(request(app.getHttpServer()).post('/v1/contracts')).send({
      tenantId: uuidv7(), // ← tentative de choisir son propre scope
      customerId: fx.customerA.id,
      title: 'Tentative',
    });
    // forbidNonWhitelisted : on ÉCHOUE bruyamment plutôt que d'ignorer en
    // silence. Un champ ignoré est un champ qu'on lira un jour ailleurs.
    expect(res.status).toBe(400);
  });

  test('créer un contrat chez un client hors portefeuille → 404', async () => {
    const res = await as(SESS_AM_A)(request(app.getHttpServer()).post('/v1/contracts')).send({
      customerId: fx.customerB.id, // ← client hors scope
      title: 'Contrat chez le client d’un collègue',
    });
    // RLS ne trouve pas la ligne `customers` : on ne peut pas créer un
    // contrat chez un client qu'on ne voit pas.
    expect(res.status).toBe(404);
  });

  test('créer un contrat chez SON client réussit', async () => {
    const res = await as(SESS_AM_A)(request(app.getHttpServer()).post('/v1/contracts')).send({
      customerId: fx.customerA.id,
      title: 'Contrat de maintenance 2026',
      amountCents: 1548000,
    });
    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe(fx.tenantId);
    expect(res.body.customerId).toBe(fx.customerA.id);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.reference).toMatch(/^LSI-\d{4}-\d{4}$/);
  });
});

describe('§13.2 — rôle, scope et état sont trois contrôles distincts', () => {
  test('un CLIENT n’a pas le rôle pour créer un contrat → 403', async () => {
    // 403 et non 404 : c'est un refus de RÔLE, pas de scope. Le client
    // voit bien son propre customer — il n'a simplement pas le droit.
    const res = await as(SESS_CLIENT_A)(request(app.getHttpServer()).post('/v1/contracts')).send({
      customerId: fx.customerA.id,
      title: 'Tentative client',
    });
    expect(res.status).toBe(403);
  });

  test('un AM a le rôle et le scope, mais l’ÉTAT refuse → 409', async () => {
    // Contrat DÉDIÉ : la matrice IDOR ci-dessus annule réellement le contrat
    // de A, et ce test recevrait alors INVALID_TRANSITION (état CANCELLED)
    // au lieu de la violation de règle qu'il veut vérifier.
    // Des tests qui partagent un état mutable mentent tôt ou tard.
    const created = await as(SESS_AM_A)(request(app.getHttpServer()).post('/v1/contracts')).send({
      customerId: fx.customerA.id,
      title: 'Contrat sans signataires',
    });
    expect(created.status).toBe(201);

    // DRAFT sans signataires : le domaine refuse (RM-12).
    // Le rôle passe, le scope passe, l'état bloque.
    const res = await as(SESS_AM_A)(
      request(app.getHttpServer()).post(`/v1/contracts/${created.body.id}/submit`),
    ).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTRACT_RULE_VIOLATION');
    expect(res.body.rule).toBe('RM-12');
  });
});
