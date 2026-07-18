import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../../src/app.module.js';
import { OIDC_PROVIDER } from '../../src/auth/oidc.port.js';
import { FakeOidcProvider } from '../support/fake-oidc.js';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { withScope, adminScope, uuidv7 } from '@lsi/persistence';

let app: INestApplication;
let oidc: FakeOidcProvider;
let fx: TwoCustomerFixture;

beforeAll(async () => {
  oidc = new FakeOidcProvider();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(OIDC_PROVIDER)
    .useValue(oidc)
    .compile();
  app = mod.createNestApplication({ rawBody: true });
  app.use(cookieParser());
  await app.init();

  fx = await seedTwoCustomers();
  process.env.DEFAULT_TENANT_SLUG = fx.tenantSlug;

  // Donner un rôle à l'AM interne (sinon roles vide, mais toujours interne).
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    const roleId = uuidv7();
    await tx.role.create({ data: { id: roleId, tenantId: fx.tenantId, code: 'ACCOUNT_MANAGER', label: 'AM' } });
    await tx.userRole.create({ data: { tenantId: fx.tenantId, userId: fx.amUserId, roleId } });
  });
});

beforeEach(() => {
  // Chaque test repart avec le httpServer ; l'agent suit les cookies via jar.
});

/** Effectue le login OIDC complet et renvoie l'id de session (ou null). */
async function loginAs(email: string): Promise<string | null> {
  const agent = request.agent(app.getHttpServer());
  // 1. /login → redirige vers l'IdP (302).
  const start = await agent.get('/v1/auth/login').redirects(0);
  expect(start.status).toBe(302);
  // Récupérer le state stocké (dernier request du fake).
  const state = oidc.requests[oidc.requests.length - 1]!.state;

  // 2. l'IdP renvoie l'identité voulue.
  oidc.setNextIdentity({ email, sub: 'sub-' + email, name: 'Test' });

  // 3. callback.
  const cb = await agent.get(`/v1/auth/callback?state=${state}&code=abc`).redirects(0);
  if (cb.status !== 302) return null;
  const setCookie = cb.headers['set-cookie']?.[0] ?? '';
  const m = setCookie.match(/lsi_sess=([^;]+)/);
  return m ? m[1]! : null;
}

describe('OIDC interne — parcours nominal', () => {
  test('/login redirige vers l’IdP', async () => {
    const res = await request(app.getHttpServer()).get('/v1/auth/login').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('idp.example/authorize');
  });

  test('un employé interne connu ouvre une session et accède', async () => {
    const sid = await loginAs(fx.amEmail);
    expect(sid).toBeTruthy();
    const me = await request(app.getHttpServer()).get('/v1/contracts').set('Cookie', `lsi_sess=${sid}`);
    expect(me.status).toBe(200);
  });

  test('le scope résolu correspond au portefeuille de l’employé', async () => {
    const sid = await loginAs(fx.amEmail);
    const list = await request(app.getHttpServer()).get('/v1/contracts').set('Cookie', `lsi_sess=${sid}`);
    const ids = list.body.data.map((c: any) => c.id);
    // L'AM ne voit que customerA (son portefeuille), pas customerB.
    expect(ids).toContain(fx.customerA.contractId);
    expect(ids).not.toContain(fx.customerB.contractId);
  });
});

describe('OIDC interne — sécurité', () => {
  test('un callback sans state connu est refusé (anti-CSRF)', async () => {
    oidc.setNextIdentity({ email: fx.amEmail, sub: 's', name: 'x' });
    const res = await request(app.getHttpServer())
      .get(`/v1/auth/callback?state=${uuidv7()}&code=abc`)
      .redirects(0);
    // Redirigé vers /login?error=auth_failed, pas de session.
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=auth_failed');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('un jeton OIDC invalide → pas de session', async () => {
    const agent = request.agent(app.getHttpServer());
    const start = await agent.get('/v1/auth/login').redirects(0);
    const state = oidc.requests[oidc.requests.length - 1]!.state;
    oidc.failNext();
    const cb = await agent.get(`/v1/auth/callback?state=${state}&code=abc`).redirects(0);
    expect(cb.headers.location).toContain('error=auth_failed');
  });

  test('un CLIENT ne peut PAS se connecter par OIDC (interne seulement)', async () => {
    // Même si l'IdP renvoie l'email d'un compte CLIENT, le callback refuse.
    const sid = await loginAs(fx.customerA.clientEmail);
    expect(sid).toBeNull();
  });

  test('un email inconnu de l’IdP → pas de session', async () => {
    const sid = await loginAs('inconnu@lsi.fr');
    expect(sid).toBeNull();
  });

  test('un state est à usage unique', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.get('/v1/auth/login').redirects(0);
    const state = oidc.requests[oidc.requests.length - 1]!.state;
    oidc.setNextIdentity({ email: fx.amEmail, sub: 's', name: 'x' });
    await agent.get(`/v1/auth/callback?state=${state}&code=abc`).redirects(0); // 1er : OK
    const second = await agent.get(`/v1/auth/callback?state=${state}&code=abc`).redirects(0);
    expect(second.headers.location).toContain('error=auth_failed'); // rejeu refusé
  });
});
