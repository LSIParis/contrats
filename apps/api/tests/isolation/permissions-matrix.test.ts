import { describe, test, expect, beforeAll } from 'vitest';
import { createTestApp } from '../support/app.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService, type RoleCode } from '../../src/auth/session.service.js';
import { ALL_ROLES, PERMISSIONS, can, type Action } from '../../src/auth/permissions.js';
import { adminScope, clientScope, internalScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

/**
 * Matrice rôle × action, vérifiée CÔTÉ API. (brief §9)
 *
 * Pour chaque rôle et chaque action, on appelle une route représentative et
 * on vérifie : 403 ⇔ le rôle n'a pas le droit. Les routes visent un contrat
 * inexistant quand c'est possible : un rôle AUTORISÉ obtient alors 404 (ou
 * 200 sur une liste), jamais 403 — ce qui distingue le refus de droit d'un
 * refus d'état ou de scope.
 */
let app: INestApplication;
let fx: TwoCustomerFixture;
const ghost = uuidv7();

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = await createTestApp(mod);
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  for (const role of ALL_ROLES) {
    const isClient = role.startsWith('CLIENT_');
    await s.put({
      sessionId: `pm-${role}`,
      userId: isClient ? fx.customerA.clientUserId : fx.adminUserId,
      tenantId: fx.tenantId,
      roles: [role],
      scope: isClient
        ? clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId)
        : ['MSP_ADMIN', 'LEGAL_REVIEWER', 'INTERNAL_SIGNATORY'].includes(role)
          ? adminScope(fx.tenantId, fx.adminUserId)
          : internalScope(fx.tenantId, [fx.customerA.id], fx.adminUserId),
    });
  }
});

type Probe = { method: 'get' | 'post' | 'put'; path: () => string; body?: unknown };

const PROBES: Partial<Record<Action, Probe>> = {
  'users.manage': { method: 'get', path: () => '/v1/users' },
  'audit.read': { method: 'get', path: () => '/v1/audit' },
  'tenant.configure': { method: 'get', path: () => '/v1/admin/settings' },
  'webhooks.manage': { method: 'get', path: () => '/v1/admin/webhooks' },
  'templates.manage': { method: 'get', path: () => '/v1/templates' },
  'customers.write': {
    method: 'post', path: () => `/v1/customers/${ghost}/contacts`,
    body: { firstName: 'A', lastName: 'B', email: 'a.b@example.fr' },
  },
  'contracts.write': { method: 'post', path: () => `/v1/contracts/${ghost}/submit` },
  'contracts.review': { method: 'post', path: () => `/v1/contracts/${ghost}/approve` },
  'contracts.lifecycle': { method: 'post', path: () => `/v1/contracts/${ghost}/archive` },
  'contracts.sendForSignature': { method: 'post', path: () => `/v1/contracts/${ghost}/signature/remind` },
  'contracts.read': { method: 'get', path: () => '/v1/feature-flags' },
  'comments.internal': { method: 'get', path: () => `/v1/contracts/${ghost}/comments` },
  // --- Tarification (lot 3) : un rôle autorisé obtient 404 (contrat, série ou règle inexistants).
  'pricing.write': {
    method: 'post', path: () => `/v1/contracts/${ghost}/pricing/schedules`,
    body: { validFrom: '2026-01-01', lines: [{ lineKey: 'l', articleCode: 'A', label: 'A', unit: 'u', kind: 'UNIT', mode: 'MANUAL', vatRatePercent: '20', unitPrice: '1' }] },
  },
  'pricing.simulate': { method: 'post', path: () => `/v1/contracts/${ghost}/pricing/simulate`, body: { at: '2026-01-01', changes: {} } },
  'pricing.override.approve': { method: 'post', path: () => `/v1/contracts/${ghost}/pricing/overrides/${ghost}/approve` },
  'pricing.indexes.manage': { method: 'post', path: () => '/v1/price-indexes/FANTOME/values', body: { period: '2026-01', value: '1', publishedAt: '2026-02-01' } },
  'pricing.rules.manage': { method: 'put', path: () => '/v1/pricing-rules/fantome', body: { label: 'x' } },
};

describe('matrice rôle × action (API)', () => {
  for (const [action, probe] of Object.entries(PROBES) as [Action, Probe][]) {
    for (const role of ALL_ROLES) {
      const allowed = can([role], action);
      test(`${role} ${allowed ? 'PEUT' : 'NE PEUT PAS'} ${action}`, async () => {
        let req = request(app.getHttpServer())[probe.method](probe.path()).set('x-lsi-session', `pm-${role}`);
        if (probe.body) req = req.send(probe.body as object);
        const res = await req;
        if (allowed) expect(res.status, JSON.stringify(res.body)).not.toBe(403);
        else expect(res.status).toBe(403);
      });
    }
  }
});

/**
 * Invariants écrits À LA MAIN, indépendamment de PERMISSIONS : sans eux, le
 * test ci-dessus serait tautologique (une matrice fausse se validerait
 * elle-même).
 */
describe('invariants de sécurité de la matrice', () => {
  const writeActions = (Object.keys(PERMISSIONS) as Action[]).filter(
    (a) => !['contracts.read', 'comments.internal', 'portal.read'].includes(a),
  );

  test('READER et TECHNICIAN n’écrivent rien (hors commentaire interne historique)', () => {
    for (const a of writeActions) {
      expect(can(['READER'], a), `READER ${a}`).toBe(false);
      if (a !== 'comments.share') expect(can(['TECHNICIAN'], a), `TECHNICIAN ${a}`).toBe(false);
    }
  });

  test('un rôle client n’a aucun droit interne', () => {
    for (const role of ['CLIENT_SIGNER', 'CLIENT_VIEWER'] as RoleCode[]) {
      for (const a of Object.keys(PERMISSIONS) as Action[]) {
        if (!a.startsWith('portal.')) expect(can([role], a), `${role} ${a}`).toBe(false);
      }
    }
  });

  test('le signataire interne signe mais ne valide ni ne rédige', () => {
    expect(can(['INTERNAL_SIGNATORY'], 'contracts.signInternal')).toBe(true);
    expect(can(['INTERNAL_SIGNATORY'], 'contracts.review')).toBe(false);
    expect(can(['INTERNAL_SIGNATORY'], 'contracts.write')).toBe(false);
  });

  test('le commercial rédige et envoie mais ne se valide pas lui-même', () => {
    expect(can(['ACCOUNT_MANAGER'], 'contracts.write')).toBe(true);
    expect(can(['ACCOUNT_MANAGER'], 'contracts.sendForSignature')).toBe(true);
    expect(can(['ACCOUNT_MANAGER'], 'contracts.review')).toBe(false);
    expect(can(['ACCOUNT_MANAGER'], 'imports.validate')).toBe(false);
    expect(can(['ACCOUNT_MANAGER'], 'clauses.validateAi')).toBe(false);
  });

  test('le commercial saisit une dérogation mais ne la valide pas (quatre yeux)', () => {
    expect(can(['ACCOUNT_MANAGER'], 'pricing.write')).toBe(true);
    expect(can(['ACCOUNT_MANAGER'], 'pricing.override.approve')).toBe(false);
    expect(can(['READER'], 'pricing.simulate')).toBe(false);
  });

  test('seul l’admin paramètre le tenant, gère les clients API et les webhooks', () => {
    for (const role of ALL_ROLES.filter((r) => r !== 'MSP_ADMIN')) {
      expect(can([role], 'tenant.configure')).toBe(false);
      expect(can([role], 'apiClients.manage')).toBe(false);
      expect(can([role], 'webhooks.manage')).toBe(false);
    }
  });
});
