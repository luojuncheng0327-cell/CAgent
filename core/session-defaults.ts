import { SettingsManager } from "../lib/pi-sdk/index.ts";

/** 默认 session settings */
export function createDefaultSettings() {
  return SettingsManager.inMemory({
    steeringMode: "all",
    // One retry owner: the session emits visible retry events. Provider-level
    // retries would multiply requests underneath that budget.
    retry: {
      enabled: true,
      maxRetries: 1,
      baseDelayMs: 2000,
      provider: { maxRetries: 0, maxRetryDelayMs: 30_000 },
    },
    compaction: {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20_000,
    },
  });
}
