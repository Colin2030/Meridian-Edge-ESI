import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build fully self-contained static assets (air-gap: no CDN, no external calls).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4100',
    },
  },
});
