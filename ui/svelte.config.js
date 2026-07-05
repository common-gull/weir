import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Fully client-rendered SPA: adapter-static with a single `index.html` fallback (see
// routes/+layout.ts, which turns SSR/prerender off). The Bun API server serves the emitted
// build/ directory and falls back to index.html for deep links like /runs/:id — so the app
// stays a single binary; SvelteKit is only the client router here, never a server.
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ fallback: 'index.html' }),
  },
};
