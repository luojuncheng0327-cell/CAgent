"use strict";

/**
 * shared/artifact-core/ota-core.cjs — hot-update train check + download/
 * apply pipeline core: check, verify, download, activate. This is the part
 * of the OTA water pipe any future consumer (desktop shell today, a
 * server/CLI form tomorrow) can run without importing anything under
 * desktop/ — no Electron, no shell timer wiring, no dev-only transport
 * override required statically. The desktop shell
 * (`desktop/src/shared/artifact-ota.cjs`) is a thin wrapper: it keeps the
 * static `require("./artifact-ota-dev-bypass.cjs")` (vite's bundle-time
 * alias swap depends on that exact literal specifier) and injects the real
 * dev-bypass module into every entry point here via an explicit
 * `devBypass` opt; every function below defaults to "no override, ever"
 * when the caller doesn't pass one (see `NO_DEV_OVERRIDE`). The shell also
 * owns `scheduleBackgroundOtaChecks` (setTimeout/setInterval cadence) and
 * `hasDevOverrideConfigured` — pure shell timer/wiring concerns, not part
 * of the pipeline itself.
 *
 * Split into two entry points on purpose:
 *
 *   `checkOnce` — safe to run automatically on a timer. Fetches the channel
 *   manifest, verifies it, runs every gate, and figures out whether a real
 *   update exists. It NEVER writes an archive to disk, NEVER extracts
 *   anything, and NEVER touches a pointer file. The only disk writes are
 *   bookkeeping: `ota-state.json` (what did the last check find) and the
 *   per-install rollout-id file. Every failure is caught, logged, and
 *   recorded in `ota-state.json`; this function never rejects.
 *
 *   `downloadAndApplyArtifacts` — the only function in this module allowed
 *   to write an archive to disk or call `activateFromArchive`. It is only
 *   ever meant to run because a person clicked something: automatic
 *   background code must never call it. It re-fetches the manifest
 *   (bypassing the ETag cache, since the shelf may have moved since the
 *   last check), re-runs every gate (the shelf may have moved), stages both
 *   archives with progress callbacks, then activates server before
 *   renderer.
 *
 * Why the split exists: the previous single `checkAndDownloadOnce` function
 * did "check + download + stage + activate" as one silent background
 * operation on a timer, and a bug in the activation step could corrupt the
 * active installation before it was root-caused and fixed.
 * The fix for that bug is `activateFromArchive`'s current claim/refuse
 * semantics; this split is the second half of the fix — no code path may
 * write bytes to an artifacts directory without a human in the loop.
 *
 * Gate order (both entry points), each short-circuits the rest on failure:
 *   fetch the GitHub channel manifest once (ETag-cached for checkOnce,
 *   ETag-bypassed for downloadAndApplyArtifacts)
 *     -> ed25519 verify + schema validate happens INSIDE the fetch step
 *        above (one atomic call into the protected artifact-core
 *        `manifest.verifyManifest` — see the "verify-order note" below)
 *     -> channel namespace assertion (checkOnce/downloadAndApplyArtifacts
 *        only, on the winning manifest — see the "channel assertion" note
 *        below): the manifest's own `channel` field must equal the channel
 *        that was actually requested
 *     -> train monotonic, SOFTENED for checkOnce: a train that is not
 *        strictly newer than the currently activated train is reported as
 *        "up-to-date", not an error (a background check finding nothing
 *        new is normal, not exceptional). downloadAndApplyArtifacts keeps
 *        this as a hard failure — there is nothing to apply.
 *     -> content reconciliation (checkOnce only): even when the train
 *        number did advance, if this platform's server entry and the
 *        renderer entry both hash to exactly what's already recorded on
 *        the `current` pointer, there is no real update — report
 *        "up-to-date" rather than surfacing a phantom "new version"
 *        because a release got re-cut with the same bytes under a new
 *        train number. The same "up-to-date" outcome is also reported when
 *        the version numbers already match even if the bytes don't — a
 *        version directory is named after the version number, so content
 *        stamped with a version that's already activated can never be
 *        applied anyway, regardless of what its sha256 says (see
 *        `isVersionAlreadyCurrent`'s doc comment).
 *     -> minShell (shell too old -> the update is real but blocked; the
 *        shell's own update is electron-updater's job, not this module's)
 *     -> preload contract (same shape as minShell, one level more specific:
 *        this train's renderer needs a preload API version this shell
 *        doesn't expose yet; reported through the same "minshell-blocked"
 *        outcome, see `isPreloadContractSatisfied`)
 *     -> rollout bucket (dedicated random UUID in HANA_HOME)
 *     -> quarantine short-circuit (train permanently blacklisted)
 *     -> [downloadAndApplyArtifacts only] acquire the artifacts directory
 *        lock (the loser fails this call — someone else is already
 *        updating) -> stage both archives (renderer + this platform's
 *        server) to `staging/`, mirror failover per archive, size-capped,
 *        streamed, atomic rename, sha256-verified, with progress reported
 *        through `onProgress` -> `activateFromArchive` per kind (extract +
 *        `.verified` + write that kind's `next` pointer) — server first,
 *        then renderer; if renderer's activation fails, the server `next`
 *        pointer written a moment earlier is rolled back
 *        (`pointerStore.clearPointer`) so "either both next pointers land
 *        or neither does" holds even though `activateFromArchive` itself
 *        only guarantees atomicity per kind, not across the two calls (see
 *        the "why a rollback" note below) -> staging cleaned up in a
 *        `finally`, lock released in a `finally`
 *
 * Activation to `current` happens at the NEXT LAUNCH, entirely inside
 * `desktop/src/shared/artifact-boot.cjs`; both kinds use the same promotion contract:
 * both `prepareArtifactServerBoot` and `prepareArtifactRendererBoot`
 * call `pointerStore.promote(homeDir, <their channel>)` as the first thing
 * they do). `downloadAndApplyArtifacts` writes `next` pointers and nothing
 * else — it never promotes, never touches `current`/`previous` itself;
 * promotion happens through the existing apply-now sequence
 * (`train-update-apply.cjs`) or at the next ordinary launch. A running
 * session is never hot-swapped by this module.
 *
 * Verify-order note: callers require both schema validation and signature
 * verification before any manifest field is trusted. The sole
 * sanctioned entry point for both checks,
 * `shared/artifact-core/manifest.cjs#verifyManifest` (protected, consumed
 * not modified), internally does JSON-parse-and-schema-validate FIRST and
 * ed25519-verify SECOND, bundled into one atomic call — no manifest content
 * is ever trusted or acted on until BOTH have passed, which is the
 * externally observable guarantee that matters here. Re-deriving
 * a parallel raw-signature-first check in this file would duplicate the
 * keyset-lookup + `crypto.verify` logic that already lives in exactly one
 * place. Because `validateManifest` is side-effect-free type/shape checking
 * on a small bounded buffer (no parser-injection surface the way an
 * XML/YAML parser would have), the net security delta between the two
 * orderings is negligible.
 *
 * Public channel lookup deliberately has one source and one bounded
 * attempt: GitHub. A failed round is recorded and returned to the UI so a
 * person can press Retry again; the transport never performs a hidden
 * source switch or an internal retry loop. Detached signature verification,
 * ETag handling, and the trusted archive URLs inside a verified manifest
 * remain unchanged.
 *
 * Channel assertion (why it lives in checkOnce/downloadAndApplyArtifacts,
 * not deeper): `verifyManifest` is a context-free validator — it has no
 * idea which channel the caller actually asked for, only whether the bytes
 * it was handed are well-formed and validly signed by SOME known key. The
 * fetch logic one level up (inside `fetchChannelManifest`) verifies bytes
 * but doesn't know channel semantics either. The channel pointer
 * namespace (`stable` vs `beta`, etc.) is a concept that only the caller
 * of `checkOnce`/`downloadAndApplyArtifacts` — the code that decided which
 * channel to poll in the first place — actually holds. So the one and only
 * place a signed-but-wrong-channel manifest (e.g. a validly-signed `beta`
 * manifest served back from a `stable` URL, whether by misconfiguration or
 * attack) gets rejected is right here, immediately after the
 * manifest comes back trusted and before any pointer/version logic runs.
 *
 * Why a rollback instead of a true joint write: `activateFromArchive` is
 * the sole path by which an archive becomes a bootable version (extract +
 * `.verified` + `next`-pointer write, all in one call) and intentionally
 * encapsulates that transaction. It cannot be split into "extract" and "write pointer"
 * phases without forking or modifying that module. Calling it once per
 * kind and rolling back the first kind's pointer if the second kind's
 * call throws reaches the same externally-observable outcome ("either
 * both next pointers exist afterward, or neither does") using only
 * exported, unmodified artifact-core functions.
 *
 * Node built-ins only (https/crypto/fs/path) — zero new dependencies.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const https = require("https");
const path = require("path");
const crypto = require("crypto");

const manifestModule = require("./manifest.cjs");
const pointerStore = require("./pointer-store.cjs");
const activation = require("./activation.cjs");
const pointerChannels = require("./pointer-channels.cjs");
const { PRELOAD_API_VERSION } = require("../contract-versions.cjs");

const { SEED_CHANNEL, rendererPointerChannel } = pointerChannels; // SEED_CHANNEL = "stable"

// devBypass is never required statically here — this module must never
// require anything under desktop/ and must never contain the dev-only
// override env var's literal name (a structural test enforces both, since
// this file ships into every consumer, server/CLI included, that never
// wants dev-only transport-override code in its dependency graph). Every
// entry point below accepts an explicit `devBypass` opt instead; when the
// caller doesn't supply one, this default behaves exactly like
// `artifact-ota-dev-bypass.prod-stub.cjs`: no override, ever. The desktop
// shell (`desktop/src/shared/artifact-ota.cjs`) is the only place that
// requires the real dev-bypass module and injects it here.
const NO_DEV_OVERRIDE = {
  resolveDevManifestOverride: () => null,
  hasDevOverride: () => false,
};

const STAGING_DIRNAME = "staging";
const OTA_STATE_FILENAME = "ota-state.json";
const ROLLOUT_ID_FILENAME = "rollout-id";

const FIRST_CHECK_DELAY_MS = 30_000;
const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

const MAX_REDIRECTS = 5;
const MANIFEST_REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_REQUEST_TIMEOUT_MS = 60_000;
// Socket idle timeout above only catches a FULLY stalled connection; a
// malicious or broken server trickling one byte per minute would hold the
// download (and the artifacts lock) hostage forever. Two independent
// guards close that: a rolling minimum-progress window and a hard
// per-attempt deadline. Both abort into the existing mirror-rotation
// retry loop in stageArtifact.
const DOWNLOAD_STALL_WINDOW_MS = 60_000;
const DOWNLOAD_STALL_MIN_BYTES = 64 * 1024;
const DOWNLOAD_ATTEMPT_DEADLINE_MS = 60 * 60 * 1000;
const MAX_MANIFEST_BYTES = 256 * 1024; // generous for a schema-1 manifest + mirrors array
const MAX_SIG_BYTES = 4 * 1024; // raw ed25519 sig is 64 bytes; PEM-wrapped is still tiny
// Kept as an exported compatibility alias for consumers that used the old
// constant name. There is no separate race budget anymore: the one GitHub
// attempt uses the ordinary bounded manifest timeout.
const ORIGIN_MANIFEST_RACE_TIMEOUT_MS = MANIFEST_REQUEST_TIMEOUT_MS;

// ── channel pointer URLs: clients poll ONLY these static asset
//    URLs, never the GitHub API ───────────────────────────────────────────
const { channelManifestBaseUrl } = require("../release-source.cjs");

/**
 * One-element array retained for compatibility with existing callers.
 * @returns {[string]} the CAgent GitHub channel manifest URL.
 */
function channelManifestUrls(channel) {
  return [`${channelManifestBaseUrl}/${channel}.json`];
}

// ── low-level https transport: manual redirect following, injectable for
//    tests (`fetchOnce`) ───────────────────────────────────────────────────

function realFetchOnce(url, { headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = https.request(url, { headers, method: "GET", timeout: timeoutMs }, (res) => {
        resolve({ statusCode: res.statusCode, headers: res.headers, bodyStream: res });
      });
    } catch (err) {
      reject(err);
      return;
    }
    req.on("timeout", () => req.destroy(new Error(`artifact-ota: request timed out for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Follows redirects manually, capped at `maxRedirects` hops, https-only at
 * every hop (a redirect to http:// is refused, not silently downgraded).
 * @param {string} url
 * @param {{headers?: object, maxRedirects?: number, timeoutMs?: number,
 *          fetchOnce?: Function}} [opts]
 * @returns {Promise<{statusCode: number, headers: object, bodyStream: import('stream').Readable, finalUrl: string}>}
 */
async function fetchWithRedirects(url, opts = {}) {
  const { headers = {}, maxRedirects = MAX_REDIRECTS, timeoutMs = MANIFEST_REQUEST_TIMEOUT_MS, fetchOnce = realFetchOnce } = opts;
  let currentUrl = url;
  for (let hop = 0; ; hop += 1) {
    let parsed;
    try {
      parsed = new URL(currentUrl);
    } catch (err) {
      throw new Error(`artifact-ota: invalid URL ${currentUrl} (${err.message})`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`artifact-ota: refusing non-https URL ${currentUrl}`);
    }
    const { statusCode, headers: resHeaders, bodyStream } = await fetchOnce(currentUrl, { headers, timeoutMs });
    if (statusCode >= 300 && statusCode < 400 && resHeaders && resHeaders.location) {
      if (typeof bodyStream.resume === "function") bodyStream.resume(); // drain, we're not reading this body
      if (hop >= maxRedirects) {
        throw new Error(`artifact-ota: too many redirects (> ${maxRedirects}) for ${url}`);
      }
      currentUrl = new URL(resHeaders.location, currentUrl).toString();
      continue;
    }
    return { statusCode, headers: resHeaders || {}, bodyStream, finalUrl: currentUrl };
  }
}

/**
 * Buffers a small response body (manifest / signature). Enforces
 * `maxBytes` while streaming (aborts before the whole body is buffered).
 */
async function fetchBuffer(url, opts = {}) {
  const { maxBytes } = opts;
  const { statusCode, headers, bodyStream } = await fetchWithRedirects(url, opts);
  if (statusCode === 304) {
    if (typeof bodyStream.resume === "function") bodyStream.resume();
    return { statusCode, headers, body: null };
  }
  if (statusCode < 200 || statusCode >= 300) {
    if (typeof bodyStream.resume === "function") bodyStream.resume();
    throw new Error(`artifact-ota: HTTP ${statusCode} for ${url}`);
  }
  const chunks = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    bodyStream.on("data", (chunk) => {
      total += chunk.length;
      if (maxBytes && total > maxBytes) {
        if (typeof bodyStream.destroy === "function") bodyStream.destroy();
        reject(new Error(`artifact-ota: response exceeded ${maxBytes} bytes for ${url}`));
        return;
      }
      chunks.push(chunk);
    });
    bodyStream.on("end", resolve);
    bodyStream.on("error", reject);
  });
  return { statusCode, headers, body: Buffer.concat(chunks) };
}

/**
 * Streams a response body directly to `destPath` (large archive
 * downloads). Enforces `maxBytes` while streaming; on any failure the
 * partial file is removed. `onProgress(receivedBytes)` — when supplied —
 * is invoked after every chunk so a caller can report download progress;
 * purely observational, never affects control flow.
 *
 * Two independent guards close the "trickle" gap the transport's socket
 * idle timeout leaves open (see the `DOWNLOAD_STALL_WINDOW_MS` doc comment
 * above): a rolling minimum-progress window (`stallWindowMs`/
 * `stallMinBytes`) and a hard per-attempt deadline (`attemptDeadlineMs`).
 * Both are overridable via `opts` for testability; production callers rely
 * on the module defaults.
 */
async function downloadToFile(url, destPath, opts = {}) {
  const {
    maxBytes,
    onProgress,
    stallWindowMs = DOWNLOAD_STALL_WINDOW_MS,
    stallMinBytes = DOWNLOAD_STALL_MIN_BYTES,
    attemptDeadlineMs = DOWNLOAD_ATTEMPT_DEADLINE_MS,
  } = opts;
  const { statusCode, headers, bodyStream } = await fetchWithRedirects(url, opts);
  if (statusCode < 200 || statusCode >= 300) {
    if (typeof bodyStream.resume === "function") bodyStream.resume();
    throw new Error(`artifact-ota: HTTP ${statusCode} for ${url}`);
  }
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const writeStream = fs.createWriteStream(destPath);
  let total = 0;
  let bytesAtWindowStart = 0;
  let stallTimer = null;
  let deadlineTimer = null;
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        if (typeof bodyStream.destroy === "function") bodyStream.destroy();
        if (typeof writeStream.destroy === "function") writeStream.destroy();
        reject(err);
      };
      stallTimer = setInterval(() => {
        if (total - bytesAtWindowStart < stallMinBytes) {
          fail(new Error(
            `artifact-ota: download stalled — fewer than ${stallMinBytes} bytes received in the last `
              + `${Math.round(stallWindowMs / 1000)}s for ${url}`,
          ));
          return;
        }
        bytesAtWindowStart = total;
      }, stallWindowMs);
      deadlineTimer = setTimeout(() => {
        fail(new Error(
          `artifact-ota: download exceeded the ${Math.round(attemptDeadlineMs / 1000)}s attempt deadline for ${url}`,
        ));
      }, attemptDeadlineMs);
      bodyStream.on("data", (chunk) => {
        total += chunk.length;
        if (maxBytes && total > maxBytes) {
          if (typeof bodyStream.destroy === "function") bodyStream.destroy();
          writeStream.destroy();
          fail(new Error(`artifact-ota: download exceeded ${maxBytes} bytes for ${url}`));
          return;
        }
        if (typeof onProgress === "function") onProgress(total);
      });
      bodyStream.on("error", fail);
      writeStream.on("error", fail);
      writeStream.on("finish", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      bodyStream.pipe(writeStream);
    });
  } catch (err) {
    await fsp.rm(destPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    if (stallTimer) clearInterval(stallTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
  return { statusCode, headers, bytesWritten: total };
}

// ── channel manifest fetch (one GitHub source, ETag cache, dev bypass) ──

function fetchDevOverrideManifest(devOverride, keyset, log) {
  if (/^https?:\/\//i.test(devOverride)) {
    return (async () => {
      const manifestRes = await fetchBuffer(devOverride, { maxBytes: MAX_MANIFEST_BYTES, timeoutMs: MANIFEST_REQUEST_TIMEOUT_MS });
      const sigRes = await fetchBuffer(`${devOverride}.sig`, { maxBytes: MAX_SIG_BYTES, timeoutMs: MANIFEST_REQUEST_TIMEOUT_MS });
      const manifest = manifestModule.verifyManifest(manifestRes.body, sigRes.body, keyset);
      return { manifest, etag: null, sourceUrl: devOverride, sourceKind: "origin", originUnreachable: false, localDir: null };
    })();
  }
  // Deliberately does NOT spell out the override env var's name here — this
  // file is bundled verbatim into every production main.bundle.cjs (unlike
  // artifact-ota-dev-bypass.cjs, which gets alias-swapped away); a literal
  // string reference here would defeat the "grep finds nothing" guarantee
  // even though this branch only ever executes when devBypass.hasDevOverride()
  // was already true (dev mode only).
  log(`[ota] dev manifest override active: reading local manifest from ${devOverride}`);
  const manifestBytes = fs.readFileSync(devOverride);
  const sigBytes = fs.readFileSync(`${devOverride}.sig`);
  const manifest = manifestModule.verifyManifest(manifestBytes, sigBytes, keyset);
  // Dev bypass reads a single local fixture and uses the same provenance
  // shape as the public GitHub path.
  return { manifest, etag: null, sourceUrl: devOverride, sourceKind: "origin", originUnreachable: false, localDir: path.dirname(devOverride) };
}

/**
 * Fetches ONE channel-manifest source (manifest.json + its detached .sig),
 * honoring its cached ETag for a conditional GET. Never throws: every
 * outcome comes back tagged so the caller can produce one clear error.
 * @returns {Promise<{status:"not-modified"} |
 *   {status:"fetched", manifestBytes:Buffer, sigBytes:Buffer, etag:string|null, sourceUrl:string} |
 *   {status:"error", error:Error}>}
 */
async function fetchOneChannelSource(url, { cachedEtag, fetchOnce, log, timeoutMs }) {
  try {
    const headers = cachedEtag ? { "If-None-Match": cachedEtag } : {};
    const manifestRes = await fetchBuffer(url, { headers, maxBytes: MAX_MANIFEST_BYTES, timeoutMs, fetchOnce });
    if (manifestRes.statusCode === 304) return { status: "not-modified" };
    const sigRes = await fetchBuffer(`${url}.sig`, { maxBytes: MAX_SIG_BYTES, timeoutMs, fetchOnce });
    return {
      status: "fetched",
      manifestBytes: manifestRes.body,
      sigBytes: sigRes.body,
      etag: (manifestRes.headers && manifestRes.headers.etag) || null,
      sourceUrl: url,
    };
  } catch (err) {
    log(`[ota] channel manifest fetch failed from ${url}: ${err.message}`);
    return { status: "error", error: err };
  }
}

/**
 * Verifies the fetched candidate, returning `null` on failure so the
 * caller can wrap the failure with source context. Channel namespace
 * checking remains at the call site, where the requested channel is known.
 */
function tryVerifyManifestCandidate(fetchResult, keyset, log) {
  try {
    return manifestModule.verifyManifest(fetchResult.manifestBytes, fetchResult.sigBytes, keyset);
  } catch (err) {
    log(`[ota] GitHub channel manifest failed verification: ${err.message}`);
    return null;
  }
}

/**
 * Fetches this round's channel manifest from GitHub exactly once. A failed
 * round returns an error to the caller; retrying is a separate user action.
 * @param {{channel: string, keyset: Array<{keyId:string, publicKey:string}>,
 *   cachedEtags?: {origin?: string|null},
 *   log?: (msg: string) => void, fetchOnce?: Function,
 *   devBypass?: {hasDevOverride: () => boolean, resolveDevManifestOverride: () => string|null}}} opts
 *   `devBypass` defaults to "no override, ever" (see `NO_DEV_OVERRIDE`) —
 *   only the desktop shell ever passes the real dev-bypass module in.
 * @returns {Promise<
 *   {notModified: true, sourceEtagUpdate: {origin?: string|null}} |
 *   {manifest: object, sourceUrl: string, sourceKind: "origin",
 *    originUnreachable: boolean, etag: string|null, localDir: string|null,
 *    sourceEtagUpdate: {origin?: string|null}}>}
 */
async function fetchChannelManifest({ channel, keyset, cachedEtags = {}, log = () => {}, fetchOnce, devBypass = NO_DEV_OVERRIDE }) {
  if (devBypass.hasDevOverride()) {
    return fetchDevOverrideManifest(devBypass.resolveDevManifestOverride(), keyset, log);
  }
  const [originUrl] = channelManifestUrls(channel);
  const originResult = await fetchOneChannelSource(originUrl, {
    cachedEtag: cachedEtags.origin,
    fetchOnce,
    log,
    timeoutMs: MANIFEST_REQUEST_TIMEOUT_MS,
  });

  const sourceEtagUpdate = {};
  if (originResult.status === "fetched") sourceEtagUpdate.origin = originResult.etag;
  if (originResult.status === "not-modified") return { notModified: true, sourceEtagUpdate };
  if (originResult.status === "error") {
    throw new Error(`artifact-ota: GitHub channel manifest request failed: ${originResult.error.message}`);
  }

  const verified = tryVerifyManifestCandidate(originResult, keyset, log);
  if (!verified) throw new Error("artifact-ota: GitHub channel manifest failed signature or schema verification");

  return {
    manifest: verified,
    sourceUrl: originResult.sourceUrl,
    sourceKind: "origin",
    originUnreachable: false,
    etag: originResult.etag,
    localDir: null,
    sourceEtagUpdate,
  };
}

/**
 * GitHub ETag cache merge. Legacy state may still carry extra source keys;
 * reading it is safe, while every successful new write normalizes the
 * persisted shape back to the single `origin` key.
 */
function mergeSourceEtags(previous, update) {
  const prev = previous && typeof previous === "object" ? previous : {};
  const upd = update && typeof update === "object" ? update : {};
  return {
    origin: Object.prototype.hasOwnProperty.call(upd, "origin") ? upd.origin : (prev.origin ?? null),
  };
}

function cachedGithubEtags(channelState) {
  const manifestEtags = channelState?.manifestEtags;
  if (!manifestEtags || typeof manifestEtags !== "object") return {};
  return Object.prototype.hasOwnProperty.call(manifestEtags, "origin")
    ? { origin: manifestEtags.origin ?? null }
    : {};
}

// ── minShell comparison (major.minor.patch only; no new semver dep) ───────

function parseVersionTriplet(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || "").trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Three-way semantic comparison of two `major.minor.patch` version strings:
 * -1 when a < b, 0 when equal, 1 when a > b. Each segment is compared as a
 * NUMBER, never as text — "0.100.0" is newer than "0.99.0" even though a
 * plain string comparison says the opposite. Returns null when either side
 * doesn't parse as a version triplet; every caller decides what "can't
 * compare" means for its own gate instead of this function guessing.
 */
function compareVersions(a, b) {
  const left = parseVersionTriplet(a);
  const right = parseVersionTriplet(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

/**
 * Conservative by construction: an unparseable version on EITHER side
 * blocks the update (returns false) rather than guessing — we never want
 * to silently proceed past a check we can't actually evaluate.
 */
function isShellVersionSufficient(currentShellVersion, minShellVersion) {
  const cmp = compareVersions(currentShellVersion, minShellVersion);
  return cmp !== null && cmp >= 0;
}

// ── preload contract comparison (additive-only integer version, not semver) ─

/**
 * Same shape of gate as `isShellVersionSufficient`, one level more specific:
 * minShell asks "is the shell new enough at all", this asks "does the shell
 * expose the preload API surface this train's renderer needs". A manifest
 * requiring a higher `contract.preload` than this shell supports is exactly
 * as unrunnable as a manifest requiring a higher minShell — the shell itself
 * needs updating (electron-updater's job, not this module's) before this
 * train can ever apply here.
 */
function isPreloadContractSatisfied(manifestPreloadVersion, shellPreloadVersion) {
  return shellPreloadVersion >= manifestPreloadVersion;
}

/**
 * The self-hosted renderer pull's contract gate — the server-side analog
 * of `isPreloadContractSatisfied`: does the running server speak the
 * protocol this train's renderer requires? A renderer that requires a
 * newer `contract.serverProtocol` than the server it will be served from
 * would load in the browser and then fail against every API it calls, so
 * it must be refused up front (with "upgrade the server first" as the
 * actionable message — see `downloadAndApplyRendererArtifact`).
 *
 * Read-time compatibility: a manifest missing the field entirely (built
 * before the contract existed) passes rather than blocks. Schema-1
 * manifests always carry the field (manifest.cjs validates it), so in
 * practice this branch only ever fires for pre-schema shelves or future
 * schema relaxations — but "can't evaluate" here means "old shelf, no
 * contract to violate", the opposite polarity of `isShellVersionSufficient`'s
 * conservative default, where an unparseable value means the manifest is
 * making a demand we can't read.
 */
function isServerProtocolSatisfied(manifestServerProtocol, serverProtocolVersion) {
  if (!Number.isInteger(manifestServerProtocol)) return true;
  return serverProtocolVersion >= manifestServerProtocol;
}

// ── rollout bucketing: dedicated random UUID, zero linkage to
//    any real device identity) ─────────────────────────────────────────────

function computeRolloutBucket(rolloutId, salt) {
  const digest = crypto.createHash("sha256").update(`${rolloutId}${salt}`).digest("hex");
  return parseInt(digest.slice(0, 8), 16) % 100;
}

function isInRolloutBucket({ rolloutId, salt, percent }) {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  return computeRolloutBucket(rolloutId, salt) < percent;
}

function rolloutIdPath(homeDir) {
  return path.join(pointerStore.artifactsRoot(homeDir), ROLLOUT_ID_FILENAME);
}

async function atomicWriteText(filePath, text) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  await fsp.writeFile(tmpPath, text, "utf8");
  await fsp.rename(tmpPath, filePath);
}

/**
 * Reads the dedicated rollout UUID, generating and persisting one on first
 * use. Never derived from any real device/machine identity.
 * @param {string} homeDir
 * @returns {Promise<string>}
 */
async function ensureRolloutId(homeDir) {
  const filePath = rolloutIdPath(homeDir);
  try {
    const existing = (await fsp.readFile(filePath, "utf8")).trim();
    if (existing) return existing;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const id = crypto.randomUUID();
  await atomicWriteText(filePath, id);
  return id;
}

// ── ota-state.json (ETag + last-check + last-known-available bookkeeping,
//    keyed by channel) ──────────────────────────────────────────────────────

function otaStatePath(homeDir) {
  return path.join(pointerStore.artifactsRoot(homeDir), OTA_STATE_FILENAME);
}

async function readOtaState(homeDir) {
  try {
    const raw = await fsp.readFile(otaStatePath(homeDir), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    // A corrupt/missing state file must never block the update path itself
    // — it's bookkeeping, not a trust boundary.
    return {};
  }
}

async function writeOtaChannelState(homeDir, channel, patch) {
  const state = await readOtaState(homeDir);
  state[channel] = { ...(state[channel] || {}), ...patch };
  await pointerStore.atomicWriteJson(otaStatePath(homeDir), state);
  return state[channel];
}

function nowIso() {
  return new Date().toISOString();
}

// ── staging (download/copy + sha256 verify) ────────────────────────────────

/**
 * Stages one artifact entry into `finalPath`: either copies it from a
 * local dev-override directory, or downloads it from the manifest's
 * `mirrors`, trying each in order until one succeeds. Always ends with an
 * explicit sha256 check against the manifest entry (in addition to the
 * one `activateFromArchive` performs) so a corrupt/wrong download fails
 * fast with an attributable message before extraction is attempted.
 * `onProgress(receivedBytes)` is forwarded to the network download only
 * (a local dev-override copy is effectively instant and reports nothing).
 */
async function stageArtifact({ finalPath, entry, mirrors, localDir, log, label, onProgress }) {
  const maxBytes = entry.size + Math.max(Math.round(entry.size * 0.05), 5 * 1024 * 1024);
  const partPath = `${finalPath}.part`;

  if (localDir) {
    const sourcePath = path.join(localDir, entry.path);
    await fsp.rm(partPath, { force: true }).catch(() => {});
    await fsp.copyFile(sourcePath, partPath);
    await fsp.rename(partPath, finalPath);
  } else {
    if (!Array.isArray(mirrors) || mirrors.length === 0) {
      throw new Error(`no mirrors declared for ${label}`);
    }
    let lastErr;
    let staged = false;
    for (const mirrorBase of mirrors) {
      const url = `${String(mirrorBase).replace(/\/+$/, "")}/${entry.path}`;
      try {
        await fsp.rm(partPath, { force: true }).catch(() => {});
        await downloadToFile(url, partPath, { maxBytes, timeoutMs: DOWNLOAD_REQUEST_TIMEOUT_MS, onProgress });
        await fsp.rename(partPath, finalPath);
        staged = true;
        break;
      } catch (err) {
        lastErr = err;
        log(`[ota] mirror failed for ${label}: ${url} (${err.message})`);
        await fsp.rm(partPath, { force: true }).catch(() => {});
      }
    }
    if (!staged) {
      throw new Error(`all mirrors failed for ${label}: ${lastErr ? lastErr.message : "unknown"}`);
    }
  }

  const actualSha256 = await activation.sha256File(finalPath);
  if (actualSha256 !== entry.sha256) {
    await fsp.rm(finalPath, { force: true }).catch(() => {});
    throw new Error(`sha256 mismatch staging ${label} (expected ${entry.sha256}, got ${actualSha256})`);
  }
  return finalPath;
}

// ── shared manifest-entry derivation (both entry points need this) ────────

/**
 * Pulls this platform's server entry and the renderer entry out of a
 * verified manifest. Throws if either kind is missing, or if the two
 * entries disagree on `version` (release publishing guarantees one train
 * ships server+renderer stamped with the same product version — a
 * mismatch means the manifest itself is broken, not that either side is
 * individually invalid).
 * @param {object} manifest
 * @param {string} platformArch
 * @returns {{serverEntry: object, rendererEntry: object, version: string}}
 */
function deriveArtifactEntries(manifest, platformArch) {
  const rendererEntry = manifest.artifacts.renderer;
  const serverEntry = manifest.artifacts.server && manifest.artifacts.server[platformArch];
  if (!rendererEntry || !serverEntry) {
    const missing = [!serverEntry ? `server(${platformArch})` : null, !rendererEntry ? "renderer" : null]
      .filter(Boolean)
      .join("+");
    throw new Error(`manifest missing needed kind(s) for OTA: ${missing}`);
  }
  if (serverEntry.version !== rendererEntry.version) {
    throw new Error(
      `manifest server/renderer version mismatch (server ${serverEntry.version}, renderer ${rendererEntry.version})`,
    );
  }
  return { serverEntry, rendererEntry, version: serverEntry.version };
}

/**
 * Content reconciliation rule: even when the train number advanced, if the
 * actual bytes this platform would receive are identical to what's
 * already recorded on the `current` pointer for both kinds, there is
 * nothing to update — a re-cut release announcing the same content under
 * a new train number must not be surfaced as "a new version is available".
 * @returns {boolean}
 */
function isContentAlreadyCurrent({ currentServerPointer, currentRendererPointer, serverEntry, rendererEntry }) {
  return Boolean(
    currentServerPointer
      && currentServerPointer.sha256 === serverEntry.sha256
      && currentRendererPointer
      && currentRendererPointer.sha256 === rendererEntry.sha256,
  );
}

/**
 * Version reconciliation rule: a version directory is named after the
 * version number itself, so content stamped with the same version as what's
 * already activated can never be applied even if its bytes differ (the
 * activation layer's protected-directory + sha256 check refuses it). This
 * happens in practice because CI packs the renderer archive on three
 * separate platform runners and tar embeds each build's mtime, so the same
 * source tree produces three different byte streams for the same version —
 * if only one of those boxes ends up on the shelf, every other platform's
 * freshly-installed sha256 seed can never match it. Treating "same version"
 * as "already current" (regardless of sha256) avoids advertising an update
 * that would always fail to apply.
 * A pointer written before this field existed has no `version` — in that
 * case this check simply doesn't fire and behavior falls back to the
 * sha256-only comparison above, which is the correct read-time-compatible
 * behavior for old data.
 * @returns {boolean}
 */
function isVersionAlreadyCurrent({ currentServerPointer, currentRendererPointer, serverEntry, rendererEntry }) {
  return Boolean(
    currentServerPointer
      && typeof currentServerPointer.version === "string"
      && currentServerPointer.version.length > 0
      && currentServerPointer.version === serverEntry.version
      && currentRendererPointer
      && typeof currentRendererPointer.version === "string"
      && currentRendererPointer.version.length > 0
      && currentRendererPointer.version === rendererEntry.version,
  );
}

/**
 * Version DIRECTION rule: content version never goes backward. A shelf
 * manifest carrying a LOWER version than what's already activated is a
 * downgrade, not an update, no matter how new its train number is — and a
 * downgrade is structurally unsafe here for two reasons: a version
 * directory is named after the version number itself (so "activating an
 * older version" collides with the same-name-can't-apply rule above), and
 * data migrations only ever run forward, so older code reading data
 * structures written by newer code has unpredictable consequences. When
 * this fires, the correct answer is "you're already up to date": the
 * downgrade is never surfaced as available and never allowed to apply.
 * True as soon as EITHER kind's manifest version is strictly below its
 * pointer's version — both kinds always ship together, so one kind moving
 * backward is enough to refuse the whole train.
 *
 * This also pins down the recall playbook: pulling the shelf pointer back
 * to an older release only protects users who haven't updated yet; users
 * who already took the bad release must be rescued by re-publishing the
 * good content under a HIGHER version number, never by shipping an older
 * version as if it were new.
 *
 * Read-time compatibility: a pointer that's missing, or was written before
 * the `version` field existed, disables this check (returns false) and
 * behavior falls back to the existing train/content/version gates. An
 * unparseable version string on either side likewise never counts as
 * "behind" rather than guessing a direction.
 * @returns {boolean}
 */
function isVersionBehindCurrent({ currentServerPointer, currentRendererPointer, serverEntry, rendererEntry }) {
  const hasVersion = (pointer) => Boolean(
    pointer && typeof pointer.version === "string" && pointer.version.length > 0,
  );
  if (!hasVersion(currentServerPointer) || !hasVersion(currentRendererPointer)) return false;
  const serverCmp = compareVersions(serverEntry.version, currentServerPointer.version);
  const rendererCmp = compareVersions(rendererEntry.version, currentRendererPointer.version);
  return (serverCmp !== null && serverCmp < 0) || (rendererCmp !== null && rendererCmp < 0);
}

function buildAvailableDescriptor({ manifest, serverEntry, rendererEntry, version }) {
  return {
    train: manifest.train,
    version,
    serverSha256: serverEntry.sha256,
    rendererSha256: rendererEntry.sha256,
    sizes: { server: serverEntry.size, renderer: rendererEntry.size },
    recordedAt: nowIso(),
  };
}

// ── checkOnce: the only entry point safe to run on a timer ────────────────

/**
 * Runs exactly one OTA check cycle. NEVER writes an archive to disk, NEVER
 * extracts anything, NEVER writes a pointer — the only disk writes are
 * `ota-state.json` bookkeeping and (on first run) the rollout-id file.
 * NEVER rejects — every failure is caught, logged, recorded in
 * ota-state.json, and reflected in the returned `outcome`.
 *
 * Outcomes: "not-modified" (304 — state otherwise untouched), "up-to-date"
 * (train not newer, content byte-identical to `current`, version already
 * identical to `current` even with different bytes, or shelf version
 * OLDER than what's activated — a downgrade is never an update),
 * "available"
 * (a real update exists and passed every gate; nothing downloaded yet),
 * "minshell-blocked" (a real update exists but this shell is too old to
 * receive it), "rollout-excluded", "quarantined", "error".
 *
 * @param {{homeDir: string, keyset: Array<{keyId:string, publicKey:string}>,
 *   currentShellVersion: string, platformArch: string, channel?: string,
 *   log?: (msg: string) => void, fetchOnce?: Function,
 *   devBypass?: {hasDevOverride: () => boolean, resolveDevManifestOverride: () => string|null}}} opts
 *   `fetchOnce` is a test-only low-level transport override (see
 *   `fetchWithRedirects`); production callers never pass it. `devBypass`
 *   defaults to "no override, ever" — see `fetchChannelManifest`'s doc
 *   comment.
 * @returns {Promise<{outcome: string, train?: number, version?: string,
 *   minShellBlocked?: boolean, error?: string}>}
 */
async function checkOnce(opts) {
  const {
    homeDir, keyset, currentShellVersion, platformArch, channel = SEED_CHANNEL, log = () => {}, fetchOnce,
    devBypass = NO_DEV_OVERRIDE,
  } = opts || {};
  if (!homeDir) throw new Error("artifact-ota: homeDir is required");
  if (!Array.isArray(keyset) || keyset.length === 0) throw new Error("artifact-ota: keyset is required");
  if (!currentShellVersion) throw new Error("artifact-ota: currentShellVersion is required");
  if (!platformArch) throw new Error("artifact-ota: platformArch is required");

  const priorChannelState = (await readOtaState(homeDir))[channel] || {};
  // Read the old multi-source state safely, but only carry GitHub's ETag
  // forward. Legacy extra keys are ignored and disappear on the next
  // successful state write, so an old backup-source token can never be
  // sent to GitHub by mistake.
  const cachedEtags = cachedGithubEtags(priorChannelState);

  try {
    const fetched = await fetchChannelManifest({ channel, keyset, cachedEtags, log, fetchOnce, devBypass });
    if (fetched.notModified) {
      // The shelf hasn't moved since the last check. That is NOT the same
      // thing as "you are up to date" — whatever the last check found
      // (an available update, an error) is still true and must not be
      // silently erased just because this poll came back empty-handed.
      await writeOtaChannelState(homeDir, channel, {
        lastCheckedAt: nowIso(),
        manifestEtags: mergeSourceEtags(cachedEtags, fetched.sourceEtagUpdate),
      });
      return { outcome: "not-modified" };
    }
    // Verification already happened inside fetchChannelManifest;
    // `manifest` here is already trusted.
    const { manifest, sourceUrl, sourceKind, originUnreachable, localDir } = fetched;

    // Channel namespace assertion — see the file header's "channel
    // assertion" note for why this lives here and not inside
    // verifyManifest or the transport layer. A
    // signed-but-wrong-channel manifest (e.g. a validly-signed `beta`
    // manifest served back from the `stable` URL) must never be silently
    // accepted onto this channel's pointer namespace.
    if (manifest.channel !== channel) {
      throw new Error(
        `artifact-ota: manifest channel mismatch — requested "${channel}", manifest declares "${manifest.channel}" `
          + `(source ${sourceUrl}); refusing to trust a "${manifest.channel}" manifest for the "${channel}" channel`,
      );
    }

    const manifestMeta = {
      manifestEtags: mergeSourceEtags(cachedEtags, fetched.sourceEtagUpdate),
      manifestSource: sourceKind,
      manifestReleasedAt: manifest.releasedAt,
      originUnreachable,
      lastManifestUrl: sourceUrl,
    };

    const rendererChannel = rendererPointerChannel(channel);
    const currentServerPointer = await pointerStore.readPointer(homeDir, channel, "current");
    const currentRendererPointer = await pointerStore.readPointer(homeDir, rendererChannel, "current");
    const currentTrain = currentServerPointer && Number.isInteger(currentServerPointer.train) ? currentServerPointer.train : null;

    // Monotonic gate, softened: a train that isn't strictly newer than
    // what's already activated is normal ("you're already caught up"),
    // not an error — only downloadAndApplyArtifacts treats this as fatal.
    if (currentTrain !== null && manifest.train <= currentTrain) {
      await writeOtaChannelState(homeDir, channel, {
        ...manifestMeta,
        lastCheckedAt: nowIso(),
        lastError: null,
        available: null,
        minShellBlocked: false,
        blockedReason: null,
      });
      return { outcome: "up-to-date", train: manifest.train };
    }

    const { serverEntry, rendererEntry, version } = deriveArtifactEntries(manifest, platformArch);

    // Content reconciliation short-circuit — see `isContentAlreadyCurrent`'s,
    // `isVersionAlreadyCurrent`'s and `isVersionBehindCurrent`'s doc
    // comments. The three predicates are mutually exclusive by construction
    // (each is only evaluated when the previous ones didn't fire), so the
    // per-case logs below never overlap.
    const contentAlreadyCurrent = isContentAlreadyCurrent({ currentServerPointer, currentRendererPointer, serverEntry, rendererEntry });
    const versionAlreadyCurrent = !contentAlreadyCurrent
      && isVersionAlreadyCurrent({ currentServerPointer, currentRendererPointer, serverEntry, rendererEntry });
    const versionBehindCurrent = !contentAlreadyCurrent && !versionAlreadyCurrent
      && isVersionBehindCurrent({ currentServerPointer, currentRendererPointer, serverEntry, rendererEntry });
    if (contentAlreadyCurrent || versionAlreadyCurrent || versionBehindCurrent) {
      if (versionAlreadyCurrent) {
        log(
          `[ota] train ${manifest.train} (${version}) matches the currently activated version but has different bytes; `
            + "treating as already up-to-date (this usually means the installer seed and the shelf box came from different builds)",
        );
      }
      if (versionBehindCurrent) {
        log(
          `[ota] train ${manifest.train} (${version}) is OLDER than the currently activated version `
            + `(server ${currentServerPointer.version}, renderer ${currentRendererPointer.version}); `
            + "shelf content behind this install is not an update — treating as already up-to-date "
            + "(a rollback must be re-published under a higher version number to reach installs like this one)",
        );
      }
      await writeOtaChannelState(homeDir, channel, {
        ...manifestMeta,
        lastCheckedAt: nowIso(),
        lastError: null,
        available: null,
        minShellBlocked: false,
        blockedReason: null,
      });
      return { outcome: "up-to-date", train: manifest.train };
    }

    const available = buildAvailableDescriptor({ manifest, serverEntry, rendererEntry, version });

    if (!isShellVersionSufficient(currentShellVersion, manifest.minShell)) {
      await writeOtaChannelState(homeDir, channel, {
        ...manifestMeta,
        lastCheckedAt: nowIso(),
        lastError: null,
        available,
        minShellBlocked: true,
        blockedReason: "minShell",
      });
      log(`[ota] train ${manifest.train} (${version}) blocked: minShell ${manifest.minShell} > shell ${currentShellVersion}`);
      return { outcome: "minshell-blocked", train: manifest.train, version, minShellBlocked: true };
    }

    // Preload contract gate: same "the shell itself is too old" family as
    // minShell above, so it's reported through the exact same outcome and
    // persisted fields (a UI that already handles minshell-blocked handles
    // this for free) — `blockedReason` is the only place the two are told
    // apart, and it exists for diagnostics only.
    if (!isPreloadContractSatisfied(manifest.contract.preload, PRELOAD_API_VERSION)) {
      await writeOtaChannelState(homeDir, channel, {
        ...manifestMeta,
        lastCheckedAt: nowIso(),
        lastError: null,
        available,
        minShellBlocked: true,
        blockedReason: "preloadContract",
      });
      log(`[ota] train ${manifest.train} (${version}) blocked: requires preload contract ${manifest.contract.preload} > shell's ${PRELOAD_API_VERSION}`);
      return { outcome: "minshell-blocked", train: manifest.train, version, minShellBlocked: true };
    }

    const rolloutId = await ensureRolloutId(homeDir);
    if (!isInRolloutBucket({ rolloutId, salt: manifest.rollout.salt, percent: manifest.rollout.percent })) {
      await writeOtaChannelState(homeDir, channel, {
        ...manifestMeta,
        lastCheckedAt: nowIso(),
        lastError: null,
        available: null,
        minShellBlocked: false,
        blockedReason: null,
      });
      return { outcome: "rollout-excluded", train: manifest.train };
    }

    if (await pointerStore.isQuarantined(homeDir, channel, manifest.train)) {
      await writeOtaChannelState(homeDir, channel, {
        ...manifestMeta,
        lastCheckedAt: nowIso(),
        lastError: null,
        available: null,
        minShellBlocked: false,
        blockedReason: null,
      });
      return { outcome: "quarantined", train: manifest.train };
    }

    await writeOtaChannelState(homeDir, channel, {
      ...manifestMeta,
      lastCheckedAt: nowIso(),
      lastError: null,
      available,
      minShellBlocked: false,
      blockedReason: null,
    });
    log(`[ota] train ${manifest.train} (${version}) available; waiting for the user to trigger download`);
    return { outcome: "available", train: manifest.train, version, minShellBlocked: false };
  } catch (err) {
    log(`[ota] check failed: ${err.message}`);
    // lastError is written on every failed check and is only ever cleared
    // by a check or apply that completes successfully — a "not-modified"
    // reply must never be mistaken for "the previous failure is resolved".
    await writeOtaChannelState(homeDir, channel, { lastCheckedAt: nowIso(), lastError: err.message }).catch(() => {});
    return { outcome: "error", error: err.message };
  }
}

// `scheduleBackgroundOtaChecks` deliberately does NOT live here — it is
// shell timer wiring (setTimeout/setInterval cadence, `onAvailable`
// broadcast callback), not update-pipeline logic, and stays in the desktop
// shell (`desktop/src/shared/artifact-ota.cjs`), which calls `checkOnce`
// above with the real `devBypass` injected.

// ── downloadAndApplyArtifacts: the only function allowed to write bytes ───

/**
 * Downloads and activates one train. Only ever call this because a user
 * clicked something — see the file header for why this is a hard rule.
 * Re-fetches the manifest bypassing the ETag cache and re-runs every gate
 * (the shelf may have moved since the last `checkOnce`), then stages both
 * archives and activates them (server first, then renderer, with the same
 * "roll back the server pointer if renderer fails" rollback `checkOnce`'s
 * predecessor used — see the file header's "why a rollback" note).
 *
 * Does NOT promote `next` to `current` and does NOT restart anything —
 * that's the existing apply-now sequence's job
 * (`train-update-apply.cjs`, orchestrated by desktop/main.cjs), which
 * runs immediately afterward on success in the real IPC handler.
 *
 * @param {{homeDir: string, keyset: Array<{keyId:string, publicKey:string}>,
 *   currentShellVersion: string, platformArch: string, channel?: string,
 *   onProgress?: (event: {phase: "downloading"|"verifying"|"activating",
 *     kind: "server"|"renderer", receivedBytes: number, totalBytes: number,
 *     overallReceivedBytes: number, overallTotalBytes: number}) => void,
 *   log?: (msg: string) => void, fetchOnce?: Function,
 *   devBypass?: {hasDevOverride: () => boolean, resolveDevManifestOverride: () => string|null}}} opts
 *   `devBypass` defaults to "no override, ever" — see `fetchChannelManifest`'s
 *   doc comment. `overallReceivedBytes`/`overallTotalBytes` on each event are
 *   the cumulative position across BOTH artifacts (server entry's size is
 *   already known before either download starts, so the total is fixed for
 *   the whole call) — added so a progress bar can run one continuous 0→100
 *   instead of resetting between the server and renderer archives. The
 *   per-artifact `receivedBytes`/`totalBytes` fields are unchanged for
 *   anything that still wants the per-archive view.
 * @returns {Promise<{ok: true, train: number, version: string}
 *   | {ok: true, alreadyCurrent: true, train: number}
 *   | {ok: false, error: string}>}
 */
async function downloadAndApplyArtifacts(opts) {
  const {
    homeDir,
    keyset,
    currentShellVersion,
    platformArch,
    channel = SEED_CHANNEL,
    onProgress = () => {},
    log = () => {},
    fetchOnce,
    devBypass = NO_DEV_OVERRIDE,
  } = opts || {};
  if (!homeDir) throw new Error("artifact-ota: homeDir is required");
  if (!Array.isArray(keyset) || keyset.length === 0) throw new Error("artifact-ota: keyset is required");
  if (!currentShellVersion) throw new Error("artifact-ota: currentShellVersion is required");
  if (!platformArch) throw new Error("artifact-ota: platformArch is required");

  // The apply fetch itself bypasses ETag, but keep the last GitHub token in
  // bookkeeping if this manually triggered round does not return a new one.
  const priorCachedEtags = cachedGithubEtags((await readOtaState(homeDir))[channel] || {});

  try {
    // Bypass the ETag cache on purpose: the point of a click-triggered
    // download is to get the latest shelf state, not whatever checkOnce
    // last cached.
    const fetched = await fetchChannelManifest({ channel, keyset, cachedEtags: {}, log, fetchOnce, devBypass });
    if (fetched.notModified) {
      // Can't happen with no cache token sent to either source, but guard
      // explicitly rather than silently proceeding with no manifest.
      throw new Error("artifact-ota: unexpected 304 with no cache token sent");
    }
    // Verification already happened inside fetchChannelManifest — see that
    // function's doc comment.
    const { manifest, sourceUrl, sourceKind, originUnreachable, localDir } = fetched;

    // Channel namespace assertion — see the file header's "channel
    // assertion" note (same rule checkOnce applies, enforced here too
    // since a user-triggered download must never activate a
    // signed-but-wrong-channel manifest either).
    if (manifest.channel !== channel) {
      throw new Error(
        `artifact-ota: manifest channel mismatch — requested "${channel}", manifest declares "${manifest.channel}" `
          + `(source ${sourceUrl}); refusing to trust a "${manifest.channel}" manifest for the "${channel}" channel`,
      );
    }

    const manifestMeta = {
      manifestEtags: mergeSourceEtags(priorCachedEtags, fetched.sourceEtagUpdate),
      manifestSource: sourceKind,
      manifestReleasedAt: manifest.releasedAt,
      originUnreachable,
      lastManifestUrl: sourceUrl,
    };

    const currentPointer = await pointerStore.readPointer(homeDir, channel, "current");
    const currentTrain = currentPointer && Number.isInteger(currentPointer.train) ? currentPointer.train : null;
    if (currentTrain !== null && manifest.train <= currentTrain) {
      // Softened like checkOnce's monotonic gate: an apply racing a machine
      // that already caught up (background pull, a double click, or a shell
      // update that planted a newer seed) is a normal terminal state, not a
      // fault. Refresh the channel state so a stale "available" clears and
      // the card returns to "up to date".
      log(`[ota] apply requested but train ${manifest.train} is not newer than the current train ${currentTrain}; already caught up`);
      await writeOtaChannelState(homeDir, channel, {
        ...manifestMeta,
        lastCheckedAt: nowIso(),
        lastError: null,
        available: null,
        minShellBlocked: false,
        blockedReason: null,
      });
      return { ok: true, alreadyCurrent: true, train: manifest.train };
    }

    if (!isShellVersionSufficient(currentShellVersion, manifest.minShell)) {
      throw new Error(`minShell ${manifest.minShell} > shell ${currentShellVersion}`);
    }

    if (!isPreloadContractSatisfied(manifest.contract.preload, PRELOAD_API_VERSION)) {
      throw new Error(`train requires preload contract ${manifest.contract.preload} > shell's ${PRELOAD_API_VERSION}`);
    }

    const rolloutId = await ensureRolloutId(homeDir);
    if (!isInRolloutBucket({ rolloutId, salt: manifest.rollout.salt, percent: manifest.rollout.percent })) {
      throw new Error(`train ${manifest.train} is rollout-excluded for this install`);
    }

    if (await pointerStore.isQuarantined(homeDir, channel, manifest.train)) {
      throw new Error(`train ${manifest.train} is quarantined`);
    }

    const { serverEntry, rendererEntry, version } = deriveArtifactEntries(manifest, platformArch);

    // Same version reconciliation gate checkOnce applies (see
    // `isVersionAlreadyCurrent`'s doc comment) — a version directory is
    // named after the version number, so content stamped with a version
    // that's already activated can never be applied regardless of its
    // sha256. Checked before acquiring the lock or staging anything so a
    // same-version train never triggers a doomed multi-hundred-MB download.
    const rendererChannel = rendererPointerChannel(channel);
    const currentRendererPointer = await pointerStore.readPointer(homeDir, rendererChannel, "current");
    if (isVersionAlreadyCurrent({ currentServerPointer: currentPointer, currentRendererPointer, serverEntry, rendererEntry })) {
      throw new Error(
        `train ${manifest.train} (${version}) matches the currently activated version ${currentPointer.version}; `
          + "content with the same version can never be applied, even though its bytes differ",
      );
    }

    // Version direction gate (see `isVersionBehindCurrent`'s doc comment):
    // content version never goes backward. Also checked before acquiring
    // the lock so a downgrade train never triggers a doomed download.
    if (isVersionBehindCurrent({ currentServerPointer: currentPointer, currentRendererPointer, serverEntry, rendererEntry })) {
      throw new Error(
        `train ${manifest.train} (${version}) is older than the currently activated version ${currentPointer.version}; `
          + "content version is never allowed to go backward — a rollback must be re-published under a higher version number",
      );
    }

    const lock = await pointerStore.acquireLock(homeDir);
    if (!lock) {
      throw new Error("artifacts lock held by another instance; try again in a moment");
    }

    const stagingDir = path.join(pointerStore.artifactsRoot(homeDir), STAGING_DIRNAME);
    const serverStagedPath = path.join(stagingDir, `server-${serverEntry.version}-${platformArch}.tar.gz`);
    const rendererStagedPath = path.join(stagingDir, `renderer-${rendererEntry.version}.tar.gz`);

    // Both sizes are known before either download starts (manifest entries
    // carry `.size`), so the combined total is fixed for the whole call —
    // computed once here rather than re-derived per event. Server bytes
    // count first, then renderer bytes stack on top of the server's full
    // size, so a UI consuming `overallReceivedBytes/overallTotalBytes`
    // sees one continuous 0→100 sweep across both artifacts instead of the
    // per-artifact `receivedBytes/totalBytes` resetting to 0 when the
    // renderer download starts.
    //
    // `overallHighWaterMark` guards against a real ordering wrinkle: both
    // artifacts are fully downloaded AND verified before either one starts
    // activating (activation only begins once both `stageArtifact` calls
    // above have returned, inside the pointer mutex). So the naive
    // per-kind formula (server's own contribution = its own
    // receivedBytes) would make `activating:server` report only
    // `serverEntry.size`, even though the renderer's bytes were already
    // fully counted moments earlier at `verifying:renderer` — a visible
    // backward dip right as the bar should be finishing. Clamping to the
    // running max keeps the field monotonically non-decreasing regardless
    // of which kind an "already fully downloaded" activation event names.
    const overallTotalBytes = serverEntry.size + rendererEntry.size;
    let overallHighWaterMark = 0;
    const emitProgress = (event) => {
      const raw = event.kind === "server" ? event.receivedBytes : serverEntry.size + event.receivedBytes;
      overallHighWaterMark = Math.max(overallHighWaterMark, raw);
      onProgress({ ...event, overallReceivedBytes: overallHighWaterMark, overallTotalBytes });
    };

    try {
      await fsp.mkdir(stagingDir, { recursive: true });

      emitProgress({ phase: "downloading", kind: "server", receivedBytes: 0, totalBytes: serverEntry.size });
      await stageArtifact({
        finalPath: serverStagedPath,
        entry: serverEntry,
        mirrors: manifest.mirrors,
        localDir,
        log,
        label: `server-${serverEntry.version}-${platformArch}`,
        onProgress: (receivedBytes) => emitProgress({ phase: "downloading", kind: "server", receivedBytes, totalBytes: serverEntry.size }),
      });
      emitProgress({ phase: "verifying", kind: "server", receivedBytes: serverEntry.size, totalBytes: serverEntry.size });

      emitProgress({ phase: "downloading", kind: "renderer", receivedBytes: 0, totalBytes: rendererEntry.size });
      await stageArtifact({
        finalPath: rendererStagedPath,
        entry: rendererEntry,
        mirrors: manifest.mirrors,
        localDir,
        log,
        label: `renderer-${rendererEntry.version}`,
        onProgress: (receivedBytes) => emitProgress({ phase: "downloading", kind: "renderer", receivedBytes, totalBytes: rendererEntry.size }),
      });
      emitProgress({ phase: "verifying", kind: "renderer", receivedBytes: rendererEntry.size, totalBytes: rendererEntry.size });

      // Both boxes staged and sha256-verified. Activate server first, then
      // renderer; roll the server `next` pointer back if renderer's
      // activation fails (see "why a rollback" note in the file header).
      // This whole segment (activation through the state-file write) runs
      // inside the in-process pointer mutex — kept deliberately narrow
      // (excludes the download above, which can take minutes) so it never
      // interleaves with a concurrent boot-time promote/demote decision in
      // artifact-boot.cjs, which could otherwise clear a `next` pointer this
      // segment just wrote. See pointer-store.cjs's `withPointerMutex` doc
      // comment for the full rationale.
      await pointerStore.withPointerMutex(homeDir, async () => {
        emitProgress({ phase: "activating", kind: "server", receivedBytes: serverEntry.size, totalBytes: serverEntry.size });
        await activation.activateFromArchive(serverStagedPath, manifest, {
          homeDir,
          channel,
          kind: "server",
          platformArch,
        });
        emitProgress({ phase: "activating", kind: "renderer", receivedBytes: rendererEntry.size, totalBytes: rendererEntry.size });
        try {
          await activation.activateFromArchive(rendererStagedPath, manifest, {
            homeDir,
            channel: rendererChannel,
            kind: "renderer",
          });
        } catch (err) {
          await pointerStore.clearPointer(homeDir, channel, "next").catch(() => {});
          throw new Error(`renderer activation failed, server next pointer rolled back: ${err.message}`);
        }

        await writeOtaChannelState(homeDir, channel, {
          ...manifestMeta,
          lastCheckedAt: nowIso(),
          lastError: null,
          available: null,
          minShellBlocked: false,
          lastStagedTrain: manifest.train,
        });
      });
      log(`[ota] train ${manifest.train} staged and activated (server ${serverEntry.version}, renderer ${rendererEntry.version})`);
      return { ok: true, train: manifest.train, version };
    } finally {
      await fsp.rm(serverStagedPath, { force: true }).catch(() => {});
      await fsp.rm(rendererStagedPath, { force: true }).catch(() => {});
      await fsp.rm(`${serverStagedPath}.part`, { force: true }).catch(() => {});
      await fsp.rm(`${rendererStagedPath}.part`, { force: true }).catch(() => {});
      await lock.release();
    }
  } catch (err) {
    log(`[ota] download/apply failed: ${err.message}`);
    await writeOtaChannelState(homeDir, channel, { lastCheckedAt: nowIso(), lastError: err.message }).catch(() => {});
    return { ok: false, error: err.message };
  }
}

// ── downloadAndApplyRendererArtifact: renderer-only pull for the
//    self-hosted form (`hana bundle pull`) ────────────────────────────────

/**
 * Renderer-only variant of `downloadAndApplyArtifacts` for the self-hosted
 * form: the operator installs and upgrades the server themselves (it's
 * their package manager's job), and only ever pulls the WEB FRONTEND
 * (renderer box) from the release shelf. The server artifact is never
 * downloaded, never activated, and its pointer namespace is never touched
 * — operator sovereignty over the server binary is the line this function
 * must never cross.
 *
 * Runs only because an operator typed a command (`hana bundle pull`) —
 * the same human-in-the-loop rule `downloadAndApplyArtifacts` carries; no
 * timer, daemon, or background code may ever call this.
 *
 * Gates kept from the desktop pipeline (same semantics): signed GitHub
 * manifest fetch, channel namespace
 * assertion, renderer version already-current short-circuit, train
 * monotonic, version never goes backward, quarantine — plus the
 * serverProtocol contract gate, which replaces the desktop's preload gate
 * as "is the host new enough for this content" (see
 * `isServerProtocolSatisfied`'s doc comment).
 *
 * Gates deliberately SKIPPED, because the desktop concepts behind them do
 * not exist in the self-hosted form:
 *   - minShell: there is no Electron shell here to be "too old" — the
 *     operator's server is the host, and its compatibility is exactly what
 *     the serverProtocol contract gate checks instead.
 *   - rollout bucketing: rollout percentages exist to stagger AUTOMATIC
 *     background updates across a fleet of desktop installs; an operator
 *     explicitly typing `hana bundle pull` is a full-intent action, and
 *     gradual rollout must never hold an explicit command back.
 *   - preload contract: the preload API is an Electron shell surface; a
 *     browser-served frontend has no preload bridge at all.
 *
 * PROMOTES IMMEDIATELY after activation — the one deliberate behavioral
 * difference from the desktop pipeline, which writes `next` and leaves the
 * promote for the next launch. The desktop defers promotion so
 * artifact-boot's crash-fallback chain can demote a train that keeps
 * crashing the app at startup. Here the operator explicitly asked for the
 * update NOW, and the renderer box is static files served over HTTP —
 * nothing from it executes inside the server process, so there is no
 * startup-crash loop for a deferred promote to protect against;
 * `previous` still records the prior version for manual recovery.
 * "Restart `hana serve` to take effect" remains the operator's step
 * because the running server resolved its renderer root at boot.
 *
 * @param {{homeDir: string, keyset: Array<{keyId:string, publicKey:string}>,
 *   channel?: string, serverProtocolVersion: number,
 *   onProgress?: (event: {phase: "downloading"|"verifying"|"activating",
 *     kind: "renderer", receivedBytes: number, totalBytes: number,
 *     overallReceivedBytes: number, overallTotalBytes: number}) => void,
 *   log?: (msg: string) => void, fetchOnce?: Function,
 *   devBypass?: {hasDevOverride: () => boolean, resolveDevManifestOverride: () => string|null}}} opts
 *   `devBypass` defaults to "no override, ever" (see `NO_DEV_OVERRIDE`);
 *   the CLI never passes one — only tests inject a local-fixture stub.
 *   `overallReceivedBytes`/`overallTotalBytes` mirror the fields
 *   `downloadAndApplyArtifacts` adds for its two-artifact progress bar;
 *   here there is only ever one artifact, so they always equal the
 *   per-artifact `receivedBytes`/`totalBytes` — kept for a shared consumer
 *   (the desktop progress hook) to read one field name regardless of which
 *   entry point produced the event.
 * @returns {Promise<{ok: true, train: number, version: string} |
 *   {ok: true, alreadyCurrent: true, version: string} |
 *   {ok: false, error: string}>}
 */
async function downloadAndApplyRendererArtifact(opts) {
  const {
    homeDir,
    keyset,
    channel = SEED_CHANNEL,
    serverProtocolVersion,
    onProgress = () => {},
    log = () => {},
    fetchOnce,
    devBypass = NO_DEV_OVERRIDE,
  } = opts || {};
  if (!homeDir) throw new Error("artifact-ota: homeDir is required");
  if (!Array.isArray(keyset) || keyset.length === 0) throw new Error("artifact-ota: keyset is required");
  if (!Number.isInteger(serverProtocolVersion)) throw new Error("artifact-ota: serverProtocolVersion is required");

  // Same GitHub-only ETag bookkeeping as downloadAndApplyArtifacts.
  const priorCachedEtags = cachedGithubEtags((await readOtaState(homeDir))[channel] || {});

  try {
    // Bypass the ETag cache on purpose: an operator-triggered pull wants
    // the latest shelf state, not whatever a previous run cached.
    const fetched = await fetchChannelManifest({ channel, keyset, cachedEtags: {}, log, fetchOnce, devBypass });
    if (fetched.notModified) {
      // Can't happen with no cache token sent to either source, but guard
      // explicitly rather than silently proceeding with no manifest.
      throw new Error("artifact-ota: unexpected 304 with no cache token sent");
    }
    // Verification already happened inside fetchChannelManifest — see that
    // function's doc comment.
    const { manifest, sourceUrl, sourceKind, originUnreachable, localDir } = fetched;

    // Channel namespace assertion — see the file header's "channel
    // assertion" note (same rule checkOnce/downloadAndApplyArtifacts
    // apply: an operator's pull must never activate a signed-but-wrong-
    // channel manifest either).
    if (manifest.channel !== channel) {
      throw new Error(
        `artifact-ota: manifest channel mismatch — requested "${channel}", manifest declares "${manifest.channel}" `
          + `(source ${sourceUrl}); refusing to trust a "${manifest.channel}" manifest for the "${channel}" channel`,
      );
    }

    const manifestMeta = {
      manifestEtags: mergeSourceEtags(priorCachedEtags, fetched.sourceEtagUpdate),
      manifestSource: sourceKind,
      manifestReleasedAt: manifest.releasedAt,
      originUnreachable,
      lastManifestUrl: sourceUrl,
    };

    const rendererEntry = manifest.artifacts.renderer;
    if (!rendererEntry) {
      // Same message shape as deriveArtifactEntries', renderer-only.
      throw new Error("manifest missing needed kind(s) for OTA: renderer");
    }

    const rendererChannel = rendererPointerChannel(channel);
    const currentRendererPointer = await pointerStore.readPointer(homeDir, rendererChannel, "current");

    // Version already-current short-circuit, checked BEFORE the train gate
    // on purpose: an operator re-running `hana bundle pull` against an
    // unchanged shelf re-fetches the same train, and "you're already up to
    // date" is the correct answer there, not an error. (The desktop
    // pipeline can afford to treat same-train as a hard failure because
    // its checkOnce layer filters that case out before the user ever sees
    // a download button — no such layer exists in front of this function.)
    // Same-version-different-bytes also lands here, exactly like
    // `isVersionAlreadyCurrent`: a version directory is named after the
    // version number, so same-version content can never be applied anyway.
    if (
      currentRendererPointer
      && typeof currentRendererPointer.version === "string"
      && currentRendererPointer.version.length > 0
      && currentRendererPointer.version === rendererEntry.version
    ) {
      await writeOtaChannelState(homeDir, channel, {
        ...manifestMeta,
        lastCheckedAt: nowIso(),
        lastError: null,
        available: null,
      });
      log(`[ota] renderer ${rendererEntry.version} is already the activated version; nothing to pull`);
      return { ok: true, alreadyCurrent: true, version: rendererEntry.version };
    }

    // Train monotonic gate — same semantics as downloadAndApplyArtifacts'
    // hard failure, read from the renderer pointer's recorded train since
    // that's the only kind this function manages (there may be no server
    // pointer at all on a self-hosted box).
    const currentTrain = currentRendererPointer && Number.isInteger(currentRendererPointer.train)
      ? currentRendererPointer.train
      : null;
    if (currentTrain !== null && manifest.train <= currentTrain) {
      throw new Error(`train ${manifest.train} is not newer than the current train ${currentTrain}; nothing to apply`);
    }

    // Version direction gate: renderer content version never goes backward
    // — same rule and same recall playbook as `isVersionBehindCurrent`,
    // renderer side only.
    if (
      currentRendererPointer
      && typeof currentRendererPointer.version === "string"
      && currentRendererPointer.version.length > 0
    ) {
      const cmp = compareVersions(rendererEntry.version, currentRendererPointer.version);
      if (cmp !== null && cmp < 0) {
        throw new Error(
          `train ${manifest.train} (${rendererEntry.version}) is older than the currently activated version `
            + `${currentRendererPointer.version}; content version is never allowed to go backward — a rollback `
            + "must be re-published under a higher version number",
        );
      }
    }

    // serverProtocol contract gate — see this function's and
    // `isServerProtocolSatisfied`'s doc comments.
    if (!isServerProtocolSatisfied(manifest.contract && manifest.contract.serverProtocol, serverProtocolVersion)) {
      throw new Error(
        `renderer requires server protocol ${manifest.contract.serverProtocol}, this server speaks `
          + `${serverProtocolVersion} — upgrade the server first`,
      );
    }

    if (await pointerStore.isQuarantined(homeDir, rendererChannel, manifest.train)) {
      throw new Error(`train ${manifest.train} is quarantined`);
    }

    // minShell / rollout / preload gates deliberately absent here — see
    // this function's doc comment for why each one has no self-hosted
    // meaning.

    const lock = await pointerStore.acquireLock(homeDir);
    if (!lock) {
      throw new Error("artifacts lock held by another instance; try again in a moment");
    }

    const stagingDir = path.join(pointerStore.artifactsRoot(homeDir), STAGING_DIRNAME);
    const rendererStagedPath = path.join(stagingDir, `renderer-${rendererEntry.version}.tar.gz`);

    // Single-artifact path: the "overall" view is just the renderer's own
    // view — see this function's doc comment for why the field still
    // exists here.
    const overallTotalBytes = rendererEntry.size;
    const emitProgress = (event) => onProgress({ ...event, overallReceivedBytes: event.receivedBytes, overallTotalBytes });

    try {
      await fsp.mkdir(stagingDir, { recursive: true });

      emitProgress({ phase: "downloading", kind: "renderer", receivedBytes: 0, totalBytes: rendererEntry.size });
      await stageArtifact({
        finalPath: rendererStagedPath,
        entry: rendererEntry,
        mirrors: manifest.mirrors,
        localDir,
        log,
        label: `renderer-${rendererEntry.version}`,
        onProgress: (receivedBytes) => emitProgress({ phase: "downloading", kind: "renderer", receivedBytes, totalBytes: rendererEntry.size }),
      });
      emitProgress({ phase: "verifying", kind: "renderer", receivedBytes: rendererEntry.size, totalBytes: rendererEntry.size });

      // Activation + immediate promote + state write, all inside the
      // in-process pointer mutex — same "never interleave with a
      // concurrent promote/demote decision" rationale as
      // downloadAndApplyArtifacts (see its inline comment), narrower here
      // because there's only one kind.
      await pointerStore.withPointerMutex(homeDir, async () => {
        emitProgress({ phase: "activating", kind: "renderer", receivedBytes: rendererEntry.size, totalBytes: rendererEntry.size });
        await activation.activateFromArchive(rendererStagedPath, manifest, {
          homeDir,
          channel: rendererChannel,
          kind: "renderer",
        });
        // Promote immediately — the deliberate difference from the desktop
        // pipeline; see this function's doc comment ("PROMOTES
        // IMMEDIATELY") for why that is safe and intended here.
        await pointerStore.promote(homeDir, rendererChannel);

        await writeOtaChannelState(homeDir, channel, {
          ...manifestMeta,
          lastCheckedAt: nowIso(),
          lastError: null,
          available: null,
          lastStagedTrain: manifest.train,
        });
      });
      log(`[ota] renderer ${rendererEntry.version} (train ${manifest.train}) pulled, activated, and promoted`);
      return { ok: true, train: manifest.train, version: rendererEntry.version };
    } finally {
      await fsp.rm(rendererStagedPath, { force: true }).catch(() => {});
      await fsp.rm(`${rendererStagedPath}.part`, { force: true }).catch(() => {});
      await lock.release();
    }
  } catch (err) {
    log(`[ota] renderer pull failed: ${err.message}`);
    await writeOtaChannelState(homeDir, channel, { lastCheckedAt: nowIso(), lastError: err.message }).catch(() => {});
    return { ok: false, error: err.message };
  }
}

// `hasDevOverrideConfigured` also does NOT live here — it's a one-line
// wrapper around the real dev-bypass module's `hasDevOverride()`, kept in
// the desktop shell alongside the static `require("./artifact-ota-dev-bypass.cjs")`
// that only the shell is allowed to hold.

// ── staged-train read-only query (train update UI) ───────────────
//
// Minimal surface for the settings-page/sticker UI and the apply-now IPC
// handler (desktop/main.cjs) to ask "is a train fully staged and ready to
// promote right now" without reaching into pointer-store directly. This is
// a pure READ — it never writes a pointer, never downloads, never touches
// `current`/`previous`. The actual promote step still only ever happens
// through the existing artifact-boot chain (prepareArtifactServerBoot /
// prepareArtifactRendererBoot), exactly as at ordinary boot.

/**
 * The apply-now precondition guard, exported standalone so it's a direct
 * mutation-test target: promote() must only ever be attempted when BOTH
 * kinds' `next` pointers exist and agree on the same train number. A
 * partially-staged train (one kind downloaded, the other not yet, or a
 * torn write) must never be treated as ready — this mirrors the "either
 * both next pointers land or neither does" invariant `downloadAndApplyArtifacts`
 * itself already enforces via the server-next rollback (see the "why a
 * rollback" note in this file's header).
 * @param {{serverNext: {train?: number}|null, rendererNext: {train?: number}|null}} pointers
 * @returns {boolean}
 */
function bothNextPointersReady({ serverNext, rendererNext }) {
  if (!serverNext || !rendererNext) return false;
  if (!Number.isInteger(serverNext.train) || !Number.isInteger(rendererNext.train)) return false;
  return serverNext.train === rendererNext.train;
}

/**
 * Pure projection from the two raw next-pointers to the status shape the
 * UI/IPC layer actually wants. Split out from `readStagedTrainStatus` so
 * the projection logic is testable without touching the filesystem.
 * @param {{serverNext: object|null, rendererNext: object|null}} pointers
 * @returns {{staged: boolean, train: number|null, version: string|null}}
 */
function resolveStagedTrainStatus({ serverNext, rendererNext }) {
  if (!bothNextPointersReady({ serverNext, rendererNext })) {
    return { staged: false, train: null, version: null };
  }
  return {
    staged: true,
    train: serverNext.train,
    // Product version display: renderer and server are stamped
    // with the same product version at build time; renderer wins the tie
    // arbitrarily (both must agree in practice).
    version: rendererNext.version || serverNext.version || null,
  };
}

/**
 * A cached `available` descriptor can outlive the update it described when
 * a full installer/seed boot advances both current pointers without going
 * through the OTA apply path that normally clears ota-state.json. This is a
 * read-only reconciliation: suppress the stale descriptor only when BOTH
 * component pointers carry comparable versions at or beyond it. Missing,
 * split, or malformed pointer state stays visible so a partial update can
 * never be mistaken for completion.
 * @param {{available: object|null, currentServerPointer: object|null,
 *   currentRendererPointer: object|null}} opts
 * @returns {boolean}
 */
function isCachedAvailableSatisfied({ available, currentServerPointer, currentRendererPointer }) {
  if (!available || typeof available.version !== "string" || available.version.length === 0) return false;
  if (!currentServerPointer || !currentRendererPointer) return false;
  const serverCmp = compareVersions(currentServerPointer.version, available.version);
  const rendererCmp = compareVersions(currentRendererPointer.version, available.version);
  return serverCmp !== null && serverCmp >= 0 && rendererCmp !== null && rendererCmp >= 0;
}

/**
 * `minShellBlocked` covers every way this shell can be too old for a real,
 * gate-passing update: the minShell version string gate AND the preload
 * contract integer gate (see `checkOnce`'s `blockedReason` field in
 * ota-state.json for which one actually fired — diagnostic only, this
 * return value and the UI built on it treat both identically, because both
 * mean the same thing to the user: "update the app itself first").
 *
 * @param {string} homeDir
 * @param {{channel?: string}} [opts]
 * @returns {Promise<{staged: boolean, train: number|null, version: string|null,
 *   minShellBlocked: boolean, available: object|null, lastError: string|null,
 *   lastCheckedAt: string|null, manifestSource: "origin"|"mirror"|null,
 *   manifestReleasedAt: string|null, originUnreachable: boolean}>}
 */
async function readStagedTrainStatus(homeDir, opts = {}) {
  const { channel = SEED_CHANNEL } = opts;
  const rendererChannel = rendererPointerChannel(channel);
  const [serverNext, rendererNext, currentServerPointer, currentRendererPointer, otaState] = await Promise.all([
    pointerStore.readPointer(homeDir, channel, "next"),
    pointerStore.readPointer(homeDir, rendererChannel, "next"),
    pointerStore.readPointer(homeDir, channel, "current"),
    pointerStore.readPointer(homeDir, rendererChannel, "current"),
    readOtaState(homeDir),
  ]);
  const status = resolveStagedTrainStatus({ serverNext, rendererNext });
  const channelState = (otaState && otaState[channel]) || {};
  // Read-time compat: a shell built before this field existed only ever
  // wrote the legacy `lastSkipReason` string; a shell built after it
  // writes the boolean directly. Both are honored so an old ota-state.json
  // never crashes or silently reports the wrong thing after an upgrade.
  const cachedMinShellBlocked = typeof channelState.minShellBlocked === "boolean"
    ? channelState.minShellBlocked
    : typeof channelState.lastSkipReason === "string" && channelState.lastSkipReason.startsWith("minShell ");
  const cachedAvailable = channelState.available && typeof channelState.available === "object" ? channelState.available : null;
  const availableSatisfied = isCachedAvailableSatisfied({
    available: cachedAvailable,
    currentServerPointer,
    currentRendererPointer,
  });
  const available = availableSatisfied ? null : cachedAvailable;
  // `minShellBlocked` describes the cached available update, not a durable
  // shell condition. Once both components have reached that version, the
  // stale block must disappear with its descriptor in this projection.
  const minShellBlocked = availableSatisfied ? false : cachedMinShellBlocked;
  return {
    ...status,
    minShellBlocked,
    available,
    lastError: typeof channelState.lastError === "string" ? channelState.lastError : null,
    lastCheckedAt: typeof channelState.lastCheckedAt === "string" ? channelState.lastCheckedAt : null,
    // Normalize legacy multi-source provenance to the one public source.
    // Old fields remain readable but cannot produce backup-source UI copy.
    manifestSource: channelState.manifestSource === "origin" ? "origin" : null,
    manifestReleasedAt: typeof channelState.manifestReleasedAt === "string" ? channelState.manifestReleasedAt : null,
    originUnreachable: false,
  };
}

module.exports = {
  SEED_CHANNEL,
  FIRST_CHECK_DELAY_MS,
  RECHECK_INTERVAL_MS,
  ORIGIN_MANIFEST_RACE_TIMEOUT_MS,
  channelManifestUrls,
  isShellVersionSufficient,
  isPreloadContractSatisfied,
  isServerProtocolSatisfied,
  computeRolloutBucket,
  isInRolloutBucket,
  ensureRolloutId,
  readOtaState,
  writeOtaChannelState,
  fetchWithRedirects,
  fetchBuffer,
  downloadToFile,
  fetchChannelManifest,
  checkOnce,
  downloadAndApplyArtifacts,
  downloadAndApplyRendererArtifact,
  bothNextPointersReady,
  resolveStagedTrainStatus,
  readStagedTrainStatus,
};
