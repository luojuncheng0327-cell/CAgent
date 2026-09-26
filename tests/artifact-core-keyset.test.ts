import { createPublicKey } from "crypto";
import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("artifact-core keyset loader", () => {
  it("loads this fork's pinned signing key", () => {
    const { loadPinnedKeyset } = require("../shared/artifact-core/keyset.cjs");
    const keyset = loadPinnedKeyset();
    expect(Array.isArray(keyset)).toBe(true);
    expect(keyset.length).toBeGreaterThanOrEqual(1);
    expect(keyset[0].keyId).toBe("cagent-local-2026");
  });

  it("every entry carries a PEM string that parses as an ed25519 public key", () => {
    const { loadPinnedKeyset } = require("../shared/artifact-core/keyset.cjs");
    for (const entry of loadPinnedKeyset()) {
      expect(typeof entry.keyId).toBe("string");
      expect(entry.keyId.length).toBeGreaterThan(0);
      expect(typeof entry.publicKey).toBe("string");
      const keyObject = createPublicKey(entry.publicKey);
      expect(keyObject.asymmetricKeyType).toBe("ed25519");
    }
  });

  it("returns a fresh array per call so callers cannot mutate the pinned source", () => {
    const { loadPinnedKeyset } = require("../shared/artifact-core/keyset.cjs");
    const first = loadPinnedKeyset();
    first.pop();
    const second = loadPinnedKeyset();
    expect(second.length).toBeGreaterThanOrEqual(1);
  });

  it("pinned key matches the CAgent public key bytes exactly", () => {
    const { loadPinnedKeyset } = require("../shared/artifact-core/keyset.cjs");
    const entry = loadPinnedKeyset().find((e: { keyId: string }) => e.keyId === "cagent-local-2026");
    expect(entry.publicKey).toBe(
      "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAKxPS6urUYQBTKKfD3ue2YGQHzV//rDRr5IQwooBcGO0=\n-----END PUBLIC KEY-----\n",
    );
  });
});
