import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { builtinModules } from 'node:module';
import ts from 'typescript';

const root = path.resolve('.');
const allowed = new Set(['react', 'react-dom', 'markdown-it', 'zod', 'electron']);
const builtins = new Set(builtinModules.flatMap((x) => [x, 'node:' + x]));
function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const sources = walk(path.join(root, 'src'));
const errors = [];
for (const file of sources.filter((f) => /\.(ts|tsx)$/.test(f))) {
  const doc = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  function check(spec) {
    if (spec.startsWith('.')) {
      const full = path.resolve(path.dirname(file), spec);
      if (!full.startsWith(root + path.sep))
        errors.push(`Out-of-project import: ${file} -> ${spec}`);
    } else if (
      !builtins.has(spec) &&
      !allowed.has(
        spec
          .split('/')
          .slice(0, spec.startsWith('@') ? 2 : 1)
          .join('/'),
      )
    )
      errors.push(`Unapproved application dependency: ${file} -> ${spec}`);
  }
  function visit(n) {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    )
      check(n.moduleSpecifier.text);
    if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
    ) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteral(arg)) check(arg.text);
      else errors.push(`Dynamic module source: ${file}`);
    }
    ts.forEachChild(n, visit);
  }
  visit(doc);
}
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
for (const name of Object.keys(pkg.dependencies))
  if (!allowed.has(name)) errors.push('Unexpected dependency: ' + name);
const original = 'F:/CAgent/.codex/rewrite-spec/original-state.json';
let originalCount = null;
if (fs.existsSync(original)) {
  const baseline = JSON.parse(fs.readFileSync(original, 'utf8'));
  originalCount = Object.keys(baseline.hashes).length;
  const codeHashes = new Set(
    sources
      .filter((f) => /\.(ts|tsx|css)$/.test(f))
      .map((f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')),
  );
  for (const [rel, expected] of Object.entries(baseline.hashes)) {
    const file = path.join('F:/CAgent', rel);
    const actual = fs.existsSync(file)
      ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      : null;
    if (actual !== expected) errors.push('Original tracked file changed: ' + rel);
    if (actual && codeHashes.has(actual)) errors.push('Byte-identical reference file: ' + rel);
  }
}
const report = {
  date: new Date().toISOString(),
  applicationSourceFiles: sources.length,
  allowedRuntimePackages: [...allowed],
  legacyTrackedFilesChecked: originalCount,
  originalSnapshotAvailable: originalCount !== null,
  violations: errors,
  limits:
    'Checks imports, direct dependencies, original tracked hashes and whole-file identity. It is not a copyright or similarity determination.',
};
fs.mkdirSync('.artifacts', { recursive: true });
fs.writeFileSync('.artifacts/independence-check.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
