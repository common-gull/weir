// Client-only SPA: no server-side rendering, nothing prerendered. Every route resolves in the
// browser against the Bun engine's /api. adapter-static (svelte.config.js) emits a single
// index.html fallback that the engine serves for deep links.
export const ssr = false;
export const prerender = false;
