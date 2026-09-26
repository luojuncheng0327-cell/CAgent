#!/usr/bin/env node
/**
 * compute-cli-closure.mjs — CLI distribution/runtime closure census
 *
 * Generates `build/cli-runtime-closure.json`: the mechanical answer to
 * "which repo files (plus third-party runtime files) does the standalone
 * `hana` CLI + its spawned server composition need to distribute and run".
 * The open/closed source split for this project is defined as "everything
 * required to distribute and run the CLI", not as a single static-import
 * walk from one entrypoint -- this script computes that closure so the
 * definition is a generated fact, not a manually maintained list.
 *
 * Why a single import walk from cli/entry.ts is not enough: the CLI
 * launches the server through cli/server-runner.ts's spawnServerForeground
 * / startLocalServerAndWait by PATH + CHILD PROCESS (see
 * resolveServerSpawnSpec), never by statically importing server/index.ts.
 * A one-root walk would therefore produce a false, unusably small cut.
 *
 * Four evidence sources are merged (see CLOSURE_ROOTS below for the exact
 * roots and RUNTIME_ASSETS for the fourth):
 *   1. the CLI's own static/dynamic source module graph (esbuild metafile,
 *      rooted at cli/entry.ts);
 *   2. declared dynamic process/build roots -- server/index.ts (the server
 *      bootstrap cli/server-runner.ts spawns by path in source mode, and
 *      the build entry scripts/build-server.mjs feeds to
 *      vite.config.server.js) and server/bootstrap.ts (the packaged-mode
 *      spawn target scripts/build-server.mjs copies verbatim) -- each root
 *      gets its own source module graph too;
 *   3. @vercel/nft traces of the compiled bundles for the CLI and server
 *      roots, for bundle externals / third-party runtime files -- same nft
 *      usage pattern as the server build's pruneServerNodeModulesViaNft()
 *      in scripts/build-server-phases.mjs (read-only precedent, not
 *      modified here). Target-built `.node` addon binaries are excluded
 *      because the server build installs them with the target
 *      server runtime; their local presence depends on npm install-script
 *      policy and is not a stable repository-closure input;
 *   4. an explicit, evidence-backed inventory of non-import runtime assets
 *      (package.json, lib/ model + identity/AGENTS.md template data) that
 *      core code reads via fs.readFileSync/path.join rather than
 *      import/require, so no static graph walk or nft trace can find them.
 *
 * Tool choice for sources 1/2: a bare `nodeFileTrace` pointed directly at
 * the TS entries (cli/entry.ts, server/index.ts) fails -- its acorn parser
 * cannot parse TypeScript syntax ("Failed to parse ... as module:
 * Unexpected token") and the resulting fileList only contains the entry
 * files themselves. esbuild is already a devDependency (package.json), so
 * its `metafile` output (bundle: true, write: false, packages: "external")
 * is used for the source module graph instead: it strips TypeScript,
 * resolves the real internal import graph, and leaves every bare
 * (npm-package) specifier as `external` so it does not try to bundle
 * third-party code. nft is reserved for source 3, where it is pointed at
 * an esbuild-compiled bundle (TypeScript already stripped) -- matching
 * build-server.mjs's own nft usage, which also traces compiled output
 * rather than TS source.
 *
 * nft safety note: nodeFileTrace's default `analysis.emitGlobs: true`
 * heuristic will, when it cannot statically resolve a require()/import()
 * argument, fall back to speculative glob-style directory search. In this
 * repository that fallback is dangerous -- there are multiple git
 * worktrees nested under .claude/worktrees/ plus large unrelated caches
 * under .cache/, and the heuristic was empirically observed pulling in
 * unrelated files from a sibling worktree and a Swift build cache purely
 * because their relative path fragments happened to match an unresolvable
 * string it found in the bundle (esbuild's own CJS-interop module-wrapper
 * keys, which are *not* real import/require calls). This generator
 * disables `emitGlobs` and adds explicit `ignore` patterns for those
 * directories as defense in depth. The tradeoff: a handful of third-party
 * packages that legitimately load "every file in this directory" at
 * runtime (e.g. locale packs) via a non-literal require will not have
 * those directory contents traced. That is judged acceptable here because
 * this script produces a classification census, not build-server.mjs's
 * shippable, size-trimmed artifact -- build-server.mjs's own nft call
 * (default emitGlobs, run from an isolated dist-server/* output directory
 * with no sibling worktrees nearby) remains the source of truth for what
 * actually ships.
 *
 * Fail-closed behaviors (never silently shrink the closure):
 *   - a declared root or runtime asset that does not exist on disk is a
 *     hard error;
 *   - any `import()`/`require()`/child_process spawn-family call whose
 *     first argument is not a plain string literal is a hard error unless
 *     it exactly matches an entry in DYNAMIC_CALL_ALLOWLIST (file + callee
 *     + argument text) -- matching is by call-site text, not line number,
 *     so unrelated edits elsewhere in a file cannot silently invalidate an
 *     allowlist entry, but a changed call site will fail closed until a
 *     human re-reasons about it;
 *   - every allowlist entry must also be *matched* by a real scan hit, so
 *     a call site that is refactored away leaves no stale, unverifiable
 *     allowlist entry behind.
 *
 * Usage: `node scripts/compute-cli-closure.mjs` regenerates
 * build/cli-runtime-closure.json and build/open-boundary-baseline.json in
 * place. Re-running with an unchanged tree produces byte-identical output
 * (all lists are sorted; no timestamps are embedded).
 */
import fs from "node:fs";
import { optionalServerDependencyRoots } from "./optional-server-dependencies.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { build as esbuildBuild } from "esbuild";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");
const GENERATOR_ID = "scripts/compute-cli-closure.mjs";
const CLOSURE_VERSION = 1;

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function repoRelative(rootDir, absolutePath) {
  return toPosix(path.relative(rootDir, absolutePath));
}

// ---------------------------------------------------------------------------
// Declared roots (evidence sources 1 + 2, plus the nft half of source 3).
// ---------------------------------------------------------------------------

export const CLOSURE_ROOTS = Object.freeze([
  {
    id: "cli-entry",
    path: "cli/entry.ts",
    inputType: "source-graph",
    reason:
      "Primary CLI entrypoint (package.json \"bin\": {\"hana\": \"cli/entry.ts\"}). "
      + "Root of the CLI's own source module graph.",
  },
  {
    id: "server-bootstrap",
    path: "server/index.ts",
    inputType: "dynamic-process-root",
    reason:
      "Since the route-composition split, this file is the open server composition "
      + "root: it unconditionally, statically imports composition/open-root.ts and "
      + "mounts every open route/WS surface, and no longer imports any closed-product "
      + "route file directly (avatar/cards/character-cards/desk/diary moved to "
      + "composition/full-root.ts, imported only by the closed server/main-full.ts "
      + "entry). No current boot path spawns or imports this file directly anymore -- "
      + "cli/server-runner.ts's resolveServerSpawnSpec() source mode, "
      + "scripts/launch.js, scripts/dev-web.js, and desktop/main.cjs's dev "
      + "HANA_SERVER_ENTRY all target server/main-full.ts instead, and "
      + "vite.config.server.js's build.lib.entry (which scripts/build-server.mjs feeds "
      + "into the packaged bundle) does too. main-full.ts is a thin closed entry that "
      + "statically imports this file's startServer() export plus "
      + "composition/full-root.ts's registerClosedRoutes hook and calls one with the "
      + "other; it is deliberately not declared as a root here because it, and "
      + "everything it pulls in, is closed product wiring, not part of the CLI's open "
      + "redistributable closure. This file remains declared directly (rather than "
      + "relying on reachability through main-full.ts) so its own source graph -- now "
      + "free of closed-product route imports, exactly the open closure this generator "
      + "needs -- keeps being traced independent of that closed wiring; it is also the "
      + "entry a future open-server distribution build is expected to spawn on its "
      + "own.",
  },
  {
    id: "server-process-bootstrap",
    path: "server/bootstrap.ts",
    inputType: "dynamic-process-root",
    reason:
      "cli/server-runner.ts's resolveServerSpawnSpec() spawns this file by path as a "
      + "child process in packaged mode (spec.args includes path.join(packagedRoot, "
      + "\"bootstrap.js\")). scripts/build-server.mjs copies it verbatim (not bundled) "
      + "as the packaged entry. Its own `await import(pathToFileURL(serverEntry).href)` "
      + "is a non-literal dynamic import resolved out-of-band to this same "
      + "server-bootstrap root's compiled output -- see DYNAMIC_CALL_ALLOWLIST.",
  },
  {
    id: "nft-cli-bundle",
    path: "cli/entry.ts",
    inputType: "nft-runtime-trace",
    reason:
      "@vercel/nft trace of an esbuild-compiled bundle of cli/entry.ts (internal repo "
      + "source inlined, npm packages left external) -- bundle externals / runtime "
      + "dependency files for the CLI's own direct npm dependency (ws) and its "
      + "transitive files. Same nft usage pattern as the server build's "
      + "pruneServerNodeModulesViaNft() in scripts/build-server-phases.mjs (read-only "
      + "precedent).",
  },
  {
    id: "nft-server-bundle",
    path: "server/index.ts",
    inputType: "nft-runtime-trace",
    reason:
      "@vercel/nft trace of an esbuild-compiled bundle of server/index.ts (internal "
      + "repo source inlined, npm packages left external) -- bundle externals / "
      + "runtime dependency files for the open server composition's npm dependency "
      + "surface. Since the route-composition split this file no longer imports the "
      + "closed-product route files (see the server-bootstrap root's reason above), so "
      + "this trace no longer pulls in their npm dependencies either -- narrower, and "
      + "more accurate, than before the split. The packaged product bundle "
      + "(vite.config.server.js's build.lib.entry) is compiled from "
      + "server/main-full.ts instead, which statically includes this file plus the "
      + "closed-product routes; that closed bundle is out of scope for this "
      + "open-closure trace by design. Same nft usage pattern as the server build's "
      + "pruneServerNodeModulesViaNft() in scripts/build-server-phases.mjs (read-only "
      + "precedent).",
  },
]);

export const SOURCE_GRAPH_ROOTS = CLOSURE_ROOTS.filter(
  (root) => root.inputType === "source-graph" || root.inputType === "dynamic-process-root",
);
export const NFT_TRACE_ROOTS = CLOSURE_ROOTS.filter((root) => root.inputType === "nft-runtime-trace");

// ---------------------------------------------------------------------------
// Non-literal dynamic import()/require()/child_process spawn allowlist.
//
// Every entry was verified by reading the real call site. Matching is by
// call-site text (file + callee + first-argument source text), not by line
// number, so unrelated edits elsewhere in the file cannot silently break
// the census -- but a changed call site will fail closed until a human
// re-reasons about it. Matching requires BOTH: every non-literal call found
// in the traced source graph must be accounted for here (fail-closed on
// new/unmatched ones), and every entry here must be matched by a real scan
// hit (fail-closed on stale/unused entries).
// ---------------------------------------------------------------------------

export const DYNAMIC_CALL_ALLOWLIST = Object.freeze([
  {
    file: "server/bootstrap.ts",
    callee: "import",
    argText: "pathToFileURL(serverEntry).href",
    reason:
      "serverEntry is HANA_SERVER_ENTRY or a path.join() computed from HANA_ROOT; it "
      + "always resolves to the compiled output of server/main-full.ts (the closed thin "
      + "composition entry that statically imports the server-bootstrap root, "
      + "server/index.ts, plus composition/full-root.ts), not to the server-bootstrap "
      + "root's own compiled output directly. main-full.ts is deliberately not declared "
      + "as a root here -- see the server-bootstrap root's reason above -- but its "
      + "static import of server/index.ts means this dynamic import always terminates "
      + "in code already covered by that explicit declared root.",
  },
  {
    file: "core/fresh-import.ts",
    callee: "import",
    argText: "url.href",
    reason:
      "Generic ESM cache-busting import helper. Its only caller is "
      + "core/plugin-manager.ts, which uses it to load installed plugin code at a "
      + "runtime-computed path. The plugin-hosting machinery itself is already in the "
      + "source graph via core/engine.ts -> core/plugin-manager.ts; the loaded plugin "
      + "payloads are user-installed content, not statically traceable repo source.",
  },
  {
    file: "cli/server-runner.ts",
    callee: "spawn",
    argText: "spec.command",
    reason:
      "The child-process boundary between the CLI and the server it launches -- the "
      + "exact reason this whole census cannot rely on a single static-import walk. "
      + "spec.command/spec.args come from resolveServerSpawnSpec(), which always "
      + "targets either the server-process-bootstrap root (server/bootstrap.ts, packaged "
      + "mode) or server/main-full.ts (source mode) -- the closed thin composition entry "
      + "that statically imports the server-bootstrap root (server/index.ts)'s "
      + "startServer() export plus composition/full-root.ts. main-full.ts is "
      + "deliberately not itself declared as a root (see the server-bootstrap root's "
      + "reason above for why), but both spawn targets ultimately resolve to code "
      + "already covered by the two declared roots above.",
  },
  {
    file: "lib/pi-sdk/search-tools.ts",
    callee: "spawn",
    argText: "command",
    reason:
      "spawnHidden(command, args, options) is a generic child_process.spawn wrapper "
      + "used by the sandboxed find/grep tool implementations; the command name is "
      + "caller-supplied by design (this is generic command-execution machinery), not "
      + "a hidden reference to another part of this repo.",
  },
  {
    file: "lib/pi-sdk/search-tools.ts",
    callee: "spawnSync",
    argText: "command",
    reason:
      "spawnSyncHidden(command, args, options) is the synchronous counterpart of "
      + "spawnHidden above -- same generic execution-machinery rationale.",
  },
  {
    file: "core/mcp/clients/stdio-client.ts",
    callee: "spawn",
    argText: "spawnSpec.command",
    reason:
      "The stdio MCP transport launches the connector process the user configured "
      + "(command plus args stored in the connector config). The target is external "
      + "third-party server software chosen at runtime, not a reference to any module "
      + "in this repo, so it contributes nothing to the source closure.",
  },
  {
    file: "lib/sandbox/exec-helper.ts",
    callee: "spawn",
    argText: "cmd",
    reason:
      "spawnAndStream(cmd, args, opts) is the generic streaming command-execution "
      + "primitive backing the sandboxed shell tool; cmd is caller-supplied by design.",
  },
  {
    file: "lib/sandbox/win32-exec.ts",
    callee: "spawnSync",
    argText: "shell",
    reason:
      "probeShell(shell, args, env) probes a candidate Windows shell binary to "
      + "confirm it starts correctly; shell is one of a small set of candidate "
      + "executables under test, not an import target.",
  },
  {
    file: "lib/sandbox/win32-legacy-migration.ts",
    callee: "spawn",
    argText: "helperPath",
    reason:
      "Spawns a bundled Windows sandbox migration helper native binary at "
      + "helperPath. A native-binary process launch, not a reference to repo JS/TS "
      + "source -- the helper binary itself is a desktop packaging asset, out of this "
      + "CLI closure's scope.",
  },
  {
    file: "lib/shell/shell-utils.ts",
    callee: "spawn",
    argText: "executable",
    reason:
      "isPowerShell7Executable(executable, env, { spawn }) probes a candidate "
      + "PowerShell executable path to confirm it is actually PowerShell 7; "
      + "executable is one of a small set of candidate binaries under test.",
  },
  {
    file: "server/routes/media.ts",
    callee: "execFile",
    argText: "cmd",
    reason:
      "openWithSystem(filePath) branches on process.platform to pick one of a fixed "
      + "small set of OS \"open with default app\" commands (open / cmd start / "
      + "xdg-open); cmd is a local variable holding one of those literals, not an "
      + "import target.",
  },
]);

const SPAWN_FAMILY_NAMES = new Set([
  "spawn",
  "spawnSync",
  "fork",
  "execFile",
  "execFileSync",
  "exec",
  "execSync",
]);

// ---------------------------------------------------------------------------
// Non-import runtime assets (the fourth evidence source). Deliberately
// conservative -- every entry below was verified by grepping for its
// actual fs.readFileSync / path.join() read site; err on the side of
// omission (a missing asset is a gap to fill in a later pass, never a
// guess made here).
// ---------------------------------------------------------------------------

export const RUNTIME_ASSETS = Object.freeze([
  {
    path: "package.json",
    kind: "file",
    reason:
      "server/index.ts's startServer() reads fromRoot(\"package.json\") via fs.readFileSync "
      + "for version display.",
  },
  {
    path: "lib/known-models.json",
    kind: "file",
    reason:
      "shared/known-models.ts's _ensureLoaded() reads fromRoot(\"lib\", \"known-models.json\") "
      + "via readFileSync.",
  },
  {
    path: "lib/known-model-fallbacks.json",
    kind: "file",
    reason:
      "shared/known-models.ts's _ensureLoaded() reads fromRoot(\"lib\", "
      + "\"known-model-fallbacks.json\") via readFileSync.",
  },
  {
    path: "lib/default-models.json",
    kind: "file",
    reason:
      "core/migrate-providers.ts and core/provider-registry.ts both read "
      + "fromRoot(\"lib\", \"default-models.json\") via fs.readFileSync at module load, into "
      + "their _defaultModels constant.",
  },
  {
    path: "lib/config.example.yaml",
    kind: "file",
    reason:
      "core/first-run.ts's seedDefaultAgent() and core/agent-manager.ts's createAgent() read "
      + "path.join(productDir, \"config.example.yaml\") (productDir = fromRoot(\"lib\")).",
  },
  {
    path: "lib/identity.example.md",
    kind: "file",
    reason: "core/persona-source.ts KIND_CONFIG falls back to path.join(productDir, \"identity.example.md\").",
  },
  {
    path: "lib/agents.example.md",
    kind: "file",
    reason: "core/persona-source.ts KIND_CONFIG falls back to path.join(productDir, \"agents.example.md\").",
  },
  {
    path: "lib/identity-templates",
    kind: "directory",
    reason: "core/persona-source.ts KIND_CONFIG reads path.join(productDir, \"identity-templates\", ...).",
  },
  {
    path: "lib/agents-templates",
    kind: "directory",
    reason: "core/persona-source.ts KIND_CONFIG reads path.join(productDir, \"agents-templates\", ...).",
  },
  {
    path: "lib/agents-public-templates",
    kind: "directory",
    reason: "core/first-run.ts and core/agent.ts read path.join(productDir, \"agents-public-templates\", ...).",
  },
  {
    path: "lib/yuan",
    kind: "directory",
    reason:
      "core/agent.ts's _readYuan() reads path.join(this.productDir, \"yuan\", ...) at "
      + "prompt-build time (the identity/personality template data the system prompt draws "
      + "from).",
  },
]);

// ---------------------------------------------------------------------------
// nft defensive ignores (see the module docstring's nft safety note).
// ---------------------------------------------------------------------------

const NFT_IGNORE_PATTERNS = Object.freeze([
  ".git/**",
  ".claude/**",
  "**/.claude/**",
  ".cache/**",
  "**/.cache/**",
  ".docs/**",
  "**/.docs/**",
  "docs/**",
  "**/docs/**",
  ".agents/**",
  "**/.agents/**",
]);

// ---------------------------------------------------------------------------
// Evidence sources 1 + 2: source module graphs via esbuild metafile.
// ---------------------------------------------------------------------------

export async function traceSourceGraph({ rootDir, root }) {
  const entryAbs = path.join(rootDir, root.path);
  if (!fs.existsSync(entryAbs)) {
    throw new Error(
      `[compute-cli-closure] declared root "${root.id}" does not exist on disk: ${root.path}. `
      + "Fail-closed: a missing declared root must not silently shrink the closure.",
    );
  }
  const result = await esbuildBuild({
    entryPoints: [entryAbs],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "external",
    logLevel: "silent",
    absWorkingDir: rootDir,
    outfile: path.join(rootDir, `.compute-cli-closure-unused-${root.id}.js`),
  });
  if (result.warnings.length > 0) {
    const text = result.warnings.map((w) => w.text).join("\n");
    throw new Error(
      `[compute-cli-closure] esbuild reported warnings tracing root "${root.id}" (${root.path}); `
      + `fail-closed rather than risk an incomplete graph:\n${text}`,
    );
  }
  return result.metafile;
}

// ---------------------------------------------------------------------------
// createRequire() local-binding literal requires: a dedicated discovery
// pass. esbuild's metafile tracer above does not follow a require() call
// made through a local variable bound via
// `const someName = createRequire(import.meta.url)` -- it only recognizes
// the ambient/global CommonJS `require`, since a user-defined local
// variable that happens to hold a real require function is, from static
// analysis alone, indistinguishable from any other function call. This
// repository deliberately uses that pattern (see cli/server-runner.ts,
// cli/bundle.ts) to require untyped CommonJS modules from ESM files
// without needing .d.cts declaration files. A literal relative-path
// argument to such a call is therefore invisible to the tracer above and
// must be discovered separately, then fed back in as an additional root so
// its own module graph gets traced too (fixed-point: the newly discovered
// file might itself import/require further files). Without this pass
// these targets would either be completely missing from the closure, or
// only accidentally, partially covered by nft tracing a compiled bundle
// independently of esbuild's own scoping analysis -- an unreliable
// coincidence, not a real fix, and exactly the kind of silent shrinkage
// this generator's fail-closed design is meant to prevent.
// ---------------------------------------------------------------------------

function findCreateRequireLiteralTargets({ relPath, sourceText }) {
  const scriptKind = relPath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : (relPath.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const source = ts.createSourceFile(relPath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const boundNames = new Set();
  const targets = [];

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression;
      if (ts.isIdentifier(callee) && callee.text === "createRequire" && ts.isIdentifier(node.name)) {
        boundNames.add(node.name.text);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && boundNames.has(node.expression.text)) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg) && arg.text.startsWith(".")) {
        targets.push(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return targets;
}

function resolveCreateRequireTarget({ rootDir, importerRelPath, targetText }) {
  const importerDir = path.dirname(importerRelPath);
  const resolved = toPosix(path.normalize(path.join(importerDir, targetText)));
  if (!fs.existsSync(path.join(rootDir, resolved))) {
    throw new Error(
      `[compute-cli-closure] createRequire() literal target "${targetText}" from ${importerRelPath} `
      + `does not resolve to an existing file on disk: ${resolved}. Fail-closed.`,
    );
  }
  return resolved;
}

/**
 * Traces every declared root's source module graph, then repeatedly scans
 * every file discovered so far for createRequire()-bound literal require()
 * calls, adding any newly found relative target as an additional root and
 * re-scanning until a fixed point is reached (no new files discovered).
 * Returns both the per-root metafiles and the full root list (declared +
 * discovered) so callers can attribute provenance and report roots
 * uniformly.
 */
export async function traceAllSourceGraphs({ rootDir, roots = SOURCE_GRAPH_ROOTS }) {
  const perRoot = new Map();
  const allRoots = [...roots];
  const knownRootPaths = new Set(roots.map((r) => r.path));

  for (const root of roots) {
    perRoot.set(root.id, await traceSourceGraph({ rootDir, root }));
  }

  const scannedForCreateRequire = new Set();
  let discoveredNewFiles = true;
  while (discoveredNewFiles) {
    discoveredNewFiles = false;
    const knownFiles = new Set();
    for (const metafile of perRoot.values()) {
      for (const f of Object.keys(metafile.inputs)) knownFiles.add(f);
    }
    for (const relPath of knownFiles) {
      if (scannedForCreateRequire.has(relPath)) continue;
      scannedForCreateRequire.add(relPath);
      if (!/\.(ts|tsx|js|mjs|cjs)$/.test(relPath)) continue;
      const sourceText = fs.readFileSync(path.join(rootDir, relPath), "utf-8");
      const targets = findCreateRequireLiteralTargets({ relPath, sourceText });
      for (const targetText of targets) {
        const resolved = resolveCreateRequireTarget({ rootDir, importerRelPath: relPath, targetText });
        if (knownRootPaths.has(resolved)) continue;
        knownRootPaths.add(resolved);
        const dynamicRoot = {
          id: `create-require-root:${resolved}`,
          path: resolved,
          inputType: "dynamic-process-root",
          reason:
            `Reached via a createRequire()-bound local require("${targetText}") call in ${relPath}, `
            + "which esbuild's own module-graph tracer cannot follow (see the createRequire "
            + "discovery pass above this function). Declared as its own root so its module graph "
            + "is traced the same as any other declared root.",
        };
        allRoots.push(dynamicRoot);
        perRoot.set(dynamicRoot.id, await traceSourceGraph({ rootDir, root: dynamicRoot }));
        discoveredNewFiles = true;
      }
    }
  }

  return { perRoot, allRoots };
}

/**
 * Merges per-root esbuild metafiles into a single file -> provenance map.
 * Only files internal to the repo (relative paths, not external/bare
 * specifiers and not nft's later node_modules entries) are included --
 * this function is exclusively the source-graph evidence.
 */
export function mergeSourceGraphProvenance({ perRootMetafiles, roots = SOURCE_GRAPH_ROOTS }) {
  const files = new Map(); // relPath -> [{root, from, kind}]
  for (const root of roots) {
    const metafile = perRootMetafiles.get(root.id);
    if (!metafile) continue;
    const inputs = metafile.inputs;
    // Root file itself.
    if (!files.has(root.path)) files.set(root.path, []);
    files.get(root.path).push({ root: root.id, from: null, kind: "root" });
    for (const [fromFile, data] of Object.entries(inputs)) {
      for (const imp of data.imports) {
        if (imp.external) continue;
        if (!Object.prototype.hasOwnProperty.call(inputs, imp.path)) continue;
        if (!files.has(imp.path)) files.set(imp.path, []);
        files.get(imp.path).push({ root: root.id, from: fromFile, kind: imp.kind });
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Dynamic call-site scan (fail-closed guard for the source graph's blind
// spot: esbuild silently drops import()/require() calls it cannot
// statically resolve instead of erroring, so this is a separate, dedicated
// pass).
// ---------------------------------------------------------------------------

function isLiteralArgument(node) {
  return !!node && ts.isStringLiteralLike(node);
}

function argumentSourceText(node, sourceFile) {
  return node.getText(sourceFile).trim().replace(/\s+/g, " ");
}

/**
 * Scans one file's text for import()/require()/child_process spawn-family
 * calls whose first argument is not a plain string literal. Pure function
 * of (relPath, sourceText) -- no filesystem or subprocess access -- so it
 * is directly fixture-testable.
 */
export function scanDynamicCallSites({ relPath, sourceText }) {
  const scriptKind = relPath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : (relPath.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const source = ts.createSourceFile(relPath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const hits = [];

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      let callee = null;
      let kind = null;
      if (ts.isImportCall(node)) {
        callee = "import";
        kind = "dynamic-import";
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        callee = "require";
        kind = "require-call";
      } else if (ts.isIdentifier(node.expression) && SPAWN_FAMILY_NAMES.has(node.expression.text)) {
        callee = node.expression.text;
        kind = "process-spawn";
      }
      if (callee) {
        const firstArg = node.arguments[0];
        if (!isLiteralArgument(firstArg)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          // The match key is the FIRST argument only (the actual spawn/import
          // target that made this call non-literal) -- not the full argument
          // list, which for spawn-family calls includes an options bag that
          // legitimately varies call-site to call-site (stdio, env, detached,
          // ...) without changing what's being classified.
          const argText = node.arguments.length === 0
            ? "<no arguments>"
            : argumentSourceText(firstArg, source);
          hits.push({
            file: relPath,
            line,
            callee,
            kind,
            argText,
            excerpt: argumentSourceText(node, source).slice(0, 240),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

/**
 * Runs scanDynamicCallSites over every file in `relPaths`, cross-checks
 * hits against DYNAMIC_CALL_ALLOWLIST (matched by file + callee + argument
 * text, not line number), and fails closed on either an unmatched hit or
 * an unused allowlist entry.
 */
export function scanAndValidateDynamicCallSites({
  rootDir,
  relPaths,
  allowlist = DYNAMIC_CALL_ALLOWLIST,
}) {
  const allHits = [];
  for (const relPath of relPaths) {
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(relPath)) continue;
    const sourceText = fs.readFileSync(path.join(rootDir, relPath), "utf-8");
    allHits.push(...scanDynamicCallSites({ relPath, sourceText }));
  }

  const matchedAllowlistIndexes = new Set();
  const unmatchedHits = [];
  for (const hit of allHits) {
    const allowIndex = allowlist.findIndex(
      (entry) => entry.file === hit.file && entry.callee === hit.callee && entry.argText === hit.argText,
    );
    if (allowIndex === -1) {
      unmatchedHits.push(hit);
    } else {
      matchedAllowlistIndexes.add(allowIndex);
    }
  }

  if (unmatchedHits.length > 0) {
    const details = unmatchedHits
      .map((h) => `  ${h.file}:${h.line} ${h.callee}(${h.argText}) -- ${h.excerpt}`)
      .join("\n");
    throw new Error(
      "[compute-cli-closure] non-literal dynamic import()/require()/spawn call(s) with no "
      + "DYNAMIC_CALL_ALLOWLIST entry (fail-closed -- register a named reason or fix the call):\n"
      + details,
    );
  }

  const staleEntries = allowlist
    .map((entry, index) => ({ entry, index }))
    .filter(({ index }) => !matchedAllowlistIndexes.has(index));
  if (staleEntries.length > 0) {
    const details = staleEntries
      .map(({ entry }) => `  ${entry.file} ${entry.callee}(${entry.argText})`)
      .join("\n");
    throw new Error(
      "[compute-cli-closure] DYNAMIC_CALL_ALLOWLIST entr(y/ies) matched no real call site "
      + "(fail-closed -- remove the stale entry, the code was refactored):\n"
      + details,
    );
  }

  return allHits;
}

// ---------------------------------------------------------------------------
// Evidence source 3: nft trace of compiled bundles.
// ---------------------------------------------------------------------------

// Some native packages ship one npm package PER TARGET (napi-rs and esbuild
// both do this): the variants are declared as optionalDependencies and npm
// installs only the one matching the host, so the platform ends up in the
// package NAME rather than inside a file the `.node` filter above can reach.
// This is Node's own platform/arch vocabulary plus the libc/toolchain suffix
// those packages append.
const PLATFORM_VARIANT_SUFFIX_RE =
  /-(?:aix|android|darwin|freebsd|linux|openbsd|sunos|win32)-(?:arm|arm64|ia32|loong64|mips64el|ppc|ppc64|riscv64|s390|s390x|x64)(?:-(?:eabi|eabihf|gnu|gnueabihf|msvc|musl))?$/;

const PLATFORM_VARIANT_PLACEHOLDER = "<platform>";

// Splits a traced path at its innermost `node_modules/<pkg>` boundary.
// Returns null for paths that are not inside a package (repo sources) or that
// stop at the package directory itself.
export function splitNodeModulesPath(relPath) {
  const marker = "node_modules/";
  const idx = relPath.lastIndexOf(marker);
  if (idx === -1) return null;
  const base = relPath.slice(0, idx + marker.length);
  const parts = relPath.slice(idx + marker.length).split("/");
  const nameLen = parts[0].startsWith("@") ? 2 : 1;
  if (parts.length <= nameLen) return null;
  return {
    base,
    pkgName: parts.slice(0, nameLen).join("/"),
    inner: parts.slice(nameLen).join("/"),
  };
}

export function normalizeNftTraceFiles({ fileList, scratchRel }) {
  const kept = [...fileList]
    .map(toPosix)
    .filter((relPath) => {
      if (relPath === scratchRel || relPath === "package.json") return false;
      // Native addon bytes are produced for a specific OS, architecture, and
      // Node ABI. The packaged server installs them with its target runtime;
      // including a locally rebuilt copy here would make this source closure
      // change when npm ignore-scripts changes, while omitting the package's
      // JavaScript and metadata would still be incorrect.
      return path.posix.extname(relPath).toLowerCase() !== ".node";
    });

  // A platform-variant package is only folded when BOTH hold: its name carries
  // a platform suffix, AND (once its `.node` bytes are filtered above) it
  // contributes nothing but its own package.json. The second condition is what
  // keeps an ordinary package that merely looks platform-suffixed intact --
  // folding one that ships real modules would erase real files from the census.
  const contributions = new Map();
  for (const relPath of kept) {
    const split = splitNodeModulesPath(relPath);
    if (!split) continue;
    const key = split.base + split.pkgName;
    if (!contributions.has(key)) contributions.set(key, []);
    contributions.get(key).push(split.inner);
  }
  const foldable = new Set();
  for (const [key, inners] of contributions) {
    const pkgName = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!PLATFORM_VARIANT_SUFFIX_RE.test(pkgName)) continue;
    if (inners.length !== 1 || inners[0] !== "package.json") continue;
    foldable.add(key);
  }

  const folded = kept.map((relPath) => {
    const split = splitNodeModulesPath(relPath);
    if (!split || !foldable.has(split.base + split.pkgName)) return relPath;
    const stableName = split.pkgName.replace(
      PLATFORM_VARIANT_SUFFIX_RE,
      `-${PLATFORM_VARIANT_PLACEHOLDER}`,
    );
    return `${split.base}${stableName}/${split.inner}`;
  });

  return [...new Set(folded)].sort();
}

export async function traceNftRoot({ rootDir, root }) {
  const entryAbs = path.join(rootDir, root.path);
  if (!fs.existsSync(entryAbs)) {
    throw new Error(
      `[compute-cli-closure] nft root "${root.id}" source entry does not exist on disk: ${root.path}.`,
    );
  }
  const buildDir = path.join(rootDir, "build");
  fs.mkdirSync(buildDir, { recursive: true });
  // The scratch bundle must live inside the repo tree (not os.tmpdir())
  // so Node's ordinary node_modules ancestor-walk resolution finds this
  // repo's real node_modules -- see the module docstring's nft safety
  // note for what goes wrong otherwise. Always cleaned up in `finally`,
  // and proactively removed first in case a previous run crashed before
  // its own cleanup ran.
  const scratchPath = path.join(buildDir, `.cli-closure-nft-scratch-${root.id}.mjs`);
  fs.rmSync(scratchPath, { force: true });
  try {
    const built = await esbuildBuild({
      entryPoints: [entryAbs],
      bundle: true,
      write: true,
      platform: "node",
      format: "esm",
      target: "node24",
      packages: "external",
      logLevel: "silent",
      absWorkingDir: rootDir,
      outfile: scratchPath,
    });
    if (built.warnings.length > 0) {
      const text = built.warnings.map((w) => w.text).join("\n");
      throw new Error(
        `[compute-cli-closure] esbuild reported warnings bundling nft root "${root.id}" for tracing; `
        + `fail-closed:\n${text}`,
      );
    }
    const { nodeFileTrace } = await import("@vercel/nft");
    const optionalRoots = root.id === "nft-server-bundle" ? optionalServerDependencyRoots(rootDir) : [];
    const { fileList, warnings } = await nodeFileTrace([scratchPath, ...optionalRoots], {
      base: rootDir,
      conditions: ["node", "import"],
      analysis: { emitGlobs: false },
      ignore: [...NFT_IGNORE_PATTERNS, repoRelative(rootDir, scratchPath)],
    });
    const scratchRel = repoRelative(rootDir, scratchPath);
    const files = normalizeNftTraceFiles({ fileList, scratchRel });
    return { files, warnings: [...warnings].map((w) => w.message) };
  } finally {
    fs.rmSync(scratchPath, { force: true });
  }
}

export async function traceAllNftRoots({ rootDir, roots = NFT_TRACE_ROOTS }) {
  const perRoot = new Map();
  for (const root of roots) {
    perRoot.set(root.id, await traceNftRoot({ rootDir, root }));
  }
  return perRoot;
}

// ---------------------------------------------------------------------------
// Evidence source 4: runtime asset validation.
// ---------------------------------------------------------------------------

export function validateRuntimeAssets({ rootDir, assets = RUNTIME_ASSETS }) {
  const missing = assets.filter((asset) => !fs.existsSync(path.join(rootDir, asset.path)));
  if (missing.length > 0) {
    const details = missing.map((asset) => `  ${asset.path}`).join("\n");
    throw new Error(
      "[compute-cli-closure] declared runtime asset(s) do not exist on disk (fail-closed -- "
      + "a dangling asset declaration must not be silently dropped, fix the path or remove the "
      + "declaration):\n"
      + details,
    );
  }
}

// ---------------------------------------------------------------------------
// Orchestration + merge.
// ---------------------------------------------------------------------------

function shortReasonForSourceGraphFile(relPath, provenance, allRoots) {
  const rootFile = provenance.find((p) => p.kind === "root");
  if (rootFile) {
    const root = allRoots.find((r) => r.id === rootFile.root);
    return `Declared root: ${root.reason}`;
  }
  const samples = provenance.slice(0, 3).map((p) => `${p.from} (${p.kind})`);
  const suffix = provenance.length > 3 ? `; +${provenance.length - 3} more importer(s)` : "";
  return `Reached via esbuild source module graph, imported by ${samples.join("; ")}${suffix}.`;
}

/**
 * Computes the full closure. Set `includeNftTrace: false` to skip the slow
 * (bundle + nft) step -- used by fast unit tests that only need to
 * exercise the fail-closed source-graph/asset/dynamic-call validations,
 * which all run before nft and do not depend on it.
 */
export async function computeCliRuntimeClosure({ rootDir = REPOSITORY_ROOT, includeNftTrace = true } = {}) {
  validateRuntimeAssets({ rootDir });

  const { perRoot: perRootMetafiles, allRoots } = await traceAllSourceGraphs({ rootDir });
  const sourceProvenance = mergeSourceGraphProvenance({ perRootMetafiles, roots: allRoots });
  scanAndValidateDynamicCallSites({ rootDir, relPaths: [...sourceProvenance.keys()] });

  const filesMap = new Map(); // relPath -> { inputType, provenance: [], reason }

  for (const [relPath, provenance] of sourceProvenance.entries()) {
    filesMap.set(relPath, {
      path: relPath,
      inputType: "source-graph",
      provenance: provenance.map((p) => ({ root: p.root, from: p.from, kind: p.kind })),
      reason: shortReasonForSourceGraphFile(relPath, provenance, allRoots),
    });
  }

  if (includeNftTrace) {
    const perRootNft = await traceAllNftRoots({ rootDir });
    for (const root of NFT_TRACE_ROOTS) {
      const traced = perRootNft.get(root.id);
      // Provenance/reason are intentionally compact here (no `from`, short
      // templated reason instead of a repeated full sentence) -- this
      // category alone is ~9000 entries, and the full explanation of what
      // "nft-runtime-trace via <root>" means already lives once in the
      // top-level `roots` array (cross-reference by id).
      for (const relPath of traced.files) {
        const existing = filesMap.get(relPath);
        const entry = { root: root.id, kind: "nft-trace" };
        if (existing) {
          existing.provenance.push(entry);
        } else {
          filesMap.set(relPath, {
            path: relPath,
            inputType: "nft-runtime-trace",
            provenance: [entry],
            reason: `nft-runtime-trace via ${root.id} (see roots[] for the full explanation)`,
          });
        }
      }
    }
  }

  for (const asset of RUNTIME_ASSETS) {
    const existing = filesMap.get(asset.path);
    const entry = { root: "declared-asset", kind: asset.kind };
    if (existing) {
      existing.provenance.push(entry);
    } else {
      filesMap.set(asset.path, {
        path: asset.path,
        inputType: "runtime-asset",
        provenance: [entry],
        reason: asset.reason,
      });
    }
  }

  const files = [...filesMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  const byInputType = {};
  for (const file of files) {
    byInputType[file.inputType] = (byInputType[file.inputType] || 0) + 1;
  }

  // allRoots = the statically declared roots plus any createRequire()-
  // discovered roots found while tracing them; sort discovered ones after
  // the declared ones (already in declaration order) for a stable,
  // readable, deterministic output order.
  const declaredIds = new Set(CLOSURE_ROOTS.map((r) => r.id));
  const discoveredRoots = allRoots.filter((r) => !declaredIds.has(r.id)).sort((a, b) => a.path.localeCompare(b.path));
  const orderedRoots = [...CLOSURE_ROOTS, ...discoveredRoots];

  return {
    version: CLOSURE_VERSION,
    generatedBy: GENERATOR_ID,
    roots: orderedRoots.map(({ id, path: rootPath, inputType, reason }) => ({ id, path: rootPath, inputType, reason })),
    dynamicCallSites: DYNAMIC_CALL_ALLOWLIST.map(({ file, callee, argText, reason }) => ({
      file,
      callee,
      argText,
      reason,
    })),
    files,
    stats: {
      totalFiles: files.length,
      byInputType,
    },
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeCliRuntimeClosure({ rootDir = REPOSITORY_ROOT } = {}) {
  const closure = await computeCliRuntimeClosure({ rootDir, includeNftTrace: true });
  const outPath = path.join(rootDir, "build", "cli-runtime-closure.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, stableJson(closure), "utf-8");
  return { closure, outPath };
}

// ---------------------------------------------------------------------------
// Open/closed cross-check: adjudicates the closure's *repo source* files
// (nft-traced node_modules files and declared runtime assets never match
// these repo-relative patterns and are skipped) against which parts of the
// tree are redistributable host/spec-facing capability versus closed-source
// product surface. Two closed categories are distinguished for clarity:
// "closed-product" (implements a specific closed-source product
// experience -- routes, stores, UI surfaces) and "closed-content" (brand
// assets, bundled skills/plugins -- not code logic, just shipped content).
// Anything not matched by a pattern below is presumed open/redistributable
// and never flagged.
//
// Every pattern below was verified two ways before being included: (a) the
// path exists on disk today, and (b) it actually appears in a freshly
// generated closure. An earlier, dated classification pass also named six
// paths that turned out not to exist anywhere in the current tree at all
// (five under core/, one under server/routes/) -- rather than guess at
// what they might have been renamed to, those are recorded verbatim in
// STALE_CLASSIFICATION_REFERENCES below so a human can reconcile the
// mismatch, and they are deliberately absent from the pattern lists.
// ---------------------------------------------------------------------------

export const CLOSED_CONTENT_PATTERNS = Object.freeze([
  { pattern: /^plugins\//, note: "Built-in plugins are closed-source product content shipped with the app, not part of the redistributable core." },
  { pattern: /^skills2set\//, note: "Bundled built-in skill content shipped with the product; closed by default." },
  { pattern: /^desktop\/src\/assets\//, note: "Brand imagery; closed by default (any icon the packaged shell itself needs is handled separately)." },
  { pattern: /^desktop\/src\/screenshot-themes\//, note: "Brand-styled screenshot theme assets; closed by default." },
]);

export const CLOSED_PRODUCT_PATTERNS = Object.freeze([
  {
    pattern: /^server\/routes\/(avatar|cards|character-cards|desk|diary)\.ts$/,
    note: "Implements the closed-source avatar/card/desk/diary product surface, not generic redistributable host capability.",
  },
  // core/desktop-session-submit.ts and core/current-turn-native-media.ts
  // were reclassified redistributable 2026-07-17 (both listed in
  // export-manifest.json). The earlier notes here guessed "desktop UI
  // product surface" from the file names, but the evidence says host
  // plumbing: the open chat/sessions routes and the open engine import
  // them unconditionally (an open server could not submit a message
  // without them), every dependency they pull in is already
  // redistributable, and "desktop session" names an engine-side session
  // kind, not the desktop renderer.
  { pattern: /^lib\/character-cards\//, note: "Implements the closed-source character-card content system." },
  // lib/desk/ was reclassified redistributable 2026-07-17 (all files listed
  // in export-manifest.json). It is the automation machinery -- cron
  // store/scheduler, heartbeat, automation executors/normalizer, activity
  // log, permission stub -- which runs headless under the CLI, has long
  // been published in this repository, and is imported unconditionally by
  // the redistributable agent/hub code. The desk product EXPERIENCE
  // (routes and renderer surface) is a separate closed set and stays
  // closed; only the backend machinery is open.
  { pattern: /^desktop\/src\/react\//, note: "The renderer's React application bundle -- the closed-source desktop UI implementation." },
  { pattern: /^desktop\/(index\.html|src\/main\.tsx)$/, note: "The renderer's own HTML/entry files." },
  {
    pattern: /^desktop\/src\/(mobile|pad|settings|quick-chat|onboarding|browser-viewer)/,
    note: "A closed-source renderer UI surface (mobile/pad/settings/quick-chat/onboarding/browser-viewer).",
  },
  { pattern: /^desktop\/src\/themes\//, note: "Renderer visual theming." },
  { pattern: /^desktop\/src\/(animations|styles)\.css$/, note: "Renderer visual styling." },
]);

// Present in the closure but not confidently classified by the patterns
// above -- recorded for human attention, never auto-treated as a
// closed-product/closed-content violation.
export const EVIDENCE_NEEDED_PATTERNS = Object.freeze([
  {
    pattern: /^server\/routes\/mobile-workbench\.ts$/,
    note: "Superseded by the mobile-workspace route in ongoing development; this edge is expected to retire with that replacement rather than be re-cut here, so it stays recorded as evidence rather than acted on.",
  },
  // server/suggestion-blocks.ts was resolved 2026-07-17: it is a plain
  // wire-format builder for automation suggestion blocks with no product
  // logic of its own, so it is classified redistributable (listed in
  // export-manifest.json). The desk automation behavior behind those
  // blocks remains closed.
]);

// Reached by the closure but its open/closed boundary has not been drawn
// yet (a mix of generic startup/update/preload plumbing and
// product-specific behavior) -- not a confirmed closed-product/
// closed-content coupling yet, so not counted as a baseline edge.
export const PROVISIONAL_PATTERNS = Object.freeze([
  {
    // theme-registry.cjs and theme-registry-data.json were resolved
    // 2026-07-17: the registry is a low-sensitivity manifest of theme ids,
    // background colors and i18n keys plus its lookup logic, needed by the
    // redistributable settings tool for validation, so both are classified
    // redistributable (listed in export-manifest.json). The theme CSS
    // itself lives under desktop/src/themes/ and stays closed.
    pattern: /^desktop\/src\/shared\/(?!theme-registry\.cjs$|theme-registry-data\.json$)/,
    note: "Shared desktop-shell code mixing generic startup/update/error/preload plumbing with product-specific behavior; needs a dedicated pass to separate the two before it can be classified.",
  },
]);

// Paths an earlier, dated classification pass named that do not exist
// anywhere in the current tree (verified via `find`) -- left out of the
// pattern lists above rather than guessed at.
export const STALE_CLASSIFICATION_REFERENCES = Object.freeze([
  { path: "core/card-archive-store.ts", note: "Named as closed-product by an earlier classification pass; no such file exists in core/ today." },
  { path: "core/card-face-store.ts", note: "Named as closed-product by an earlier classification pass; no such file exists in core/ today." },
  { path: "core/client-layout-profile-store.ts", note: "Named as closed-product by an earlier classification pass; no such file exists in core/ today." },
  { path: "core/card-document-ticket-service.ts", note: "Named as an open spec-facing file by an earlier classification pass; no such file exists in core/ today." },
  { path: "core/card-host-grant-store.ts", note: "Named as an open spec-facing file by an earlier classification pass; no such file exists in core/ today." },
  { path: "server/routes/suggestion-blocks.ts", note: "An earlier classification pass named 'suggestion-blocks'; the real file is server/suggestion-blocks.ts (no routes/ prefix)." },
]);

/**
 * Classifies one repo-relative path against the open/closed pattern lists
 * above. Returns null for anything not matched (presumed open) -- this
 * function never asserts a positive "open" classification, it only ever
 * flags closed-content/closed-product/evidence-needed/provisional.
 */
export function classifyRepoPath(relPath) {
  for (const { pattern, note } of CLOSED_CONTENT_PATTERNS) {
    if (pattern.test(relPath)) return { classification: "closed-content", note };
  }
  for (const { pattern, note } of CLOSED_PRODUCT_PATTERNS) {
    if (pattern.test(relPath)) return { classification: "closed-product", note };
  }
  for (const { pattern, note } of EVIDENCE_NEEDED_PATTERNS) {
    if (pattern.test(relPath)) return { classification: "evidence-needed", note };
  }
  for (const { pattern, note } of PROVISIONAL_PATTERNS) {
    if (pattern.test(relPath)) return { classification: "provisional", note };
  }
  return null;
}

/**
 * Cross-references a computed closure against the open/closed pattern
 * lists and produces the sorted open-to-closed coupling edge list this
 * whole slice exists to surface. Recording the list is the job here --
 * breaking any of these couplings apart is deliberately out of scope and
 * left for a later, dedicated pass.
 */
export function computeOpenBoundaryBaseline({ closure }) {
  const edges = [];
  const evidenceNeeded = [];
  const provisional = [];
  const seenEvidence = new Set();
  const seenProvisional = new Set();

  for (const file of closure.files) {
    if (file.inputType !== "source-graph") continue;
    const result = classifyRepoPath(file.path);
    if (!result) continue;

    // evidence-needed/provisional targets are ALSO recorded in the
    // evidence/provisional summary arrays below for quick reference, but
    // they still produce ordinary coupling edges just like
    // closed-product/closed-content -- from this lint's point of view a
    // "not yet classified" target is just as unavailable to an open
    // importer as a confirmed-closed one, and the ratchet baseline this
    // function feeds must cover every edge scripts/lint-open-boundary.mjs
    // can actually find (that lint has no concept of these finer
    // categories -- it only knows "whitelisted" or not).
    if (result.classification === "evidence-needed" && !seenEvidence.has(file.path)) {
      seenEvidence.add(file.path);
      evidenceNeeded.push({ path: file.path, note: result.note });
    }
    if (result.classification === "provisional" && !seenProvisional.has(file.path)) {
      seenProvisional.add(file.path);
      provisional.push({ path: file.path, note: result.note });
    }

    for (const p of file.provenance) {
      if (!p.from) continue; // root-file entries have no importer to blame
      edges.push({
        from: p.from,
        to: file.path,
        provenance: `${p.root}:${p.kind}`,
        classification: result.classification,
        note: result.note,
      });
    }
  }

  edges.sort((a, b) => (
    a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.provenance.localeCompare(b.provenance)
  ));
  evidenceNeeded.sort((a, b) => a.path.localeCompare(b.path));
  provisional.sort((a, b) => a.path.localeCompare(b.path));

  const byClassification = {};
  const uniqueTo = new Set();
  for (const edge of edges) {
    byClassification[edge.classification] = (byClassification[edge.classification] || 0) + 1;
    uniqueTo.add(edge.to);
  }

  return {
    version: 1,
    generatedBy: GENERATOR_ID,
    sourceClosure: "build/cli-runtime-closure.json",
    edges,
    evidenceNeeded,
    provisional,
    staleClassificationReferences: STALE_CLASSIFICATION_REFERENCES,
    stats: {
      totalEdges: edges.length,
      byClassification,
      uniqueCoupledFiles: uniqueTo.size,
    },
  };
}

export async function writeOpenBoundaryBaseline({ rootDir = REPOSITORY_ROOT, closure } = {}) {
  const resolvedClosure = closure ?? (await computeCliRuntimeClosure({ rootDir, includeNftTrace: true }));
  const baseline = computeOpenBoundaryBaseline({ closure: resolvedClosure });
  const outPath = path.join(rootDir, "build", "open-boundary-baseline.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, stableJson(baseline), "utf-8");
  return { baseline, outPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { closure, outPath } = await writeCliRuntimeClosure({});
  const { baseline, outPath: baselineOutPath } = await writeOpenBoundaryBaseline({ closure });
  process.stdout.write(
    `cli runtime closure: ${closure.stats.totalFiles} files `
    + `(${Object.entries(closure.stats.byInputType).map(([k, v]) => `${k}=${v}`).join(", ")})\n`
    + `${toPosix(path.relative(REPOSITORY_ROOT, outPath))}\n`
    + `open-boundary baseline: ${baseline.stats.totalEdges} coupling edge(s) `
    + `(${Object.entries(baseline.stats.byClassification).map(([k, v]) => `${k}=${v}`).join(", ")}), `
    + `${baseline.evidenceNeeded.length} evidence-needed, ${baseline.provisional.length} provisional\n`
    + `${toPosix(path.relative(REPOSITORY_ROOT, baselineOutPath))}\n`,
  );
}
