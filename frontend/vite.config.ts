import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The web app shares the business rules' constants and types with the API (@domain = backend/src/domain).
// In development /api is proxied to the API server (backend: npm run dev); in Docker nginx does the same.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@domain': fileURLToPath(new URL('../backend/src/domain', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: { port: 5173, proxy: { '/api': process.env.API_URL ?? 'http://localhost:4000' }, fs: { allow: ['..'] } },
});
