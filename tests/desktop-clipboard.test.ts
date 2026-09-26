import { describe, expect, it, vi } from 'vitest';
import { registerClipboardIpc } from '../desktop/clipboard.cjs';

function setup() {
  const clipboard = { writeText: vi.fn() };
  const handlers = new Map();
  const preloadPath = '/app/desktop/preload.bundle.cjs';
  registerClipboardIpc({
    handle: (name, handler) => handlers.set(name, handler),
    clipboard,
    preloadPath,
  });
  const frame = {};
  const event = {
    senderFrame: frame,
    sender: { mainFrame: frame, getLastWebPreferences: () => ({ preload: preloadPath }) },
  };
  return { clipboard, event, write: handlers.get('clipboard-write-text') };
}

describe('desktop clipboard IPC', () => {
  it('writes exact Unicode text for the app renderer without focusing its document', () => {
    const { write, event, clipboard } = setup();
    write(event, '会话 ID\ncode: 😀');
    expect(clipboard.writeText).toHaveBeenCalledWith('会话 ID\ncode: 😀');
  });

  it('allows an empty string and rejects non-text payloads', () => {
    const { write, event, clipboard } = setup();
    write(event, '');
    expect(clipboard.writeText).toHaveBeenCalledWith('');
    expect(() => write(event, { text: 'unexpected object' })).toThrow('must be a string');
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
  });

  it('rejects requests from embedded frames and non-app web contents', () => {
    const { write, event, clipboard } = setup();
    expect(() => write({ ...event, senderFrame: {} }, 'iframe')).toThrow('app renderer');
    expect(() => write({ ...event, senderFrame: null }, 'detached')).toThrow('app renderer');
    expect(() => write({
      ...event,
      sender: { ...event.sender, getLastWebPreferences: () => ({}) },
    }, 'remote')).toThrow('app renderer');
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it('propagates native write errors to the UI instead of claiming success', () => {
    const { write, event, clipboard } = setup();
    clipboard.writeText.mockImplementation(() => { throw new Error('clipboard unavailable'); });
    expect(() => write(event, 'text')).toThrow('clipboard unavailable');
  });
});
