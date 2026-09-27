import { defineConfig } from 'vite';
export default defineConfig({
  root: 'src/ui',
  base: '/',
  // Never inline assets as data: URLs; the page's CSP only allows same-origin fonts and images.
  build: { outDir: '../../dist/ui', emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0 },
});
