import { defineConfig } from 'vitest/config';

/**
 * Tests du seed des modèles de proposition (annexe C) : fichiers, cas de
 * contrôle, moteur, idempotence en mémoire. AUCUNE base : pas de conteneur
 * PostgreSQL à démarrer (`pnpm --filter @lsi/persistence test:seed`).
 * La suite complète (`vitest run`) les exécute aussi.
 */
export default defineConfig({
  test: {
    include: ['test/seed/**/*.test.ts'],
  },
});
