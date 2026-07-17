import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  // NestJS s'appuie sur les décorateurs et les métadonnées de type émises
  // par le compilateur. esbuild (le défaut de Vitest) ne les émet pas :
  // sans swc, l'injection de dépendances échoue à l'exécution.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globalSetup: ['./tests/support/global-setup.ts'],
    // Les tests d'intégration ont leur propre config : ils parlent au
    // docker-compose, pas à Testcontainers, et leurs URL pointent vers les
    // ports publiés sur l'hôte. Les laisser ici les ferait tourner avec les
    // mauvais défauts — et rendrait la suite principale dépendante d'une
    // pile complète, alors qu'un développeur qui corrige une règle métier
    // n'a pas à démarrer DocuSeal.
    //
    // `pnpm test:integration` les exécute.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/integration/**'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
