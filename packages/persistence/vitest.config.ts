import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Un conteneur PostgreSQL est démarré une fois pour toute la suite.
    globalSetup: ['./tests/support/global-setup.ts'],
    // Les tests d'isolation manipulent des GUC de session : ils doivent
    // s'exécuter en série. Du parallélisme ici produirait des faux verts.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
