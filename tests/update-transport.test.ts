import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createUpdateTransport } = require('../desktop/src/shared/update-transport.cjs');

async function readBody(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

afterEach(() => vi.useRealTimers());

describe('desktop update transport', () => {
  it('uses the supplied fetch, preserves redirect/status headers, and streams the body', async () => {
    const fetchImpl = vi.fn(async () => new Response('archive bytes', { status: 200, headers: { etag: 'release' } }));
    const fetchOnce = createUpdateTransport(fetchImpl);
    const result = await fetchOnce('https://example.com/archive', { headers: { 'If-None-Match': 'old' }, timeoutMs: 500 });
    expect(fetchImpl).toHaveBeenCalledWith('https://example.com/archive', expect.objectContaining({
      redirect: 'manual', credentials: 'omit', headers: { 'If-None-Match': 'old' }, signal: expect.any(AbortSignal),
    }));
    expect(result.statusCode).toBe(200);
    expect(result.headers.etag).toBe('release');
    expect(await readBody(result.bodyStream)).toBe('archive bytes');
  });

  it('aborts a connection that never sends headers', async () => {
    vi.useFakeTimers();
    const fetchOnce = createUpdateTransport((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const pending = expect(fetchOnce('https://example.com/stalled', { timeoutMs: 50 })).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(51);
    await pending;
  });

  it('times out a stalled response body instead of leaving the update hanging', async () => {
    vi.useFakeTimers();
    const fetchOnce = createUpdateTransport(async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first chunk'));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    })));
    const result = await fetchOnce('https://example.com/stalled-body', { timeoutMs: 50 });
    const pending = expect(readBody(result.bodyStream)).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(51);
    await pending;
  });
});
