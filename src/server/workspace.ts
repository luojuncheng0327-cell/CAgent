import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import type { Store } from './store.ts';
import type { Session, Stored } from '../shared/contracts.ts';
import { invariant, AppError } from './errors.ts';
import { workspacePath, writeWorkspaceFile, hash } from './tools.ts';
import { z } from 'zod';
import { requireDirectory, directoryFor } from './directories.ts';
import { changeWorkspaceItem } from './file-operations.ts';
import type { FileServices } from './file-operations.ts';

interface FileVersion extends Stored {
  sessionId: string;
  workspace: string;
  path: string;
  sha256: string;
  bytes: number;
}
export async function fileHistory(store: Store, session: Session, input: string) {
  const target = await workspacePath(store, session, input, true),
    grant = requireDirectory(store, session, target),
    relative = path.relative(grant.path, target);
  return store
    .list<FileVersion>('file-version')
    .filter((v) => v.sessionId === session.id && v.workspace === grant.path && v.path === relative);
}
export async function restoreFile(store: Store, session: Session, raw: unknown) {
  const b = z
    .object({
      path: z.string(),
      versionId: z.string().uuid(),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(raw);
  const version = (await fileHistory(store, session, b.path)).find((v) => v.id === b.versionId);
  invariant(version, 'VERSION_MISSING', '此文件在当前工作区没有该历史版本', 404);
  const bytes = await fs.readFile(path.join(store.home, 'file-history', version.id));
  invariant(hash(bytes) === version.sha256, 'VERSION_CORRUPT', '历史版本校验失败', 409);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new AppError('TEXT_ENCODING', '历史不是 UTF-8 文本');
  }
  // writeWorkspaceFile saves the current version before restoring, so restoration itself can be undone.
  return writeWorkspaceFile(store, session, b.path, text, b.expectedHash);
}
export async function manageFile(
  store: Store,
  session: Session,
  raw: unknown,
  services: FileServices = {},
) {
  const b = z
    .object({
      operation: z.enum(['create-file', 'create-directory', 'rename', 'copy', 'trash']),
      path: z.string().min(1),
      destination: z.string().min(1).optional(),
      text: z.string().max(1000000).default(''),
      expectedHash: z.string().optional(),
      confirmed: z.boolean().optional(),
      workspace: z.string().nullable().optional(),
    })
    .parse(raw);
  invariant(
    b.workspace === undefined || b.workspace === session.workspace,
    'WORKSPACE_CHANGED',
    '当前工作台已切换，请重新打开文件操作',
    409,
  );
  if (b.operation === 'rename' || b.operation === 'copy' || b.operation === 'trash')
    return changeWorkspaceItem(store, session, { ...b, operation: b.operation }, services);
  const allowed = () => {
    const latest = store.need<Session>('session', session.id);
    invariant(
      latest.permission !== 'read' && latest.workspace === session.workspace,
      'READ_ONLY',
      '工作区写入权限已撤销',
      403,
    );
  };
  allowed();
  const target = await workspacePath(store, session, b.path, true, true);
  invariant(
    target !== requireDirectory(store, session, target, true).path,
    'ROOT_OPERATION',
    '不能修改工作区根目录',
  );
  if (b.operation === 'create-file') return writeWorkspaceFile(store, session, b.path, b.text);
  if (b.operation === 'create-directory') {
    allowed();
    await fs.mkdir(target).catch((e) => {
      if (e.code === 'EEXIST') throw new AppError('FILE_EXISTS', '目标已存在，未覆盖', 409);
      throw e;
    });
    return { path: b.path };
  }
}
let watcherCount = 0;
export const activeWorkspaceWatchers = () => watcherCount;
export async function watchWorkspace(
  store: Store,
  session: Session,
  changed: (event: { kind: string; path?: string }) => void,
) {
  const root = await workspacePath(store, session, '.');
  let closed = false,
    pending: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (closed) return;
    if (
      filename
        ?.toString()
        .split(/[\\/]/)
        .some((p) => ['.cagent', '.hanako', '.git', 'node_modules'].includes(p))
    )
      return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      const current = store.get<Session>('session', session.id);
      if (!current || current.workspace !== root || !directoryFor(current, root)) {
        changed({ kind: 'reset' });
        close();
        return;
      }
      changed({ kind: 'changed' });
    }, 120);
  });
  watcherCount++;
  watcher.on('error', () => {
    changed({ kind: 'reset' });
    close();
  });
  const timer = setInterval(() => {
    const current = store.get<Session>('session', session.id);
    if (!current || current.workspace !== root || !directoryFor(current, root)) {
      changed({ kind: 'reset' });
      close();
    }
  }, 3000);
  timer.unref();
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(pending);
    clearInterval(timer);
    watcher.close();
    watcherCount--;
  }
  return close;
}
