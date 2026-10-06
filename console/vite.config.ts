import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The console is served by the Hoolam server at /console. In development, `npm run console:dev` proxies the API.
export default defineConfig({
  root: __dirname,
  base: '/console/',
  plugins: [react()],
  build: { outDir: '../dist-console', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  server: { port: 5173, proxy: { '/console/api': 'http://localhost:3000' } },
});
