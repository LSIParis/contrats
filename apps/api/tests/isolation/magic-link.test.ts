import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../../src/app.module.js';
import { EMAIL_SENDER } from '../../src/notifications/email.token.js';
import { FakeEmailSender } from '../support/fake-email.js';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication;
let email: FakeEmailSender;
let fx: TwoCustomerFixture;
let clientEmailA: string;

beforeAll(async () => {
  email = new FakeEmailSender();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EMAIL_SENDER)
    .useValue(email)
    .compile();
  app = mod.createNestApplication({ rawBody: true });
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();

  fx = await seedTwoCustomers();
  process.env.DEFAULT_TENANT_SLUG = fx.tenantSlug;
  clientEmailA = fx.customerA.clientEmail;
});

beforeEach(() => email.reset());

describe('magic link — parcours nominal', () => {
  test('demande → email envoyé avec un lien', async () => {
    await request(app.getHttpServer())
      .post('/v1/portal/auth/request-link')
      .send({ email: clientEmailA })
      .expect(200);

    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.to).toBe(clientEmailA);
    expect(email.lastMagicToken()).toBeTruthy();
  });

  test('vérification du lien → session + cookie', async () => {
    await request(app.getHttpServer()).post('/v1/portal/auth/request-link').send({ email: clientEmailA });
    const token = email.lastMagicToken()!;

    const res = await request(app.getHttpServer()).get(`/v1/portal/auth/verify?token=${token}`).expect(302);
    expect(res.headers['location']).toContain('/portal/contracts');
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/lsi_sess=/);
    expect(cookie.toLowerCase()).toContain('httponly');
    expect(cookie.toLowerCase()).toContain('samesite=strict');

    // Le cookie ouvre bien une session : une route protégée du PORTAIL passe.
    // (`/v1/contracts`, interne, est désormais refusée à une session CLIENT —
    // garde deny-by-default, Task 2 : voir client-portal-guard.test.ts.)
    const sid = cookie.match(/lsi_sess=([^;]+)/)![1];
    const me = await request(app.getHttpServer())
      .get('/v1/portal/contracts')
      .set('Cookie', `lsi_sess=${sid}`);
    expect(me.status).toBe(200); // client authentifié, voit ses contrats
  });

  test('le client ainsi connecté est bien épinglé à SON customer', async () => {
    await request(app.getHttpServer()).post('/v1/portal/auth/request-link').send({ email: clientEmailA });
    const token = email.lastMagicToken()!;
    const res = await request(app.getHttpServer()).get(`/v1/portal/auth/verify?token=${token}`);
    const sid = (res.headers['set-cookie']![0]).match(/lsi_sess=([^;]+)/)![1];

    // Il est épinglé à SON customer (RM-31) : /v1/portal/me, borné par le
    // scope de session, renvoie le nom de customerA — jamais celui de
    // customerB.
    const me = await request(app.getHttpServer()).get('/v1/portal/me').set('Cookie', `lsi_sess=${sid}`);
    expect(me.body.customerName).toBe(fx.customerA.name);
    expect(me.body.customerName).not.toBe(fx.customerB.name);
  });
});

describe('magic link — sécurité', () => {
  test('usage unique : un token déjà consommé est refusé (410)', async () => {
    await request(app.getHttpServer()).post('/v1/portal/auth/request-link').send({ email: clientEmailA });
    const token = email.lastMagicToken()!;
    await request(app.getHttpServer()).get(`/v1/portal/auth/verify?token=${token}`).expect(302);
    // Rejeu
    const replay = await request(app.getHttpServer()).get(`/v1/portal/auth/verify?token=${token}`).expect(302);
    expect(replay.headers['location']).toContain('/portal/login?error=lien');
  });

  test('un token bidon est refusé (redirection erreur)', async () => {
    const res = await request(app.getHttpServer()).get('/v1/portal/auth/verify?token=nimportequoi').expect(302);
    expect(res.headers['location']).toContain('/portal/login?error=lien');
  });

  test('pas d’oracle d’énumération : email inconnu → 200 identique, aucun email', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/portal/auth/request-link')
      .send({ email: 'personne@nulle-part.invalid' })
      .expect(200);
    expect(res.body.message).toBeTruthy();
    expect(email.sent).toHaveLength(0);
  });

  test('un compte INTERNE ne reçoit jamais de magic link', async () => {
    // L'AM est INTERNAL ; son email ne doit déclencher aucun envoi.
    await request(app.getHttpServer()).post('/v1/portal/auth/request-link').send({ email: fx.amEmail }).expect(200);
    expect(email.sent).toHaveLength(0);
  });

  test('logout révoque la session', async () => {
    await request(app.getHttpServer()).post('/v1/portal/auth/request-link').send({ email: clientEmailA });
    const token = email.lastMagicToken()!;
    const res = await request(app.getHttpServer()).get(`/v1/portal/auth/verify?token=${token}`);
    const sid = (res.headers['set-cookie']![0]).match(/lsi_sess=([^;]+)/)![1];

    await request(app.getHttpServer()).post('/v1/portal/auth/logout').set('Cookie', `lsi_sess=${sid}`).expect(200);
    // Session révoquée → la route protégée retombe en 401.
    await request(app.getHttpServer()).get('/v1/contracts').set('Cookie', `lsi_sess=${sid}`).expect(401);
  });
});
