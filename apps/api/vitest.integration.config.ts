import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * Tests d'intégration : contre les VRAIS conteneurs du docker-compose.
 *
 * Séparés de la suite unitaire, et c'est délibéré :
 *   - ils exigent `docker compose up -d`
 *   - ils sont lents (Chromium, DocuSeal)
 *   - ils testent que nos APPELS sont corrects, pas notre logique
 *
 * Les mélanger rendrait la suite principale dépendante d'une pile complète,
 * et un développeur qui corrige une règle métier n'a pas à démarrer DocuSeal.
 *
 * Pas de globalSetup Testcontainers ici : ces tests parlent au compose.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['tests/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Les adaptateurs ont pour DÉFAUT les noms d'hôtes du réseau Docker
    // (`http://gotenberg:3000`) — corrects quand l'API tourne dans le
    // compose, injoignables depuis l'hôte.
    //
    // Ces tests s'exécutent SUR L'HÔTE et parlent aux ports publiés. On fixe
    // donc les URL ici, en un seul endroit : les laisser aux défauts de
    // chaque adaptateur, c'était garantir la divergence.
    env: {
      GOTENBERG_URL: process.env.GOTENBERG_URL ?? 'http://localhost:3003',
      DOCUSEAL_URL: process.env.DOCUSEAL_URL ?? 'http://localhost:3002/api',
    },
  },
});
