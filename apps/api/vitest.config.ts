import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  // NestJS s'appuie sur les décorateurs et les métadonnées de type émises
  // par le compilateur. esbuild (le défaut de Vitest) ne les émet pas :
  // sans swc, l'injection de dépendances échoue à l'exécution.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globalSetup: ['./tests/support/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
