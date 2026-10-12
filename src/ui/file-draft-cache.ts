import { api } from './api.ts';

export interface PersistentFileTab {
  path: string;
  text: string;
  saved: string;
  sha256: string;
  scroll: number;
  mode: 'document' | 'source' | 'preview';
  editMode?: 'document' | 'source';
  changed?: boolean;
}
interface View {
  tabs: PersistentFileTab[];
  active: string | null;
}
interface Cached {
  sessionId: string;
  workspace: string;
  revision: number;
  value: string;
  saved: string;
  timer?: ReturnType<typeof setTimeout>;
  flight?: Promise<void>;
  paused?: boolean;
  notify: (status: string, error?: unknown) => void;
}
const cache = new Map<string, Cached>();
const keyFor = (sessionId: string, workspace: string) => JSON.stringify([sessionId, workspace]);
function serialize(view: View) {
  return JSON.stringify({
    active: view.active,
    tabs: view.tabs.map((tab) => ({
      path: tab.path,
      text: tab.text,
      saved: tab.saved,
      sha256: tab.sha256,
      scroll: tab.scroll,
      mode: tab.mode,
      editMode: tab.editMode,
    })),
  });
}
export async function loadFileDraftView(sessionId: string, workspace: string) {
  const key = keyFor(sessionId, workspace);
  const old = cache.get(key);
  if (old) await drain(old);
  const view = await api<View & { revision: number; hidden: number }>(
    `/sessions/${sessionId}/file-drafts?workspace=${encodeURIComponent(workspace)}`,
  );
  const value = serialize(view);
  cache.set(key, {
    sessionId,
    workspace,
    revision: view.revision,
    value,
    saved: value,
    notify: () => {},
  });
  return view;
}
async function drain(entry: Cached): Promise<void> {
  clearTimeout(entry.timer);
  if (entry.paused) return;
  if (entry.flight) return entry.flight;
  entry.flight = (async () => {
    while (!entry.paused && entry.value !== entry.saved) {
      const value = entry.value;
      entry.notify('正在保存恢复草稿…');
      const result = await api<{ revision: number }>(
        `/sessions/${entry.sessionId}/file-drafts`,
        'PUT',
        {
          ...JSON.parse(value),
          workspace: entry.workspace,
          revision: entry.revision,
        },
      );
      entry.revision = result.revision;
      entry.saved = value;
    }
    entry.notify('恢复草稿已保存');
  })();
  try {
    await entry.flight;
  } catch (error) {
    entry.notify('恢复草稿保存失败，请保持窗口打开后重试', error);
    throw error;
  } finally {
    entry.flight = undefined;
  }
}
export function rememberFileDraftView(
  sessionId: string,
  workspace: string,
  view: View,
  notify: Cached['notify'],
) {
  const entry = cache.get(keyFor(sessionId, workspace));
  if (!entry) return;
  entry.notify = notify;
  const value = serialize(view);
  if (value === entry.value) return;
  entry.value = value;
  clearTimeout(entry.timer);
  if (value !== entry.saved && !entry.paused) {
    entry.notify('正在保存恢复草稿…');
    entry.timer = setTimeout(() => void drain(entry).catch(() => {}), 350);
  }
}
export const hasPendingFileDrafts = () =>
  [...cache.values()].some((entry) => entry.value !== entry.saved);
export async function flushFileDrafts() {
  for (const entry of cache.values()) await drain(entry);
}
export async function deleteWithFileDrafts(sessionId: string, remove: () => Promise<unknown>) {
  const entries = [...cache.values()].filter((entry) => entry.sessionId === sessionId);
  for (const entry of entries) {
    entry.paused = true;
    clearTimeout(entry.timer);
  }
  try {
    // Wait for writes already sent, without requiring abandoned drafts to save
    // into a missing or revoked workspace before the user can delete the chat.
    await Promise.allSettled(entries.map((entry) => entry.flight));
    await remove();
    forgetFileDrafts(sessionId);
  } finally {
    for (const entry of entries) {
      entry.paused = false;
      if (cache.get(keyFor(sessionId, entry.workspace)) === entry && entry.value !== entry.saved)
        entry.timer = setTimeout(() => void drain(entry).catch(() => {}), 350);
    }
  }
}
export function forgetFileDrafts(sessionId: string) {
  for (const [key, entry] of cache) {
    if (entry.sessionId !== sessionId) continue;
    clearTimeout(entry.timer);
    entry.value = entry.saved;
    entry.notify = () => {};
    cache.delete(key);
  }
}
