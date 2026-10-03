const path = require('node:path');
const { createRequire } = require('node:module');

// pnpm's optional native packages are installed but not discovered by this builder version.
// Resolve the approved parsers' existing dependency graph instead of adding new dependencies.
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Native parser packaging is currently verified only on Windows x64.');
const sharpRequire = createRequire(require.resolve('sharp'));
const pdfRequire = createRequire(require.resolve('pdfjs-dist/package.json'));
const canvasRequire = createRequire(pdfRequire.resolve('@napi-rs/canvas'));
const packages = [
  ['@img/sharp-win32-x64', path.dirname(sharpRequire.resolve('@img/sharp-win32-x64/sharp.node'))],
  ['@napi-rs/canvas', path.dirname(pdfRequire.resolve('@napi-rs/canvas/package.json'))],
  [
    '@napi-rs/canvas-win32-x64-msvc',
    path.dirname(canvasRequire.resolve('@napi-rs/canvas-win32-x64-msvc/package.json')),
  ],
];

module.exports = {
  files: [
    'dist/**/*',
    'package.json',
    ...packages.map(([name, from]) => ({ from, to: `node_modules/${name}`, filter: ['**/*'] })),
  ],
};
