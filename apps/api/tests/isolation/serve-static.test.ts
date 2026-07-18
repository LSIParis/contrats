import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppModule } from '../../src/app.module.js';

// `apps/web/dist` (le chemin lu par ServeStaticModule, cf. app.module.ts) —
// on y dépose un index.html minimal pour que le repli SPA ait quelque chose
// à servir, sans dépendre d'un build préalable de apps/web.
//
// Résolu depuis `import.meta.url` de CE fichier de test, PAS depuis
// `process.cwd()` : app.module.ts calcule désormais son `rootPath` de la
// même façon (relatif à son propre `import.meta.url`), justement pour être
// indépendant du cwd du process (cf. commentaire dans app.module.ts —
// `pnpm --filter <pkg> exec` déplace le cwd vers le dossier du package en
// prod). Ce test doit viser le MÊME dossier réel que le module, quel que
// soit le cwd depuis lequel vitest est lancé.
// Ce fichier vit en `apps/api/tests/isolation/` : 3 niveaux au-dessus
// (isolation → tests → api) mène à `apps/`, d'où `apps/web/dist`.
const distDir = fileURLToPath(new URL('../../../web/dist', import.meta.url));
const indexPath = fileURLToPath(new URL('../../../web/dist/index.html', import.meta.url));
const indexPreexisted = existsSync(indexPath);
// Un vrai build Vite peut déjà être présent (apps/web/dist/index.html) : on
// ne le détruit JAMAIS. On sauvegarde son contenu pour le restaurer tel
// quel après le test, plutôt que de le remplacer définitivement par notre
// marqueur.
const originalIndexContent = indexPreexisted ? readFileSync(indexPath, 'utf8') : null;

// Le plus haut ancêtre absent qu'il faudra créer (ex: `apps/web` voire
// `apps` si on tourne depuis apps/api) — c'est celui-là (et lui seul) qu'on
// supprimera au nettoyage, pour ne pas laisser de dossiers vides traîner.
let firstMissingAncestor: string | null = null;
for (let dir = distDir; !existsSync(dir); dir = dirname(dir)) {
  firstMissingAncestor = dir;
}
const MARKER = 'lsi-spa-fallback-marker';

let app: INestApplication;

beforeAll(async () => {
  mkdirSync(distDir, { recursive: true });
  writeFileSync(indexPath, `<!doctype html><html><body>${MARKER}</body></html>`);

  // NestFactory.create() = le vrai chemin de bootstrap (celui de src/main.ts),
  // PAS Test.createTestingModule(...).createNestApplication(). Ce dernier ne
  // garantit pas que le loader Express du ServeStaticModule s'enregistre
  // réellement sur l'adaptateur HTTP : le repli SPA pourrait rester inerte
  // et un test qui l'exercerait passerait sans rien prouver. On vérifie
  // d'ailleurs explicitement, ci-dessous, que le repli est bien actif avant
  // de s'appuyer dessus pour prouver l'invariant.
  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
});

afterAll(async () => {
  await app.close();
  if (firstMissingAncestor) {
    rmSync(firstMissingAncestor, { recursive: true, force: true });
  } else if (originalIndexContent !== null) {
    writeFileSync(indexPath, originalIndexContent);
  } else {
    rmSync(indexPath, { force: true });
  }
});

describe('service statique : /v1 et /health ne sont JAMAIS capturés par le repli SPA', () => {
  test('pré-requis : le repli SPA est bien actif (sinon rien de ce qui suit ne prouve quoi que ce soit)', async () => {
    const res = await request(app.getHttpServer()).get('/some/spa/route');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain(MARKER);
  });

  test('INVARIANT : une route /v1 inconnue rend 404 JSON, jamais 200 HTML (le bug historique)', async () => {
    const res = await request(app.getHttpServer()).get('/v1/this-route-does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-type']).not.toMatch(/text\/html/);
    expect(res.text).not.toContain(MARKER);
    expect(res.body).toMatchObject({ statusCode: 404 });
  });

  test('/v1/contracts (sans session) reste gardé par ScopeGuard : 401, pas le repli SPA', async () => {
    const res = await request(app.getHttpServer()).get('/v1/contracts');
    expect(res.status).toBe(401);
    expect(res.text).not.toContain(MARKER);
  });

  test('/health reste public et JSON', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('une route SPA non-/v1 sert bien index.html (le repli fonctionne toujours pour le front)', async () => {
    const res = await request(app.getHttpServer()).get('/dashboard/contracts/123');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain(MARKER);
  });
});
