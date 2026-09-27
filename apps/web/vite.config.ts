import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // En dev, l'API tourne sur 3001 ; on proxifie /v1 pour rester same-origin.
    proxy: { '/v1': 'http://localhost:3001', '/api': 'http://localhost:3001', '/health': 'http://localhost:3001' },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Bibliothèques en morceaux séparés : mises en cache d'une version à
        // l'autre, l'application seule change à chaque livraison.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\/](@tiptap|prosemirror-[^\/]+|orderedmap|rope-sequence|w3c-keyname)[\/]/.test(id)) return 'vendor-editor';
          if (/[\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run)[\/]/.test(id)) return 'vendor-react';
          return 'vendor';
        },
      },
    },
  },
});
