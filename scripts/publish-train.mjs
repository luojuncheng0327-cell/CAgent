/**
 * scripts/publish-train.mjs — publishes one channel's hot-update train.
 *
 * Takes the platform archives already sitting on an installer release
 * (`vX.Y.Z`, built by .github/workflows/build.yml) and turns them into a
 * signed train manifest for ONE update channel:
 *   1. Downloads that tag's `server-*.tar.gz` + `renderer-*.tar.gz` assets
 *      and hashes them.
 *   2. Reads the channel's current pointer (`channels` release,
 *      `<channel>.json`) to find the last published train number; the next
 *      train is that value + 1, or 1 if the channel has never published.
 *   3. Builds a schema-1 manifest for that train via `buildSeedManifest`
 *      (scripts/build-server-artifact.mjs) — the SAME function the local/CI
 *      seed build uses — called once per platform-arch and merged, so
 *      `contract`/schema come from that one source instead of being
 *      re-invented here. `minShell` is the one exception: it is overwritten
 *      with the hand-maintained `SHELL_COMPAT_FLOOR` constant below instead
 *      of `buildSeedManifest`'s own version-equals-minShell convention,
 *      because that convention is only correct for a seed, not a train
 *      (see the constant's comment for why).
 *   4. Signs it and either creates a new `train-<channel>-<N>` release (archives +
 *      train.json + train.json.sig) or, if that release already exists
 *      with byte-identical artifacts (see "resumable publish" below),
 *      reuses it without re-uploading.
 *   5. Publishes `<channel>.json` + `<channel>.json.sig` to the `channels`
 *      release — the two static files installed clients actually poll
 *      (desktop/src/shared/artifact-ota.cjs's `channelManifestUrls`).
 *
 * Channel independence: stable and beta each keep their own train counter,
 * read from their own `<channel>.json`. A prerelease source Release may
 * advance beta automatically, but stable advances automatically only from
 * a non-prerelease source Release. An operator can deliberately promote a
 * prerelease source to stable only with the explicit CLI override below
 * (the dedicated manual workflow exposes it as a default-off confirmation).
 * The counters are tracked independently and are therefore allowed to drift.
 * Physical box releases carry the channel in their identity, so stable train
 * 14 and beta train 14 can safely hold different artifacts.
 *
 * Resumable publish: this script may be re-run for a tag/channel pair that
 * already succeeded, or that failed partway through (the CI job that
 * calls it is not transactional). After computing the target train N, if a
 * `train-<channel>-<N>` release already exists, its train.json is downloaded and
 * compared against this run's freshly-computed artifacts (version + sha256
 * + size + path per archive — NOT full-manifest equality, since releasedAt
 * and rollout.salt are expected to differ run-to-run). An
 * exact artifact match means train N was already built by an earlier
 * interrupted run on the same channel and it is safe to
 * skip re-uploading the boxes; a mismatch is a real conflict and is a hard
 * error — never silently overwritten. Either way, THIS channel's pointer
 * (`<channel>.json`) is always its own freshly signed manifest carrying
 * this channel's name, train number, releasedAt and rollout salt — it is
 * never a byte-copy of the box release's train.json, so `beta.json` always
 * reads `channel: "beta"`.
 *
 * Legacy migration: already-signed channel pointers may still name the old
 * global `train-<N>` release in `mirrors`. Clients keep following that exact
 * URL. The next publish reads only the pointer's numeric train, increments it,
 * and writes a new pointer whose mirror names `train-<channel>-<N+1>`. No old
 * pointer or release is rewritten, and the manifest schema does not change.
 *
 * Anti-rollback: train numbers only go up, per channel, forever. There is
 * no "delete a train" or "go back to N-1" operation. A bad release is
 * fixed by publishing a NEW, higher-numbered train that points at good
 * artifacts — never by mutating or removing a past one.
 *
 * Usage:
 *   node scripts/publish-train.mjs --tag vX.Y.Z --channel stable|beta [--dry-run]
 *     [--allow-prerelease-stable]
 *
 * Env:
 *   GH_TOKEN            required (gh CLI auth)
 *   HANA_SIGN_KEY       required for a real (non-dry-run) publish — PKCS8 PEM
 *                        private key path, same key the seed build uses
 *   GITHUB_REPOSITORY   "owner/repo"; set automatically inside GitHub Actions
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildSeedManifest } from "./build-server-artifact.mjs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const manifestModule = require("../shared/artifact-core/manifest.cjs");
const activation = require("../shared/artifact-core/activation.cjs");
const { loadPinnedKeyset } = require("../shared/artifact-core/keyset.cjs");

const releaseSource = require("../shared/release-source.cjs");
const DEFAULT_REPO = `${releaseSource.owner}/${releaseSource.repo}`;

const TRAIN_RELEASE_NOTES =
  "Hot-update train release. Holds one train's signed archives and manifest "
  + "(train.json / train.json.sig); already-installed clients download from "
  + "here automatically. This is not an installer download page.";

const CHANNELS_RELEASE_NOTES =
  "Live channel pointer release. stable.json / beta.json (and their .sig "
  + "files) are overwritten in place on every publish; installed clients "
  + "poll only these two static files to discover the newest train.";

// The oldest installed shell (the app itself, not the hot-update payload)
// that a train is still allowed to reach. This is deliberately NOT the
// train's own version: `buildSeedManifest` sets `minShell: version` because
// a seed is built into and ships inside one specific shell, so "minShell
// equals my own version" is correct there. A train is different — it is
// pulled down by whatever shell version a user already has installed, so
// pinning minShell to the train's version would mean every single train
// demands the newest shell, and nobody's existing install would ever pass
// the gate (see desktop/src/shared/artifact-ota.cjs's
// isShellVersionSufficient). Bump this by hand ONLY when a train's content
// starts depending on a shell capability older installs don't have (a new
// preload API, a new server-launch protocol, etc.) — raising it means every
// shell older than this version stops receiving hot updates and has to
// update the app itself first, so don't raise it casually.
export const SHELL_COMPAT_FLOOR = "0.450.1";

// ── argument parsing ────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {{tag: string, channel: "stable"|"beta", dryRun: boolean, allowPrereleaseStable: boolean}}
 */
export function parseArgs(argv) {
  const args = { tag: null, channel: null, dryRun: false, allowPrereleaseStable: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag") args.tag = argv[++i];
    else if (arg === "--channel") args.channel = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--allow-prerelease-stable") args.allowPrereleaseStable = true;
    else throw new Error(`publish-train: unknown argument ${arg}`);
  }
  if (!args.tag) throw new Error("publish-train: --tag is required");
  if (args.channel !== "stable" && args.channel !== "beta") {
    throw new Error(`publish-train: --channel must be "stable" or "beta" (got ${JSON.stringify(args.channel)})`);
  }
  if (args.allowPrereleaseStable && args.channel !== "stable") {
    throw new Error("publish-train: --allow-prerelease-stable is only valid with --channel stable");
  }
  return args;
}

// ── archive filename parsing (matches packServerArchive/packRendererArtifact
//    naming in scripts/build-server-artifact.mjs) ───────────────────────────

const SERVER_ARCHIVE_RE = /^server-(.+)-([a-z0-9]+)-([a-z0-9]+)\.tar\.gz$/;
const RENDERER_ARCHIVE_RE = /^renderer-(.+)\.tar\.gz$/;

/**
 * @param {string} filename
 * @returns {{version: string, platform: string, arch: string} | null}
 */
export function parseServerArchiveName(filename) {
  const match = SERVER_ARCHIVE_RE.exec(filename);
  if (!match) return null;
  return { version: match[1], platform: match[2], arch: match[3] };
}

/**
 * @param {string} filename
 * @returns {{version: string} | null}
 */
export function parseRendererArchiveName(filename) {
  const match = RENDERER_ARCHIVE_RE.exec(filename);
  if (!match) return null;
  return { version: match[1] };
}

// ── train number / mirrors ──────────────────────────────────────────────

/**
 * Anti-rollback lives here: the next train is always "last published + 1"
 * for THIS channel, or 1 if the channel has never published. A channel
 * pointer that exists but carries an unparseable train number is a hard
 * error — guessing (e.g. restarting from 1) would silently break the
 * monotonic chain client's `checkMonotonic` relies on.
 * @param {{train: number} | null} existingChannelManifest
 * @returns {number}
 */
export function computeNextTrain(existingChannelManifest) {
  if (existingChannelManifest === null || existingChannelManifest === undefined) return 1;
  const { train } = existingChannelManifest;
  if (!Number.isInteger(train) || train < 0) {
    throw new Error(
      `publish-train: existing channel manifest has an unparseable train field (${JSON.stringify(train)}); `
        + "refusing to guess a starting point — that would break the anti-rollback chain. Fix the published "
        + "channel pointer manually before retrying.",
    );
  }
  return train + 1;
}

/**
 * AtomGit does not mirror the `train-<channel>-<N>` release tag yet — only the
 * `channels` pointer tag has scheduled mirroring wired up (see the note in
 * desktop/src/shared/artifact-ota.cjs above ATOMGIT_CHANNEL_BASE). GitHub
 * is therefore the only mirror for now; add the AtomGit base here once a
 * `--tag train-<channel>-<N>` mirror job exists.
 * @param {{channel: "stable"|"beta", train: number}} opts
 * @returns {string}
 */
export function computeTrainReleaseTag({ channel, train }) {
  if (channel !== "stable" && channel !== "beta") {
    throw new Error(`computeTrainReleaseTag: channel must be "stable" or "beta", got ${JSON.stringify(channel)}`);
  }
  if (!Number.isInteger(train) || train < 1) {
    throw new Error(`computeTrainReleaseTag: train must be a positive integer, got ${JSON.stringify(train)}`);
  }
  return `train-${channel}-${train}`;
}

/**
 * @param {{repo: string, channel: "stable"|"beta", train: number}} opts
 * @returns {string[]}
 */
export function computeMirrors({ repo, channel, train }) {
  if (!repo || !repo.includes("/")) {
    throw new Error(`computeMirrors: repo must be "owner/repo", got ${JSON.stringify(repo)}`);
  }
  const trainTag = computeTrainReleaseTag({ channel, train });
  return [`https://github.com/${repo}/releases/download/${trainTag}`];
}

// ── manifest assembly (reuses buildSeedManifest, never a parallel builder) ─

/**
 * Assembles one schema-1 train manifest covering every platform-arch server
 * archive plus the shared renderer archive. `contract` is NOT invented
 * here: each platform-arch entry is produced by calling `buildSeedManifest`
 * (the same function the seed/train-0 build uses) and the per-platform
 * results are merged, so that field — and the schema number — come from
 * that one source. `buildSeedManifest` computes them the same way
 * regardless of platform/arch, so the per-call results are expected to
 * agree; the check below is a cheap guard against that assumption silently
 * breaking in the future, not a live concern today.
 *
 * `minShell` is the one field deliberately NOT taken from
 * `buildSeedManifest`: that function sets `minShell: version`, which is
 * correct for a seed (it ships inside one specific shell) but wrong for a
 * train (see `SHELL_COMPAT_FLOOR` above for why). It is overwritten with
 * `SHELL_COMPAT_FLOOR` below.
 * @param {{
 *   version: string, releasedAt: string, keyId: string,
 *   channel: "stable"|"beta", train: number,
 *   rendererEntry: {sha256: string, size: number, archiveName: string},
 *   serverEntries: Array<{platform: string, arch: string, sha256: string, size: number, archiveName: string}>,
 *   mirrors: string[], rolloutSalt: string,
 * }} opts
 * @returns {object} a schema-1 manifest, already self-validated
 */
export function assembleTrainManifest({
  version,
  releasedAt,
  keyId,
  channel,
  train,
  rendererEntry,
  serverEntries,
  mirrors,
  rolloutSalt,
}) {
  if (!Array.isArray(serverEntries) || serverEntries.length === 0) {
    throw new Error("assembleTrainManifest: at least one server artifact entry is required");
  }

  const perPlatform = serverEntries.map((entry) =>
    buildSeedManifest({
      version,
      platform: entry.platform,
      arch: entry.arch,
      keyId,
      releasedAt,
      renderer: rendererEntry,
      server: entry,
    }));

  const base = perPlatform[0];
  for (const m of perPlatform) {
    if (m.schema !== base.schema || m.minShell !== base.minShell || JSON.stringify(m.contract) !== JSON.stringify(base.contract)) {
      throw new Error(
        "assembleTrainManifest: buildSeedManifest produced different schema/minShell/contract across platforms "
          + "for the same version/keyId/releasedAt — this should be impossible; refusing to merge",
      );
    }
  }

  const mergedServer = Object.assign({}, ...perPlatform.map((m) => m.artifacts.server));

  const manifest = {
    schema: base.schema,
    train,
    channel,
    releasedAt,
    keyId,
    minShell: SHELL_COMPAT_FLOOR,
    contract: base.contract,
    urgent: false,
    rollout: { percent: 100, salt: rolloutSalt },
    artifacts: { renderer: base.artifacts.renderer, server: mergedServer },
    mirrors,
  };

  manifestModule.validateManifest(manifest); // self-check before it ever gets signed/published
  return manifest;
}

// ── resumable-publish comparison (full artifact-entry identity; deliberately
//    ignores channel/releasedAt/rollout.salt, which differ run-to-run and
//    channel-to-channel by design) ──────────────────────────────────────

/**
 * @param {object} a
 * @param {object} b
 * @returns {{matches: boolean, mismatches: string[]}}
 */
export function diffManifestArtifacts(a, b) {
  const mismatches = [];
  const ar = a.artifacts && a.artifacts.renderer;
  const br = b.artifacts && b.artifacts.renderer;
  const describeEntryMismatch = (label, left, right) => {
    if (!left || !right) return `${label}: entry(${left ? "present" : "missing"} vs ${right ? "present" : "missing"})`;
    const fields = ["version", "sha256", "size", "path"];
    const changed = fields.filter((field) => left[field] !== right[field]);
    if (changed.length === 0) return null;
    return `${label}: ${changed.map((field) => `${field}(${JSON.stringify(left[field])} vs ${JSON.stringify(right[field])})`).join(" ")}`;
  };
  const rendererMismatch = describeEntryMismatch("renderer", ar, br);
  if (rendererMismatch) mismatches.push(rendererMismatch);
  const aServers = (a.artifacts && a.artifacts.server) || {};
  const bServers = (b.artifacts && b.artifacts.server) || {};
  const keys = new Set([...Object.keys(aServers), ...Object.keys(bServers)]);
  for (const key of keys) {
    const av = aServers[key];
    const bv = bServers[key];
    const serverMismatch = describeEntryMismatch(`server.${key}`, av, bv);
    if (serverMismatch) mismatches.push(serverMismatch);
  }
  return { matches: mismatches.length === 0, mismatches };
}

function manifestTargetsVersion(manifest, version) {
  const versions = [];
  const renderer = manifest?.artifacts?.renderer;
  if (renderer) versions.push(renderer.version);
  const servers = manifest?.artifacts?.server || {};
  for (const entry of Object.values(servers)) versions.push(entry.version);
  return versions.length > 0 && versions.every((entryVersion) => entryVersion === version);
}

/**
 * Throws with a descriptive message when `existingTrainManifest`'s
 * artifacts don't match `candidateManifest`'s — a real conflict that needs
 * a human, never silently resolved by picking one side.
 * @param {object} candidateManifest
 * @param {object} existingTrainManifest
 */
export function assertArtifactsMatchForResume(candidateManifest, existingTrainManifest) {
  const diff = diffManifestArtifacts(candidateManifest, existingTrainManifest);
  if (!diff.matches) {
    throw new Error(
      `publish-train: ${candidateManifest.channel} train ${candidateManifest.train} release already exists but its artifacts differ from `
        + "this run's freshly-built boxes -- this is a real conflict, not a safe resume:\n"
        + diff.mismatches.map((m) => `  - ${m}`).join("\n"),
    );
  }
}

// ── HANA_SIGN_KEY guard (mirrors requireSignKeyPath in build-server-artifact.mjs) ─

function requireSignKeyPath(env) {
  const signKeyPath = env.HANA_SIGN_KEY;
  if (!signKeyPath) {
    throw new Error(
      "publish-train: HANA_SIGN_KEY is not set. A published channel pointer MUST be signed; "
        + "set HANA_SIGN_KEY=<private-key-path> (same key the seed build uses).",
    );
  }
  if (!fs.existsSync(signKeyPath)) {
    throw new Error(`publish-train: HANA_SIGN_KEY points at a missing file: ${signKeyPath}`);
  }
  return signKeyPath;
}

// ── gh CLI shell (thin IO layer, all mockable via deps) ─────────────────

function ghExec(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * "Release exists" may only read as false on gh's actual missing-release
 * error. Auth failures, rate limits, network errors etc. MUST propagate:
 * misreading them as "absent" would silently restart a channel's train
 * numbering at 1 (breaking the anti-rollback chain clients enforce) or
 * wrongly attempt to re-create an existing train release. Measured against
 * gh 2.92.0: `gh release view <missing-tag> --json tagName` exits 1 with
 * stderr exactly "release not found".
 * @param {string} tag
 * @param {(args: string[]) => string} exec - throws on non-zero exit with
 *   the child's stderr on the error's `stderr` property (execFileSync shape)
 * @returns {boolean}
 */
export function releaseExistsFromExec(tag, exec) {
  try {
    exec(["release", "view", tag, "--json", "tagName"]);
    return true;
  } catch (err) {
    const stderr = err && err.stderr != null ? String(err.stderr) : "";
    if (stderr.includes("release not found")) return false;
    // Spawn-level failures (gh binary missing etc.) carry no stderr —
    // nothing to classify, rethrow untouched.
    if (!stderr) throw err;
    throw new Error(`publish-train: gh release view ${tag} failed: ${stderr.trim()}`, { cause: err });
  }
}

function defaultReleaseExists(tag) {
  return releaseExistsFromExec(tag, ghExec);
}

/**
 * Reads the installer/source Release classification used only by the
 * publisher's channel policy. Installed clients continue to trust only the
 * signed channel pointer; this metadata is never added to their decision
 * path.
 * @param {string} tag
 * @param {(args: string[]) => string} exec
 * @returns {{tagName: string, isDraft: boolean, isPrerelease: boolean}}
 */
export function releaseInfoFromExec(tag, exec) {
  let parsed;
  try {
    const raw = exec(["release", "view", tag, "--json", "tagName,isDraft,isPrerelease"]);
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`publish-train: could not read source release metadata for ${tag}`, { cause: err });
  }

  if (
    !parsed
    || parsed.tagName !== tag
    || typeof parsed.isDraft !== "boolean"
    || typeof parsed.isPrerelease !== "boolean"
  ) {
    throw new Error(`publish-train: source release metadata for ${tag} is malformed or names a different tag`);
  }
  return {
    tagName: parsed.tagName,
    isDraft: parsed.isDraft,
    isPrerelease: parsed.isPrerelease,
  };
}

function defaultReleaseInfo(tag) {
  return releaseInfoFromExec(tag, ghExec);
}

/**
 * @param {{
 *   tag: string,
 *   channel: "stable"|"beta",
 *   sourceRelease: {tagName: string, isDraft: boolean, isPrerelease: boolean},
 *   allowPrereleaseStable: boolean,
 * }} opts
 */
export function assertSourceReleaseEligible({
  tag,
  channel,
  sourceRelease,
  allowPrereleaseStable,
}) {
  if (!sourceRelease || sourceRelease.tagName !== tag) {
    throw new Error(`publish-train: source release metadata does not match requested tag ${tag}`);
  }
  if (sourceRelease.isDraft) {
    throw new Error(`publish-train: source release ${tag} is still a draft and cannot publish an update train`);
  }
  if (channel === "stable" && sourceRelease.isPrerelease && !allowPrereleaseStable) {
    throw new Error(
      `publish-train: source release ${tag} is a prerelease; prerelease releases may advance beta automatically, `
        + "but stable requires a non-prerelease release or an explicit manual stable publish",
    );
  }
}

function defaultReleaseAssetNames(tag) {
  const out = ghExec(["release", "view", tag, "--json", "assets", "--jq", ".assets[].name"]);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function defaultDownloadAssets(tag, patterns, destDir) {
  const args = ["release", "download", tag, "--dir", destDir, "--clobber"];
  for (const p of patterns) args.push("--pattern", p);
  ghExec(args);
}

function defaultCreateRelease(tag, files, { title, notes }) {
  ghExec(["release", "create", tag, ...files, "--title", title, "--notes", notes, "--prerelease"]);
}

function defaultUploadAssets(tag, files) {
  ghExec(["release", "upload", tag, ...files, "--clobber"]);
}

function defaultSignManifest(manifestPath, signKeyPath) {
  execFileSync(
    process.execPath,
    [path.join(ROOT, "scripts", "artifact-sign.mjs"), "--key", signKeyPath, "--file", manifestPath],
    { stdio: "pipe" },
  );
}

function defaultVerifyManifest(manifestBytes, signatureBytes) {
  return manifestModule.verifyManifest(manifestBytes, signatureBytes, loadPinnedKeyset());
}

// ── box discovery: download the tag's archives, parse + hash them ───────

/**
 * @param {{tag: string, workDir: string, deps: object}} opts
 * @returns {Promise<{
 *   serverEntries: Array<{platform: string, arch: string, archiveName: string, filePath: string, sha256: string, size: number}>,
 *   rendererEntry: {archiveName: string, filePath: string, sha256: string, size: number},
 * }>}
 */
export async function discoverBoxes({ tag, workDir, deps }) {
  const version = tag.replace(/^v/, "");
  deps.downloadAssets(tag, ["server-*.tar.gz", "renderer-*.tar.gz"], workDir);

  const files = deps.readdir(workDir);
  const serverFiles = files.filter((f) => f.startsWith("server-") && f.endsWith(".tar.gz")).sort();
  const rendererFiles = files.filter((f) => f.startsWith("renderer-") && f.endsWith(".tar.gz")).sort();

  if (rendererFiles.length !== 1) {
    throw new Error(
      `discoverBoxes: expected exactly one renderer archive on release ${tag}, found ${rendererFiles.length} `
        + `(${rendererFiles.join(", ") || "none"})`,
    );
  }
  if (serverFiles.length === 0) {
    throw new Error(`discoverBoxes: no server archives found on release ${tag}`);
  }

  const serverEntries = [];
  for (const filename of serverFiles) {
    const parsed = parseServerArchiveName(filename);
    if (!parsed) throw new Error(`discoverBoxes: could not parse server archive filename: ${filename}`);
    if (parsed.version !== version) {
      throw new Error(
        `discoverBoxes: server archive ${filename} carries version ${parsed.version}, expected ${version} `
          + `(release tag ${tag}) — stale asset on the release?`,
      );
    }
    const filePath = path.join(workDir, filename);
    serverEntries.push({
      platform: parsed.platform,
      arch: parsed.arch,
      archiveName: filename,
      filePath,
      sha256: await deps.sha256File(filePath),
      size: deps.statSize(filePath),
    });
  }

  const rendererFilename = rendererFiles[0];
  const rendererParsed = parseRendererArchiveName(rendererFilename);
  if (!rendererParsed) throw new Error(`discoverBoxes: could not parse renderer archive filename: ${rendererFilename}`);
  if (rendererParsed.version !== version) {
    throw new Error(
      `discoverBoxes: renderer archive ${rendererFilename} carries version ${rendererParsed.version}, expected `
        + `${version} (release tag ${tag}) — stale asset on the release?`,
    );
  }
  const rendererFilePath = path.join(workDir, rendererFilename);
  const rendererEntry = {
    archiveName: rendererFilename,
    filePath: rendererFilePath,
    sha256: await deps.sha256File(rendererFilePath),
    size: deps.statSize(rendererFilePath),
  };

  return { serverEntries, rendererEntry };
}

// ── per-channel publish orchestration ────────────────────────────────────

/**
 * @param {{
 *   tag: string, channel: "stable"|"beta", dryRun: boolean, repo: string,
 *   releasedAt: string, boxes: object, env: NodeJS.ProcessEnv, deps: object,
 *   allowPrereleaseStable?: boolean,
 *   log: (msg: string) => void,
 * }} opts
 * @returns {Promise<{
 *   action: "dry-run"|"created"|"resumed"|"already-published",
 *   channel: string,
 *   train: number,
 *   trainTag: string|null,
 * }>}
 */
export async function publishChannel({
  tag,
  channel,
  dryRun,
  repo,
  releasedAt,
  boxes,
  env,
  deps,
  log,
  allowPrereleaseStable = false,
}) {
  const sourceRelease = deps.releaseInfo(tag);
  assertSourceReleaseEligible({ tag, channel, sourceRelease, allowPrereleaseStable });

  const version = tag.replace(/^v/, "");
  const keyId = loadPinnedKeyset()[0].keyId;

  const channelsExists = deps.releaseExists("channels");
  let existingChannelManifest = null;
  if (channelsExists) {
    const assetNames = deps.releaseAssetNames("channels");
    const pointerName = `${channel}.json`;
    const signatureName = `${pointerName}.sig`;
    const hasPointer = assetNames.includes(pointerName);
    const hasSignature = assetNames.includes(signatureName);
    if (hasPointer !== hasSignature) {
      throw new Error(
        `publish-train: channel pointer ${pointerName} and its signature are incomplete on the channels release; `
          + "refusing to derive the anti-rollback train from unsigned or partial state",
      );
    }
    if (hasPointer) {
      const dir = deps.mkdtemp(`hana-publish-train-pointer-read-${channel}-`);
      deps.downloadAssets("channels", [pointerName, signatureName], dir);
      existingChannelManifest = deps.verifyManifest(
        deps.readFile(path.join(dir, pointerName)),
        deps.readFile(path.join(dir, signatureName)),
      );
      if (existingChannelManifest.channel !== channel) {
        throw new Error(
          `publish-train: signed channel pointer ${pointerName} names channel `
            + `${JSON.stringify(existingChannelManifest.channel)}, expected ${JSON.stringify(channel)}`,
        );
      }
    }
  }

  const train = computeNextTrain(existingChannelManifest);
  const trainTag = computeTrainReleaseTag({ channel, train });
  const mirrors = computeMirrors({ repo, channel, train });
  const rolloutSalt = deps.randomSalt();
  const candidateManifest = assembleTrainManifest({
    version,
    releasedAt,
    keyId,
    channel,
    train,
    rendererEntry: boxes.rendererEntry,
    serverEntries: boxes.serverEntries,
    mirrors,
    rolloutSalt,
  });

  if (existingChannelManifest) {
    const publishedDiff = diffManifestArtifacts(candidateManifest, existingChannelManifest);
    if (publishedDiff.matches) {
      log(
        `[publish-train] channel=${channel} already points at identical source artifacts `
          + `(train ${existingChannelManifest.train}); no publish needed`,
      );
      return {
        action: "already-published",
        channel,
        train: existingChannelManifest.train,
        trainTag: null,
      };
    }
    if (manifestTargetsVersion(existingChannelManifest, version)) {
      throw new Error(
        `publish-train: channel=${channel} already publishes the same content version ${version} with different artifacts `
          + "from the source Release. Refusing to advance the train for the same content version; "
          + "the Release assets or channel pointer may have been mutated:\n"
          + publishedDiff.mismatches.map((mismatch) => `  - ${mismatch}`).join("\n"),
      );
    }
  }

  if (dryRun) {
    log(`[dry-run] channel=${channel}: would target ${trainTag} (previous train on this channel: ${existingChannelManifest ? existingChannelManifest.train : "none"})`);
    log(`[dry-run] candidate manifest:\n${JSON.stringify(candidateManifest, null, 2)}`);
    return { action: "dry-run", channel, train, trainTag };
  }

  const signKeyPath = requireSignKeyPath(env);
  const trainExists = deps.releaseExists(trainTag);
  let resumed = false;

  if (trainExists) {
    const dir = deps.mkdtemp(`hana-publish-train-existing-${trainTag}-`);
    deps.downloadAssets(trainTag, ["train.json", "train.json.sig"], dir);
    const existingManifest = deps.verifyManifest(
      deps.readFile(path.join(dir, "train.json")),
      deps.readFile(path.join(dir, "train.json.sig")),
    );
    if (existingManifest.channel !== channel || existingManifest.train !== train) {
      throw new Error(
        `publish-train: signed manifest on ${trainTag} identifies channel/train `
          + `${JSON.stringify(existingManifest.channel)}/${JSON.stringify(existingManifest.train)}, `
          + `expected ${JSON.stringify(channel)}/${train}`,
      );
    }
    assertArtifactsMatchForResume(candidateManifest, existingManifest); // throws on real conflict
    resumed = true;
    log(`[publish-train] ${trainTag} already carries matching artifacts; skipping box upload for channel=${channel}`);
  } else {
    const workDir = deps.mkdtemp(`hana-publish-train-new-${trainTag}-`);
    const manifestPath = path.join(workDir, "train.json");
    deps.writeFile(manifestPath, JSON.stringify(candidateManifest, null, 2) + "\n");
    deps.signManifest(manifestPath, signKeyPath);
    const files = [
      ...boxes.serverEntries.map((e) => e.filePath),
      boxes.rendererEntry.filePath,
      manifestPath,
      `${manifestPath}.sig`,
    ];
    deps.createRelease(trainTag, files, { title: trainTag, notes: TRAIN_RELEASE_NOTES });
    log(`[publish-train] created ${trainTag} for channel=${channel} (train ${train})`);
  }

  // The channel pointer is always OUR OWN freshly signed manifest — never a
  // byte-copy of another channel's train.json — so `<channel>.json` always
  // carries the correct channel name independently from the physical box
  // release (see file header).
  const pointerDir = deps.mkdtemp(`hana-publish-train-pointer-write-${channel}-`);
  const pointerManifestPath = path.join(pointerDir, `${channel}.json`);
  deps.writeFile(pointerManifestPath, JSON.stringify(candidateManifest, null, 2) + "\n");
  deps.signManifest(pointerManifestPath, signKeyPath);
  const pointerFiles = [pointerManifestPath, `${pointerManifestPath}.sig`];

  if (!channelsExists) {
    deps.createRelease("channels", pointerFiles, { title: "channels", notes: CHANNELS_RELEASE_NOTES });
  } else {
    deps.uploadAssets("channels", pointerFiles);
  }
  log(`[publish-train] channel=${channel} pointer now at train ${train}`);

  return { action: resumed ? "resumed" : "created", channel, train, trainTag };
}

// ── entry point ───────────────────────────────────────────────────────────

/**
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {object} [depsOverride] - injectable IO layer for tests
 */
export async function run(argv = process.argv.slice(2), env = process.env, depsOverride = {}) {
  const args = parseArgs(argv);
  const repo = env.GITHUB_REPOSITORY || DEFAULT_REPO;

  const deps = {
    releaseInfo: defaultReleaseInfo,
    releaseExists: defaultReleaseExists,
    releaseAssetNames: defaultReleaseAssetNames,
    downloadAssets: defaultDownloadAssets,
    createRelease: defaultCreateRelease,
    uploadAssets: defaultUploadAssets,
    signManifest: defaultSignManifest,
    verifyManifest: defaultVerifyManifest,
    sha256File: activation.sha256File,
    statSize: (p) => fs.statSync(p).size,
    readFile: (p) => fs.readFileSync(p),
    writeFile: (p, data) => fs.writeFileSync(p, data),
    readdir: (p) => fs.readdirSync(p),
    mkdtemp: (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    randomSalt: () => crypto.randomBytes(16).toString("hex"),
    now: () => new Date().toISOString(),
    ...depsOverride,
  };
  const log = deps.log || console.log;
  const allowPrereleaseStable = args.allowPrereleaseStable;

  const boxesWorkDir = deps.mkdtemp(`hana-publish-train-boxes-${args.channel}-`);
  const boxes = await discoverBoxes({ tag: args.tag, workDir: boxesWorkDir, deps });
  const releasedAt = deps.now();

  const result = await publishChannel({
    tag: args.tag,
    channel: args.channel,
    dryRun: args.dryRun,
    repo,
    releasedAt,
    boxes,
    env,
    deps,
    log,
    allowPrereleaseStable,
  });

  log(`[publish-train] done: ${JSON.stringify(result)}`);
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
