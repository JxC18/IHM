import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Démo autonome en un seul fichier : polices intégrées en base64 (VITE_INLINE_ASSETS=1).
  build: process.env.VITE_INLINE_ASSETS ? { assetsInlineLimit: 1024 * 1024 } : {},
  server: {
    port: 5173,
    // En mode "http", le front parle à l'API FastAPI via ce proxy (préfixe /api retiré, comme en production).
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://localhost:8000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
