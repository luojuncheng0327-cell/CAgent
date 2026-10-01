import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
await build({
  entryPoints: ['src/desktop/main.ts'],
  outdir: 'dist/desktop',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  external: ['electron', 'node:*'],
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
