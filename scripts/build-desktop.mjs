import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
await build({
  entryPoints: ['src/desktop/main.ts'],
  outdir: 'dist/desktop',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  external: ['electron', 'electron-updater', 'node:*'],
  target: 'node24',
  banner: { js: 'const cagentModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
  define: { 'import.meta.url': 'cagentModuleUrl' },
});
await build({
  entryPoints: ['src/server/attachment-worker.ts'],
  outfile: 'dist/desktop/attachment-worker.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['node:*', 'sharp', 'pdfjs-dist', 'mammoth'],
  target: 'node24',
});
await copyFile('src/ui/assets/assistant-portrait.png', 'dist/desktop/app-icon.png');
await build({
  entryPoints: ['src/desktop/preload.ts'],
  outdir: 'dist/desktop',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  external: ['electron'],
  target: 'node24',
});
