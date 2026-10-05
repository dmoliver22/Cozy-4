import { defineConfig } from 'vite';

// Relative base so the build runs from any folder (itch.io, a sub-path, a zip).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
  server: { host: true },
});
