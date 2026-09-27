"use strict";

const { Readable } = require("node:stream");

// Adapt Chromium's proxy-aware fetch to the shared OTA transport contract.
// Redirects, byte limits, hashes and signatures remain enforced by ota-core.
function createUpdateTransport(fetchImpl) {
  return async function fetchOnce(url, { headers = {}, timeoutMs = 30_000 } = {}) {
    const controller = new AbortController();
    let timer;
    let bodyStream;
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const error = new Error(`update request timed out for ${url}`);
        controller.abort(error);
        bodyStream?.destroy(error);
      }, timeoutMs);
      timer.unref?.();
    };
    const close = () => {
      clearTimeout(timer);
      controller.abort();
    };
    armTimeout();
    try {
      const response = await fetchImpl(url, {
        headers, redirect: "manual", credentials: "omit", signal: controller.signal,
      });
      bodyStream = Readable.from((async function* () {
        try {
          if (response.body) {
            for await (const chunk of Readable.fromWeb(response.body)) {
              armTimeout();
              yield chunk;
            }
          }
        } finally { close(); }
      })());
      bodyStream.once("close", close);
      return {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers),
        bodyStream,
      };
    } catch (error) {
      close();
      throw error;
    }
  };
}

const electronUpdateTransport = createUpdateTransport((...args) => require("electron").net.fetch(...args));
module.exports = { createUpdateTransport, electronUpdateTransport };
