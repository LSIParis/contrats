import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // En dev, l'API tourne sur 3001 ; on proxifie /v1 pour rester same-origin.
    proxy: { '/v1': 'http://localhost:3001', '/health': 'http://localhost:3001' },
  },
  build: { outDir: 'dist' },
});
