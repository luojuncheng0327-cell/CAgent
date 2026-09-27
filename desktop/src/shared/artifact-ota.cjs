"use strict";

/**
 * artifact-ota.cjs — desktop shell over the shared OTA pipeline core
 * (`shared/artifact-core/ota-core.cjs`, which now owns checkOnce,
 * downloadAndApplyArtifacts, the dual-source manifest fetch, staging,
 * rollout bucketing, and every gate/judgment function; see that file's
 * header for the full pipeline design — check/verify/download/activate
 * rationale, gate order, dual-source race, channel assertion, and the
 * "why a rollback" note all live there now).
 *
 * This file's own job is narrow:
 *   - hold the ONE static `require("./artifact-ota-dev-bypass.cjs")`
 *     specifier — `vite.config.main.js`'s alias plugin keys off this exact
 *     literal to swap in the production stub for every `main.bundle.cjs`
 *     build, so the real override can never reach a shipped shell; the
 *     shared core is never allowed to hold this require itself (see
 *     `ota-core.cjs`'s header)
 *   - inject the real dev-bypass module into the core's entry points via
 *     their explicit `devBypass` opt — the desktop shell always wants the
 *     real module's behavior, so it's injected unconditionally rather than
 *     left to each call site
 *   - own the recurring background CHECK-ONLY timer loop
 *     (`scheduleBackgroundOtaChecks`) — setTimeout/setInterval cadence and
 *     the `onAvailable` broadcast callback are shell wiring, not pipeline
 *     logic
 *   - re-export the core's pure functions and constants unchanged
 *
 * Activation to `current` happens at the NEXT LAUNCH, entirely inside
 * `desktop/src/shared/artifact-boot.cjs` (unchanged by this split).
 */

const artifactBoot = require("./artifact-boot.cjs");
const otaCore = require("../../../shared/artifact-core/ota-core.cjs");
// Static specifier on purpose — see artifact-ota-dev-bypass.cjs's header
// comment; vite.config.main.js's alias keys off this exact literal.
const devBypass = require("./artifact-ota-dev-bypass.cjs");
const { electronUpdateTransport } = require("./update-transport.cjs");

const { SEED_CHANNEL } = artifactBoot;

/**
 * Schedules the recurring background CHECK-ONLY loop (deliberately fixed
 * cadence: first check ~30s after the main window is shown, then every
 * 6h). Never downloads or writes an archive — see `checkOnce`'s doc
 * comment in `shared/artifact-core/ota-core.cjs`. Timers are unref'd so
 * they never keep the process alive. Never throws synchronously and the
 * scheduled work never rejects upward.
 * `onAvailable(result)` — optional — fires whenever a cycle's outcome is
 * "available" or "minshell-blocked", i.e. whenever there's something a UI
 * layer might want to announce; kept as an injected callback so the
 * pipeline core stays Electron-free (desktop/main.cjs wires it to a window
 * broadcast).
 * @returns {NodeJS.Timeout} the initial delay timer (exposed for tests only)
 */
function scheduleBackgroundOtaChecks(opts) {
  const {
    homeDir,
    keyset,
    currentShellVersion,
    platformArch,
    channel = SEED_CHANNEL,
    firstDelayMs = otaCore.FIRST_CHECK_DELAY_MS,
    intervalMs = otaCore.RECHECK_INTERVAL_MS,
    log = () => {},
    onAvailable,
  } = opts || {};

  const runOnce = () => {
    otaCore.checkOnce({ homeDir, keyset, currentShellVersion, platformArch, channel, log, devBypass, fetchOnce: opts.fetchOnce || electronUpdateTransport })
      .then((result) => {
        log(`[ota] cycle: ${result.outcome}${result.error ? ` (${result.error})` : ""}`);
        if ((result.outcome === "available" || result.outcome === "minshell-blocked") && typeof onAvailable === "function") {
          onAvailable(result);
        }
      })
      .catch((err) => {
        // checkOnce is designed to never reject; this is a
        // belt-and-suspenders net so a scheduler bug can never crash or
        // block anything upstream.
        log(`[ota] cycle threw unexpectedly (this should never happen): ${err.message}`);
      });
  };

  const firstTimer = setTimeout(() => {
    runOnce();
    const intervalTimer = setInterval(runOnce, intervalMs);
    if (typeof intervalTimer.unref === "function") intervalTimer.unref();
  }, firstDelayMs);
  if (typeof firstTimer.unref === "function") firstTimer.unref();
  return firstTimer;
}

/** Re-exported so callers (main.cjs) never need to reference the dev-only env var name directly. */
function hasDevOverrideConfigured() {
  return devBypass.hasDevOverride();
}

module.exports = {
  SEED_CHANNEL: otaCore.SEED_CHANNEL,
  FIRST_CHECK_DELAY_MS: otaCore.FIRST_CHECK_DELAY_MS,
  RECHECK_INTERVAL_MS: otaCore.RECHECK_INTERVAL_MS,
  ORIGIN_MANIFEST_RACE_TIMEOUT_MS: otaCore.ORIGIN_MANIFEST_RACE_TIMEOUT_MS,
  channelManifestUrls: otaCore.channelManifestUrls,
  isShellVersionSufficient: otaCore.isShellVersionSufficient,
  isPreloadContractSatisfied: otaCore.isPreloadContractSatisfied,
  computeRolloutBucket: otaCore.computeRolloutBucket,
  isInRolloutBucket: otaCore.isInRolloutBucket,
  ensureRolloutId: otaCore.ensureRolloutId,
  readOtaState: otaCore.readOtaState,
  writeOtaChannelState: otaCore.writeOtaChannelState,
  fetchWithRedirects: otaCore.fetchWithRedirects,
  fetchBuffer: otaCore.fetchBuffer,
  downloadToFile: otaCore.downloadToFile,
  fetchChannelManifest: (opts) => otaCore.fetchChannelManifest({ ...opts, devBypass, fetchOnce: opts?.fetchOnce || electronUpdateTransport }),
  checkOnce: (opts) => otaCore.checkOnce({ ...opts, devBypass, fetchOnce: opts?.fetchOnce || electronUpdateTransport }),
  downloadAndApplyArtifacts: (opts) => otaCore.downloadAndApplyArtifacts({ ...opts, devBypass, fetchOnce: opts?.fetchOnce || electronUpdateTransport }),
  scheduleBackgroundOtaChecks,
  hasDevOverrideConfigured,
  bothNextPointersReady: otaCore.bothNextPointersReady,
  resolveStagedTrainStatus: otaCore.resolveStagedTrainStatus,
  readStagedTrainStatus: otaCore.readStagedTrainStatus,
};
