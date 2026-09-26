/**
 * build-server-phases.mjs — shared packing primitives for server distribution builds.
 *
 * Extracted from scripts/build-server.mjs (which built only the full/closed
 * product) so a second, open-composition builder (scripts/build-server-open.mjs)
 * can reuse the exact same packing mechanics without duplicating them.
 *
 * Every function here is a pure-parameter primitive: nothing in this module
 * reads an "isOpen"/"isFull" flag or any other identity of which composition
 * is being built. All open/full differences (bundle entry, data file lists,
 * extra external package names, nft trace roots, ...) are expressed by the
 * arguments the caller passes in. scripts/build-server.mjs and
 * scripts/build-server-open.mjs each decide their own arguments and then
 * call these primitives in the same order; full's builder additionally runs
 * its own full-exclusive steps (skills2set/plugins/brand assets/renderer/
 * seed packing) that are not part of this module at all.
 */
import fs from "fs";
import { optionalServerDependencyRoots } from "./optional-server-dependencies.mjs";
import path from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { builtinModules } from "module";
import { pathToFileURL } from "url";
import ts from "typescript";
import {
  buildAnydocRuntimeSmokeScript,
  buildBetterSqliteRuntimeSmokeScript,
  buildJiebaRuntimeSmokeScript,
  buildExternalPackage,
  collectBareImportPackageNames,
  collectInstalledOptionalDependencyDirs,
  verifyExternalEntrypoints,
} from "./build-server-deps.mjs";
import { pruneRuntimeDeadFiles } from "./build-server-prune.mjs";

// ── Node.js runtime ──────────────────────────────────────────────────────

export const DEFAULT_NODE_VERSION = "v24.19.0";
export const DEFAULT_NODE_RUNTIME_SHA256 = {
  [`node-${DEFAULT_NODE_VERSION}-darwin-arm64.tar.gz`]: "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d",
  [`node-${DEFAULT_NODE_VERSION}-darwin-x64.tar.gz`]: "d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316",
  [`node-${DEFAULT_NODE_VERSION}-linux-arm64.tar.gz`]: "d28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f",
  [`node-${DEFAULT_NODE_VERSION}-linux-x64.tar.gz`]: "f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4",
  [`node-${DEFAULT_NODE_VERSION}-win-x64.zip`]: "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73",
};

const NODE_DIR_NAME_MAP = {
  "darwin-arm64": (v) => `node-${v}-darwin-arm64`,
  "darwin-x64": (v) => `node-${v}-darwin-x64`,
  "linux-x64": (v) => `node-${v}-linux-x64`,
  "linux-arm64": (v) => `node-${v}-linux-arm64`,
  "win32-x64": (v) => `node-${v}-win-x64`,
};

function verifyNodeRuntimeArchive(archivePath, archiveName, checksums, log) {
  const expected = checksums[archiveName];
  if (!expected) {
    throw new Error(`[build-server] missing pinned Node runtime checksum for ${archiveName}`);
  }
  const actual = createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
  if (actual !== expected) {
    try { fs.rmSync(archivePath, { force: true }); } catch {
      // Best-effort cleanup; the checksum error below is the actionable failure.
    }
    throw new Error(
      `[build-server] node runtime archive checksum mismatch for ${archiveName}: expected ${expected}, got ${actual}`,
    );
  }
  log(`[build-server] Node.js runtime checksum verified: ${archiveName}`);
}

/**
 * Downloads (or reuses the cached copy of) the pinned target Node.js
 * runtime, verifies its checksum, extracts it, and copies the `node`
 * binary into `outDir` (renamed to `hana-server.exe` on Windows so
 * `desktop/main.cjs`'s bundled-server detection and NSIS process-kill-by-name
 * both work). Returns a `runWithTargetNode` helper bound to `outDir` as cwd
 * and to a PATH that puts the target Node's bin dir first, so subsequent
 * npm lifecycle scripts (prebuild-install et al.) also run under the target
 * Node rather than the system one.
 *
 * @param {{
 *   rootDir: string, platform: string, arch: string, outDir: string,
 *   nodeVersion?: string, checksums?: Record<string, string>,
 *   log?: (msg: string) => void,
 * }} params
 */
export function prepareNodeRuntime({
  rootDir,
  platform,
  arch,
  outDir,
  nodeVersion = DEFAULT_NODE_VERSION,
  checksums = DEFAULT_NODE_RUNTIME_SHA256,
  log = (msg) => console.log(msg),
}) {
  const cacheDir = path.join(rootDir, ".cache", "node-runtime");
  fs.mkdirSync(cacheDir, { recursive: true });

  const dirNameFn = NODE_DIR_NAME_MAP[`${platform}-${arch}`];
  if (!dirNameFn) {
    throw new Error(`[build-server] unsupported platform: ${platform}-${arch}`);
  }
  const nodeDirName = dirNameFn(nodeVersion);

  const isWin = platform === "win32";
  const ext = isWin ? "zip" : "tar.gz";
  const filename = `${nodeDirName}.${ext}`;
  const cachedArchive = path.join(cacheDir, filename);
  const cachedNodeBin = isWin
    ? path.join(cacheDir, nodeDirName, "node.exe")
    : path.join(cacheDir, nodeDirName, "bin", "node");
  const cachedNpmCli = isWin
    ? path.join(cacheDir, nodeDirName, "node_modules", "npm", "bin", "npm-cli.js")
    : path.join(cacheDir, nodeDirName, "lib", "node_modules", "npm", "bin", "npm-cli.js");

  if (!fs.existsSync(cachedNodeBin)) {
    const url = `https://nodejs.org/dist/${nodeVersion}/${filename}`;
    log(`[build-server] downloading Node.js ${nodeVersion} for ${platform}-${arch}...`);
    execSync(`curl --fail --location --show-error -o "${cachedArchive}" "${url}"`, { stdio: "inherit" });
    verifyNodeRuntimeArchive(cachedArchive, filename, checksums, log);

    if (isWin) {
      execSync(`powershell -command "Expand-Archive -Path '${cachedArchive}' -DestinationPath '${cacheDir}' -Force"`, { stdio: "inherit" });
    } else {
      execSync(`tar xzf "${cachedArchive}" -C "${cacheDir}"`, { stdio: "inherit" });
    }

    try { fs.unlinkSync(cachedArchive); } catch {
      // Best-effort cache cleanup after a verified extraction.
    }
    log("[build-server] Node.js runtime cached");
  } else {
    log(`[build-server] using cached Node.js ${nodeVersion}`);
  }

  const destNode = path.join(outDir, isWin ? "hana-server.exe" : "node");
  fs.copyFileSync(cachedNodeBin, destNode);
  if (!isWin) fs.chmodSync(destNode, 0o755);
  log("[build-server] Node.js runtime ready");

  const targetNodeDir = path.dirname(cachedNodeBin);
  const targetEnv = {
    ...process.env,
    NODE_ENV: "production",
    PATH: `${targetNodeDir}${path.delimiter}${process.env.PATH}`,
  };
  function runWithTargetNode(cmd, opts = {}) {
    execSync(`"${cachedNodeBin}" ${cmd}`, {
      cwd: outDir,
      stdio: "inherit",
      env: targetEnv,
      ...opts,
    });
  }

  return { isWin, cachedNodeBin, cachedNpmCli, destNode, targetEnv, runWithTargetNode };
}

// ── Bundle ────────────────────────────────────────────────────────────────

/**
 * Runs `vite build --config vite.config.server.js` and copies the produced
 * bundle into `bundleOutDir`. `entry` overrides the bundle's lib entry via
 * the `HANA_SERVER_BUNDLE_ENTRY` environment variable (read by
 * vite.config.server.js); when omitted, vite.config.server.js's own default
 * (server/main-full.ts, the closed composition entry) is used unchanged.
 *
 * @param {{ rootDir: string, viteBundleDir: string, bundleOutDir: string, entry?: string, log?: (msg: string) => void }} params
 */
export function buildViteServerBundle({ rootDir, viteBundleDir, bundleOutDir, entry, log = (msg) => console.log(msg) }) {
  log("[build-server] running Vite bundle...");
  execSync("npx vite build --config vite.config.server.js", {
    cwd: rootDir,
    stdio: "inherit",
    env: entry ? { ...process.env, HANA_SERVER_BUNDLE_ENTRY: entry } : process.env,
  });

  fs.cpSync(viteBundleDir, bundleOutDir, { recursive: true });
  log("[build-server] Vite bundle copied to bundle/");
}

/**
 * esbuild-bundles the (fully open, shared by every composition) CLI entry
 * into `bundleOutDir/cli.js`.
 *
 * @param {{ rootDir: string, bundleOutDir: string, log?: (msg: string) => void }} params
 */
export function buildCliBundle({ rootDir, bundleOutDir, log = (msg) => console.log(msg) }) {
  log("[build-server] running CLI bundle...");
  execSync(
    `npx esbuild "${path.join(rootDir, "cli", "entry.ts")}" --bundle --platform=node --format=esm --target=node24 --external:ws --outfile="${path.join(bundleOutDir, "cli.js")}"`,
    { cwd: rootDir, stdio: "inherit" },
  );
  log("[build-server] CLI bundle copied to bundle/cli.js");
}

/**
 * Copies server/bootstrap.ts verbatim (not bundled) to `outDir/bootstrap.js`
 * — the packaged process entry that `cli/server-runner.ts` spawns by path.
 *
 * @param {{ rootDir: string, outDir: string, log?: (msg: string) => void }} params
 */
export function copyServerBootstrap({ rootDir, outDir, log = (msg) => console.log(msg) }) {
  fs.copyFileSync(path.join(rootDir, "server", "bootstrap.ts"), path.join(outDir, "bootstrap.js"));
  log("[build-server] bootstrap copied");
}

// ── Runtime data files ──────────────────────────────────────────────────

/**
 * Copies the lib/ runtime data files and template directories a caller
 * lists, plus any additional whole-directory copies, into `outDir`. Every
 * list is caller-supplied — this primitive carries no opinion about which
 * files belong to which composition. Missing lib/ files/dirs are warned
 * about (not fatal, matching the pre-extraction behavior); missing
 * `extraDirs` entries are also warned about and skipped.
 *
 * @param {{
 *   rootDir: string, outDir: string,
 *   libFiles?: string[], libDirs?: string[],
 *   extraDirs?: { relSource: string, relDest?: string }[],
 *   log?: (msg: string) => void,
 * }} params
 * @returns {string[]} relative paths copied (files as-is, dirs with a trailing separator)
 */
export function copyServerDataFiles({
  rootDir,
  outDir,
  libFiles = [],
  libDirs = [],
  extraDirs = [],
  log = (msg) => console.log(msg),
}) {
  const copied = [];
  const libOutDir = path.join(outDir, "lib");
  fs.mkdirSync(libOutDir, { recursive: true });

  for (const file of libFiles) {
    const src = path.join(rootDir, "lib", file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(libOutDir, file));
      log(`[build-server]   lib/${file}`);
      copied.push(`lib/${file}`);
    } else {
      console.warn(`[build-server] ⚠ lib/${file} not found, skipping`);
    }
  }

  for (const dir of libDirs) {
    const src = path.join(rootDir, "lib", dir);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(libOutDir, dir), { recursive: true });
      log(`[build-server]   lib/${dir}/`);
      copied.push(`lib/${dir}/`);
    } else {
      console.warn(`[build-server] ⚠ lib/${dir}/ not found, skipping`);
    }
  }

  for (const { relSource, relDest } of extraDirs) {
    const src = path.join(rootDir, relSource);
    const dest = path.join(outDir, relDest ?? relSource);
    if (fs.existsSync(src)) {
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      log(`[build-server]   ${relDest ?? relSource}/`);
      copied.push(`${relDest ?? relSource}/`);
    } else {
      console.warn(`[build-server] ⚠ ${relSource} not found, skipping`);
    }
  }

  return copied;
}

// ── External npm dependencies ───────────────────────────────────────────

const OPTIONAL_EXTERNALS = new Set(["fsevents"]);

function ensureNodePtySpawnHelperExecutable({ baseDir, platform, arch, isWin }) {
  if (isWin) return;
  const nodePtyRoot = path.join(baseDir, "node_modules", "node-pty");
  if (!fs.existsSync(nodePtyRoot)) return;
  for (const helperPath of [
    path.join(nodePtyRoot, "build", "Release", "spawn-helper"),
    path.join(nodePtyRoot, "prebuilds", `${platform}-${arch}`, "spawn-helper"),
  ]) {
    if (!fs.existsSync(helperPath)) continue;
    const mode = fs.statSync(helperPath).mode;
    if ((mode & 0o111) === 0) {
      fs.chmodSync(helperPath, mode | 0o755);
      console.log(`[build-server] node-pty executable bit fixed: ${path.relative(baseDir, helperPath)}`);
    }
  }
}

function removeBinDirs(nmDir) {
  let removedDirs = 0;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const full = path.join(dir, entry.name);
      if (entry.name === ".bin" && path.basename(dir) === "node_modules") {
        fs.rmSync(full, { recursive: true, force: true });
        removedDirs++;
        continue;
      }

      walk(full);
    }
  }

  walk(nmDir);
  return removedDirs;
}

/**
 * Derives the packaged server's external npm dependency set from
 * vite.config.server.js's `rollupOptions.external` (cross-referenced
 * against root package.json's declared dependencies), plus any
 * `extraPackageNames` the caller supplies (e.g. full's build-server.mjs
 * passes the bundled-plugin package deps it derives itself; the open
 * builder passes none, since it ships no plugins/), pins every version to
 * the root package-lock.json, writes `outDir/package.json`, installs with
 * the target Node's npm, and runs the same post-install verification /
 * cleanup steps build-server.mjs always has (spawn-helper executable bit,
 * missing-external check, entrypoint verification, Pi SDK patch-check,
 * node_modules/.bin removal).
 *
 * @param {{
 *   rootDir: string, outDir: string, bundleOutDir: string,
 *   platform: string, arch: string, isWin: boolean,
 *   runWithTargetNode: (cmd: string, opts?: object) => void,
 *   cachedNpmCli: string,
 *   extraPackageNames?: string[],
 *   pinnedTransitiveDeps?: string[],
 *   log?: (msg: string) => void,
 * }} params
 * @returns {{ externalPkg: object, viteExternals: (string|RegExp)[], rootPkg: object }}
 */
export async function resolveAndInstallExternalServerDeps({
  rootDir,
  outDir,
  bundleOutDir,
  platform,
  arch,
  isWin,
  runWithTargetNode,
  cachedNpmCli,
  extraPackageNames = [],
  pinnedTransitiveDeps = ["lru-cache"],
  log = (msg) => console.log(msg),
}) {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));

  // defineConfig is a pure identity function, import is side-effect free
  const viteConfig = (await import(pathToFileURL(path.join(rootDir, "vite.config.server.js")).href)).default;
  const viteExternals = viteConfig.build?.rollupOptions?.external;
  if (!Array.isArray(viteExternals)) {
    throw new Error("[build-server] vite.config.server.js external must be an array");
  }

  const builtinSet = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
  const deps = rootPkg.dependencies || {};
  const externalDeps = {};

  for (const ext of viteExternals) {
    if (typeof ext === "string") {
      if (builtinSet.has(ext)) continue;
      if (deps[ext]) externalDeps[ext] = deps[ext];
    } else if (ext instanceof RegExp) {
      for (const dep of Object.keys(deps)) {
        if (ext.test(dep)) externalDeps[dep] = deps[dep];
      }
    }
  }

  const undeclaredExtraDeps = extraPackageNames.filter((packageName) => !deps[packageName]);
  if (undeclaredExtraDeps.length > 0) {
    throw new Error(
      "[build-server] required package(s) missing from root dependencies: "
        + undeclaredExtraDeps.join(", "),
    );
  }
  for (const packageName of extraPackageNames) {
    externalDeps[packageName] = deps[packageName];
  }

  const bundleExternalImports = collectBareImportPackageNames(
    fs.readFileSync(path.join(bundleOutDir, "index.js"), "utf-8"),
  ).filter((packageName) => !builtinSet.has(packageName));
  const missingBundleExternalDeps = bundleExternalImports
    .filter((packageName) => !externalDeps[packageName]);
  if (missingBundleExternalDeps.length > 0) {
    throw new Error(
      "[build-server] server bundle imports external packages missing from packaged dependencies: "
        + missingBundleExternalDeps.join(", ")
        + ". Add them to root package.json dependencies.",
    );
  }

  log(`[build-server] derived external deps: ${Object.keys(externalDeps).join(", ")}`);

  const rootLock = JSON.parse(fs.readFileSync(path.join(rootDir, "package-lock.json"), "utf-8"));
  const externalPkg = buildExternalPackage(rootPkg, externalDeps, {
    rootLock,
    pinnedTransitiveDeps,
  });
  const pinnedDeps = Object.entries(externalPkg.dependencies)
    .map(([name, version]) => `${name}@${version}`)
    .join(", ");
  log(`[build-server] pinned server deps: ${pinnedDeps}`);

  fs.writeFileSync(
    path.join(outDir, "package.json"),
    JSON.stringify(externalPkg, null, 2) + "\n",
  );

  log("[build-server] installing external dependencies...");
  runWithTargetNode(`"${cachedNpmCli}" install --omit=dev --no-audit --no-fund --ignore-scripts=false`);
  ensureNodePtySpawnHelperExecutable({ baseDir: outDir, platform, arch, isWin });

  // Verify every string Vite external actually resolved into node_modules.
  // RegExp externals are not checked here (matched packages were already
  // derived explicitly above); fsevents is platform-optional.
  const missing = [];
  for (const ext of viteExternals) {
    if (typeof ext !== "string" || builtinSet.has(ext)) continue;
    if (!fs.existsSync(path.join(outDir, "node_modules", ext))) {
      if (OPTIONAL_EXTERNALS.has(ext)) continue;
      missing.push(ext);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[build-server] Vite externals missing from node_modules: ${missing.join(", ")}. `
        + "These packages are external in the bundle but not installed. Fix: add them to root "
        + "package.json dependencies, or check transitive dep chains.",
    );
  }

  verifyExternalEntrypoints(outDir, Object.keys(externalPkg.dependencies));

  // Pi SDK verification: the packaged package.json has no root postinstall,
  // so run the same read-only verification script by hand.
  const patchScript = path.join(rootDir, "scripts", "patch-pi-sdk.cjs");
  if (fs.existsSync(patchScript)) {
    fs.mkdirSync(path.join(outDir, "scripts"), { recursive: true });
    fs.copyFileSync(patchScript, path.join(outDir, "scripts", "patch-pi-sdk.cjs"));
    runWithTargetNode("scripts/patch-pi-sdk.cjs");
    fs.rmSync(path.join(outDir, "scripts"), { recursive: true });
  }

  // node_modules/.bin symlinks point at the build machine's absolute paths
  // (codesign rejects them) and are not needed at server runtime.
  const removedBinDirs = removeBinDirs(path.join(outDir, "node_modules"));
  if (removedBinDirs > 0) {
    log(`[build-server] cleanup: removed ${removedBinDirs} node_modules/.bin director${removedBinDirs === 1 ? "y" : "ies"}`);
  }

  log("[build-server] dependencies installed");

  return { externalPkg, viteExternals, builtinSet, rootPkg };
}

// ── nft prune ────────────────────────────────────────────────────────────

async function readNftTraceSource(filePath) {
  let source;
  try {
    source = await fs.promises.readFile(filePath, "utf-8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") return null;
    throw error;
  }

  if (!/\.(?:cts|mts|tsx?|d\.ts)$/i.test(filePath)) return source;
  return ts.transpileModule(source, {
    fileName: filePath,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  }).outputText;
}

/**
 * @vercel/nft-traces from `nftRoots` (relative to `outDir`) and deletes
 * every node_modules file that trace didn't reach, except files inside a
 * protected package directory (every package.json-declared external, since
 * their conditional-export / CJS-ESM resolution isn't always traced
 * correctly, plus their installed optionalDependencies). Then re-verifies
 * external entrypoints and runs the better-sqlite3 / @node-rs/jieba /
 * @firecrawl/anydoc runtime smoke tests when those packages are present in
 * `externalPackageNames`.
 *
 * @param {{
 *   outDir: string, nftRoots: string[], externalPackageNames: string[],
 *   runWithTargetNode: (cmd: string, opts?: object) => void,
 *   log?: (msg: string) => void,
 * }} params
 */
export async function pruneServerNodeModulesViaNft({
  outDir,
  nftRoots,
  externalPackageNames,
  runWithTargetNode,
  log = (msg) => console.log(msg),
}) {
  log("[build-server] running nft trace...");

  const { nodeFileTrace } = await import("@vercel/nft");
  const nmDir = path.join(outDir, "node_modules");
  let fileList;
  try {
    ({ fileList } = await nodeFileTrace(
      [...nftRoots.map((root) => path.join(outDir, root)), ...optionalServerDependencyRoots(outDir, externalPackageNames)],
      {
        base: outDir,
        conditions: ["node", "import"],
        // On Windows, relative(F:\\..., C:\\...) is still an absolute path.
        // nft's default ../ guard misses it and can crawl the user's entire
        // home directory. Runtime files must come from the staged server tree.
        ignore: (relativePath) => path.isAbsolute(relativePath),
        // Bundled plugins remain as TypeScript source and are loaded through
        // the plugin runtime. nft resolves .ts paths but its parser only
        // accepts JavaScript syntax, so expose a read-only transpiled view for
        // tracing while keeping the packaged files themselves unchanged.
        readFile: readNftTraceSource,
      },
    ));
  } catch (e) {
    // Windows CI 上 nft 可能因用户目录不存在而报错，跳过裁剪
    console.warn(`[build-server] nft trace failed (${e.message}), skipping prune`);
    fileList = null;
  }

  if (fileList) {
    const tracedFiles = new Set();
    for (const f of fileList) {
      tracedFiles.add(path.resolve(outDir, f));
    }

    const protectedDirs = new Set();
    for (const packageName of externalPackageNames) {
      const pkgDir = path.resolve(nmDir, packageName);
      if (fs.existsSync(pkgDir)) {
        protectedDirs.add(pkgDir);
      }
    }
    for (const pkgDir of collectInstalledOptionalDependencyDirs(nmDir, externalPackageNames)) {
      protectedDirs.add(pkgDir);
    }

    if (protectedDirs.size > 0) {
      const names = [...protectedDirs].map((d) => path.relative(nmDir, d));
      log(`[build-server] nft: protecting ${protectedDirs.size} server deps from pruning: ${names.join(", ")}`);
    }

    let removedFiles = 0;
    let removedSize = 0;

    function pruneDir(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (protectedDirs.has(path.resolve(full))) continue;
          pruneDir(full);
          try {
            const remaining = fs.readdirSync(full);
            if (remaining.length === 0) fs.rmdirSync(full);
          } catch {}
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          if (!tracedFiles.has(full)) {
            const size = entry.isFile() ? (fs.statSync(full).size || 0) : 0;
            fs.unlinkSync(full);
            removedFiles++;
            removedSize += size;
          }
        }
      }
    }

    pruneDir(nmDir);

    const keptFiles = fileList.size;
    const MB = (n) => (n / 1024 / 1024).toFixed(0);
    log(`[build-server] nft: kept ${keptFiles} files, removed ${removedFiles} files (${MB(removedSize)}MB)`);
  }

  verifyExternalEntrypoints(outDir, externalPackageNames);

  if (externalPackageNames.includes("better-sqlite3")) {
    const smokeScript = path.join(outDir, ".better-sqlite3-smoke.mjs");
    fs.writeFileSync(smokeScript, buildBetterSqliteRuntimeSmokeScript());
    try {
      runWithTargetNode(path.basename(smokeScript));
    } finally {
      fs.rmSync(smokeScript, { force: true });
    }
  }

  if (externalPackageNames.includes("@node-rs/jieba")) {
    const smokeScript = path.join(outDir, ".jieba-smoke.mjs");
    fs.writeFileSync(smokeScript, buildJiebaRuntimeSmokeScript());
    try {
      runWithTargetNode(path.basename(smokeScript));
    } finally {
      fs.rmSync(smokeScript, { force: true });
    }
  }

  // A packaged server whose document converter cannot load its native binary
  // is a broken product, so this is a hard build failure. The runtime side is
  // deliberately the opposite: a failed load there degrades one extraction
  // attempt into a reported error and never takes the session down with it.
  if (externalPackageNames.includes("@firecrawl/anydoc")) {
    const smokeScript = path.join(outDir, ".anydoc-smoke.mjs");
    fs.writeFileSync(smokeScript, buildAnydocRuntimeSmokeScript());
    try {
      runWithTargetNode(path.basename(smokeScript));
    } finally {
      fs.rmSync(smokeScript, { force: true });
    }
  }
}

// ── Platform-specific package trimming ─────────────────────────────────

/**
 * Removes the non-target-platform binaries koffi and node-pty ship (both
 * would otherwise fail codesign as unsigned foreign-format binaries), the
 * large doc-only directories a couple of specific npm packages carry
 * (@larksuiteoapi/node-sdk's .d.ts tree, exceljs's browser bundle), and
 * every remaining node_modules file that can never be loaded at server
 * runtime (.ts/.map/.md, see build-server-prune.mjs). No-ops for any
 * package that isn't installed, so it is safe to call unconditionally
 * regardless of which external dependency set a given build resolved.
 *
 * @param {{ outDir: string, platform: string, arch: string, log?: (msg: string) => void }} params
 */
export function applyPlatformPackageTrim({ outDir, platform, arch, log = (msg) => console.log(msg) }) {
  const nmDir = path.join(outDir, "node_modules");

  const koffiBuilds = path.join(nmDir, "koffi", "build", "koffi");
  if (fs.existsSync(koffiBuilds)) {
    const target = `${platform === "darwin" ? "darwin" : platform === "win32" ? "win32" : "linux"}_${arch}`;
    let koffiRemoved = 0;
    for (const entry of fs.readdirSync(koffiBuilds)) {
      if (entry !== target) {
        fs.rmSync(path.join(koffiBuilds, entry), { recursive: true, force: true });
        koffiRemoved++;
      }
    }
    if (koffiRemoved > 0) {
      log(`[build-server] koffi: kept ${target}, removed ${koffiRemoved} other platform binaries`);
    }
  }

  const nodePtyPrebuilds = path.join(nmDir, "node-pty", "prebuilds");
  if (fs.existsSync(nodePtyPrebuilds)) {
    const target = `${platform}-${arch}`;
    let nodePtyRemoved = 0;
    for (const entry of fs.readdirSync(nodePtyPrebuilds)) {
      if (entry !== target) {
        fs.rmSync(path.join(nodePtyPrebuilds, entry), { recursive: true, force: true });
        nodePtyRemoved++;
      }
    }
    if (nodePtyRemoved > 0) {
      log(`[build-server] node-pty: kept prebuilds/${target}, removed ${nodePtyRemoved} other platform prebuilds`);
    }
  }

  const larkTypes = path.join(nmDir, "@larksuiteoapi", "node-sdk", "types");
  if (fs.existsSync(larkTypes)) {
    fs.rmSync(larkTypes, { recursive: true, force: true });
    log("[build-server] cleanup: removed @larksuiteoapi/node-sdk/types/ (~15MB .d.ts)");
  }

  const exceljsDist = path.join(nmDir, "exceljs", "dist");
  if (fs.existsSync(exceljsDist)) {
    fs.rmSync(exceljsDist, { recursive: true, force: true });
    log("[build-server] cleanup: removed exceljs/dist/ (~21MB browser bundle)");
  }

  const { removedFiles: prunedFiles, removedSize: prunedSize } = pruneRuntimeDeadFiles(nmDir);
  const prunedMB = (prunedSize / 1024 / 1024).toFixed(1);
  log(`[build-server] prune: removed ${prunedFiles} runtime-dead files from node_modules (${prunedMB}MB)`);
}

// ── package.json version + wrapper scripts ──────────────────────────────

/**
 * npm install leaves `outDir/package.json` in place (already externalPkg's
 * shape) but its version wasn't necessarily set explicitly; write it
 * explicitly so `fromRoot("package.json")` reads at runtime give the real
 * product version.
 *
 * @param {{ outDir: string, version: string }} params
 */
export function finalizeServerPackageJsonVersion({ outDir, version }) {
  const installedPkg = JSON.parse(fs.readFileSync(path.join(outDir, "package.json"), "utf-8"));
  installedPkg.version = version;
  fs.writeFileSync(
    path.join(outDir, "package.json"),
    JSON.stringify(installedPkg, null, 2) + "\n",
  );
}

/**
 * Writes the shell/cmd wrapper scripts that set HANA_ROOT + HANA_SERVER_ENTRY
 * and exec into the packaged Node runtime. `serverEntryRelPath` /
 * `cliEntryRelPath` are relative to `outDir` and default to the shape every
 * composition's bundle produces (`bundle/index.js` / `bundle/cli.js`).
 *
 * @param {{
 *   outDir: string, isWin: boolean,
 *   serverEntryRelPath?: string, cliEntryRelPath?: string,
 *   log?: (msg: string) => void,
 * }} params
 */
export function writeServerWrapperScripts({
  outDir,
  isWin,
  serverEntryRelPath = "bundle/index.js",
  cliEntryRelPath = "bundle/cli.js",
  log = (msg) => console.log(msg),
}) {
  if (isWin) {
    const winServerEntry = serverEntryRelPath.split("/").join("\\");
    const winCliEntry = cliEntryRelPath.split("/").join("\\");
    fs.writeFileSync(
      path.join(outDir, "hana-server.cmd"),
      `@echo off\r\nset "HANA_ROOT=%~dp0"\r\nset "HANA_SERVER_ENTRY=%~dp0${winServerEntry}"\r\n"%~dp0hana-server.exe" "%~dp0bootstrap.js" %*\r\n`,
    );
    fs.writeFileSync(
      path.join(outDir, "hana.cmd"),
      `@echo off\r\nset "HANA_ROOT=%~dp0"\r\nset "HANA_SERVER_ENTRY=%~dp0${winServerEntry}"\r\n"%~dp0hana-server.exe" "%~dp0${winCliEntry}" %*\r\n`,
    );
  } else {
    const wrapper = path.join(outDir, "hana-server");
    fs.writeFileSync(wrapper, [
      "#!/bin/sh",
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      'export HANA_ROOT="$DIR"',
      `export HANA_SERVER_ENTRY="$DIR/${serverEntryRelPath}"`,
      "# Raise file descriptor limit. Server got split out of Electron in v0.67",
      "# (see #765 / #787 root-cause); standalone Node loses Electron's implicit",
      "# fd raise (macOS default 256 → not enough for chokidar + DB + WS + plugins).",
      "# Best-effort: silently fall back if hard limit is lower.",
      "ulimit -n 65536 2>/dev/null || ulimit -n 8192 2>/dev/null || true",
      'exec "$DIR/node" "$DIR/bootstrap.js" "$@"',
      "",
    ].join("\n"));
    fs.chmodSync(wrapper, 0o755);

    const cliWrapper = path.join(outDir, "hana");
    fs.writeFileSync(cliWrapper, [
      "#!/bin/sh",
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      'export HANA_ROOT="$DIR"',
      `export HANA_SERVER_ENTRY="$DIR/${serverEntryRelPath}"`,
      `exec "$DIR/node" "$DIR/${cliEntryRelPath}" "$@"`,
      "",
    ].join("\n"));
    fs.chmodSync(cliWrapper, 0o755);
  }
  log("[build-server] wrapper created");
}
