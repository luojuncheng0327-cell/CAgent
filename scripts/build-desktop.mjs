import { build } from 'esbuild';
await build({entryPoints:['src/desktop/main.ts'],outdir:'dist/desktop',bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},external:['electron','node:*'],target:'node24'});
await build({entryPoints:['src/desktop/preload.ts'],outdir:'dist/desktop',bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},external:['electron'],target:'node24'});
