import { defineConfig } from 'vite';

// base: './' -> relative asset URLs. Works identically at '/', at '/static-game/'
// (GitHub Pages project sites) and over file://, with no env branching.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
  },
  server: {
    host: true,
  },
});
