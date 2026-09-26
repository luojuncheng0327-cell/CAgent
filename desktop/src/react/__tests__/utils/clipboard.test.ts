/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from '../../utils/clipboard';

const originalPlatform = Object.getOwnPropertyDescriptor(window, 'platform');
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  Object.defineProperty(window, 'platform', { configurable: true, value: {} });
});

afterEach(() => {
  if (originalPlatform) Object.defineProperty(window, 'platform', originalPlatform);
  else Reflect.deleteProperty(window, 'platform');
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('copyTextToClipboard', () => {
  it('uses the native bridge even without a browser Clipboard API', async () => {
    const writeClipboardText = vi.fn(async () => undefined);
    Object.defineProperty(window, 'platform', { configurable: true, value: { writeClipboardText } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await copyTextToClipboard('hello');
    expect(writeClipboardText).toHaveBeenCalledWith('hello');
  });

  it('keeps the browser fallback for web clients and older desktop shells', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await copyTextToClipboard('');
    expect(writeText).toHaveBeenCalledWith('');
  });

  it('reports a native failure without silently falling back or claiming success', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: { writeClipboardText: vi.fn(async () => { throw new Error('native failure'); }) },
    });
    await expect(copyTextToClipboard('text')).rejects.toThrow('native failure');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects unavailable APIs and synchronous browser errors as promises', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await expect(copyTextToClipboard('text')).rejects.toThrow('unavailable');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => { throw new Error('browser failure'); } },
    });
    await expect(copyTextToClipboard('text')).rejects.toThrow('browser failure');
  });

  it('uses the owning editor window and rejects a detached window', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const writeClipboardText = vi.fn(async () => undefined);
    try {
      Object.defineProperty(frame.contentWindow, 'platform', { configurable: true, value: { writeClipboardText } });
      await copyTextToClipboard('selected block', frame.contentWindow);
      expect(writeClipboardText).toHaveBeenCalledWith('selected block');
      await expect(copyTextToClipboard('text', null)).rejects.toThrow('unavailable');
    } finally {
      frame.remove();
    }
  });
});
