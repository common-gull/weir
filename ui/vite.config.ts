import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 5199,
    // In dev the SvelteKit app is served by Vite; proxy /api (and its SSE stream) to the Bun engine.
    proxy: {
      '/api': { target: 'http://localhost:8099', changeOrigin: true, ws: false },
    },
  },
});
