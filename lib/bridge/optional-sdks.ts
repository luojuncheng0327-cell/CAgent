import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const OPTIONAL_BRIDGE_SDKS = ["node-telegram-bot-api", "@larksuiteoapi/node-sdk"] as const;

// Bridge metadata is used by the desktop even when no platform is connected.
// Keep the SDKs (and their HTTP stacks) out of that startup path. Node's module
// cache handles reuse; factories stay synchronous for existing callers.
export function loadTelegramSdk() {
  const sdk = require("node-telegram-bot-api");
  return sdk.default || sdk;
}

export function loadFeishuSdk(): typeof import("@larksuiteoapi/node-sdk") {
  return require("@larksuiteoapi/node-sdk");
}
