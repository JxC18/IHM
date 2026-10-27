import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // En mode "http", le front parle à l'API FastAPI via ce proxy.
    proxy: { '/api': 'http://localhost:8000' },
  },
});
