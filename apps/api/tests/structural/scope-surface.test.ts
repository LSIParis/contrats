import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module.js';
import { listRoutes, type RouteInfo } from '../support/introspect.js';
import { IS_PUBLIC_KEY } from '../../src/auth/public.decorator.js';
import { Reflector } from '@nestjs/core';

let app: INestApplication;
let routes: RouteInfo[];

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
  routes = listRoutes(app);
});

/**
 * Les garanties structurelles de la surface HTTP. (§16.4-D)
 *
 * Comme les tests structurels de la base : ils rendent le cloisonnement
 * impossible à OUBLIER. Une route ajoutée sans guard, ou un DTO qui accepte
 * un tenant_id, casse la CI le jour même.
 *
 * C'est de l'automatisation de revue de code. La revue humaine ne tient pas
 * cette promesse sur trois ans.
 */
describe('§16.4-D — toute route est gardée ou explicitement publique', () => {
  test('il y a des routes à vérifier', () => {
    // Sans cette garde, une erreur d'introspection rendrait tous les tests
    // ci-dessous verts en n'examinant rien.
    expect(routes.length).toBeGreaterThan(0);
  });

  test('aucune route n’est accessible sans guard ni @Public() délibéré', () => {
    const reflector = app.get(Reflector);
    const unguarded: string[] = [];

    for (const r of routes) {
      const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [r.handler, r.controller]);
      // Le guard global couvre TOUT. La seule échappatoire est @Public(),
      // qui est cherchable dans le dépôt et refusable en revue.
      if (isPublic === undefined) continue; // couvert par le guard global
      if (isPublic === true) {
        // Une route publique est légitime (webhook, healthcheck), mais elle
        // doit être rare et intentionnelle.
        unguarded.push(`${r.method} ${r.path}`);
      }
    }

    // On fige la liste : ajouter une route publique devient une décision
    // explicite qui casse ce test et exige de le mettre à jour.
    expect(unguarded.sort()).toEqual([
      'GET /health',
      'GET /v1/portal/auth/verify',
      'POST /v1/portal/auth/logout',
      'POST /v1/portal/auth/request-link',
      'POST /v1/webhooks/docuseal',
    ]);
  });
});

describe('§16.4-D / RM-29 — aucun DTO d’entrée n’accepte un identifiant de scope', () => {
  /**
   * LE test qui rend RM-29 vérifiable.
   *
   * tenant_id ne doit JAMAIS venir du réseau. S'il apparaît dans un DTO
   * d'entrée, un appelant choisit son propre scope — et tout le dispositif
   * (guard, RLS, FK composites) devient décoratif.
   *
   * customer_id est un cas subtil : il est LÉGITIME en entrée de POST
   * /contracts (« pour quel client ? »), mais il y est un FILTRE vérifié
   * contre le scope, jamais le scope lui-même. tenantId, lui, n'a aucun
   * usage légitime en entrée.
   */
  test('aucun DTO ne déclare tenantId', async () => {
    const { collectDtoProperties } = await import('../support/introspect.js');
    const offenders = (await collectDtoProperties()).filter((p) =>
      /^tenant_?id$/i.test(p.property),
    );
    expect(
      offenders.map((o) => `${o.dto}.${o.property}`),
      'un DTO d’entrée accepte tenantId : le scope viendrait du réseau (RM-29)',
    ).toEqual([]);
  });

  test('aucun DTO ne déclare allCustomers ou customerIds', async () => {
    const { collectDtoProperties } = await import('../support/introspect.js');
    const offenders = (await collectDtoProperties()).filter((p) =>
      /^(all_?customers|customer_?ids|scope|actor_?kind)$/i.test(p.property),
    );
    expect(offenders.map((o) => `${o.dto}.${o.property}`)).toEqual([]);
  });
});
