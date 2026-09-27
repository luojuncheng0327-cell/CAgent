/**
 * Settings > About update history.
 *
 * This fork's GitHub feed is the release source of truth. The installed v2 anthology is
 * only an explicit offline fallback because older app packages cannot contain
 * releases published after they were built.
 */

const { feedUrl } = require("../../../shared/release-source.cjs");
const HISTORY_URL = `${feedUrl}release-digest.v2.json`;
const HISTORY_LIMIT = 5;
const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RELEASES_BODY_CHARS = 512 * 1024;

function versionFromTag(tag) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(String(tag || "").trim());
  return match ? match[1] : null;
}

async function fetchJson(fetchImpl, url, { maxChars, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "HanaAgent-update-history",
      },
      signal: controller.signal,
    });
    if (!response?.ok) {
      throw new Error(`request failed (${response?.status || "unknown"}) for ${url}`);
    }
    const text = await response.text();
    if (text.length > maxChars) {
      throw new Error(`response too large for ${url}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function loadOnlineEntries({ fetchImpl, normalize, timeoutMs }) {
  const history = await fetchJson(fetchImpl, HISTORY_URL, {
    maxChars: MAX_RELEASES_BODY_CHARS,
    timeoutMs,
  });
  if (history?.schema !== 2 || !Array.isArray(history.entries)) {
    throw new Error("GitHub update history is not a valid v2 history");
  }
  const entries = [];
  for (const payload of history.entries) {
    const version = versionFromTag(payload?.tag);
    if (!version) continue;
    try {
      const entry = normalize(payload, version);
      if (entry && !entries.some(existing => existing.version === entry.version)) entries.push(entry);
    } catch { /* skip malformed entries while retaining the rest of the history */ }
    if (entries.length === HISTORY_LIMIT) break;
  }
  return entries;
}

function createUpdateDigestHistoryLoader({
  fetchImpl = globalThis.fetch,
  normalize,
  readBundledEntries,
  log = () => {},
  now = () => Date.now(),
  cacheTtlMs = CACHE_TTL_MS,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof normalize !== "function") throw new TypeError("normalize must be a function");
  if (typeof readBundledEntries !== "function") throw new TypeError("readBundledEntries must be a function");

  let cached = null;
  let inFlight = null;

  return async function loadUpdateDigestHistory() {
    const currentTime = now();
    if (cached && currentTime - cached.storedAt < cacheTtlMs) return cached.result;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const entries = await loadOnlineEntries({ fetchImpl, normalize, timeoutMs });
        if (entries.length === 0) throw new Error("no valid release digests found");
        const result = {
          entries,
          source: "online",
          complete: entries.length === HISTORY_LIMIT,
        };
        cached = { result, storedAt: now() };
        return result;
      } catch (error) {
        log(`update history online load failed: ${error?.message || String(error)}`);
        const entries = readBundledEntries().slice(0, HISTORY_LIMIT);
        return {
          entries,
          source: entries.length > 0 ? "bundled" : "none",
          complete: false,
        };
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  };
}

module.exports = {
  createUpdateDigestHistoryLoader,
  versionFromTag,
};
