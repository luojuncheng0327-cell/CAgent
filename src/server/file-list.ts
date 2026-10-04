import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Store } from './store.ts';
import type { Session } from '../shared/contracts.ts';
import type { DirectoryEntry, DirectoryPage } from '../shared/file-list.ts';
import { directoryFor, privatePath, requireDirectory } from './directories.ts';
import { AppError, invariant } from './errors.ts';
import { hash, workspacePath } from './tools.ts';

export const directoryPageSchema = z.object({
  path: z.string().min(1).max(4096).default('.'),
  query: z.string().max(500).default(''),
  kind: z.enum(['all', 'directories']).default('all'),
  limit: z.number().int().min(1).max(500).default(200),
  cursor: z.string().min(1).max(2048).optional(),
  workspace: z.string().optional(),
});
const cursorSchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().positive(),
  })
  .strict();
const scope = (session: Session) =>
  JSON.stringify([
    session.id,
    session.workspace,
    session.directoryGrants,
    session.blockedDirectories,
  ]);
const identity = (stat: Awaited<ReturnType<typeof fs.stat>>) => [
  stat.dev,
  stat.ino,
  stat.mtimeMs,
  stat.ctimeMs,
];

export async function listWorkspaceDirectory(
  store: Store,
  session: Session,
  raw: unknown,
  signal?: AbortSignal,
): Promise<DirectoryPage> {
  try {
    return await readDirectoryPage(store, session, raw, signal);
  } catch (error) {
    if (!(error instanceof AppError)) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EACCES' || code === 'EPERM')
        throw new AppError('DIRECTORY_DENIED', '系统拒绝读取此目录，请检查目录权限', 403);
      if (code === 'ENOENT')
        throw new AppError('DIRECTORY_MISSING', '目录已不存在，请选择上一级或刷新', 404);
    }
    throw error;
  }
}

async function readDirectoryPage(
  store: Store,
  session: Session,
  raw: unknown,
  signal?: AbortSignal,
): Promise<DirectoryPage> {
  const input = directoryPageSchema.parse(raw);
  let current = store.need<Session>('session', session.id);
  invariant(
    input.workspace === undefined || input.workspace === current.workspace,
    'WORKSPACE_CHANGED',
    '当前工作台已切换，请重新浏览',
    409,
  );
  const started = performance.now();
  const initialScope = scope(current);
  const check = () => {
    signal?.throwIfAborted();
    current = store.need<Session>('session', session.id);
    invariant(
      scope(current) === initialScope,
      'DIRECTORY_CHANGED',
      '目录授权或工作台已变化，请重新浏览',
      409,
    );
    invariant(
      performance.now() - started < 5000,
      'DIRECTORY_TIMEOUT',
      '目录读取超时，请缩小目录或稍后重试',
      408,
    );
  };
  check();
  const target = await workspacePath(store, current, input.path);
  check();
  const before = await fs.stat(target);
  invariant(before.isDirectory(), 'NOT_DIRECTORY', '此路径不是目录');
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (input.cursor) {
    try {
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')),
      );
    } catch {
      throw new AppError('INVALID_DIRECTORY_CURSOR', '目录分页位置无效，请重新浏览');
    }
  }
  const entries: DirectoryEntry[] = [];
  let visited = 0,
    nameBytes = 0;
  const directory = await fs.opendir(target);
  try {
    check();
    for await (const entry of directory) {
      check();
      visited++;
      nameBytes += Buffer.byteLength(entry.name, 'utf8');
      invariant(
        visited <= 20000 && nameBytes <= 8 * 1024 * 1024,
        'DIRECTORY_LIMIT',
        '目录超过读取上限（20000 项或 8 MiB 文件名），请缩小目录',
        413,
      );
      const child = path.join(target, entry.name);
      if (privatePath(store, child) || !directoryFor(current, child)) continue;
      // Entries are data: links are visible but never navigated or included in the tree.
      const kind = entry.isSymbolicLink()
        ? 'link'
        : entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : 'other';
      entries.push({ name: entry.name, kind });
    }
  } finally {
    // Native async iteration closes automatically; an early failure before iteration does not.
    await directory.close().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  check();
  await workspacePath(store, current, target);
  const after = await fs.stat(target);
  check();
  invariant(
    JSON.stringify(identity(before)) === JSON.stringify(identity(after)),
    'DIRECTORY_CHANGED',
    '目录读取期间已变化，请刷新后重试',
    409,
  );
  requireDirectory(store, current, target);
  entries.sort(
    (a, b) =>
      Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const fingerprint = hash(
    JSON.stringify([
      store.home,
      initialScope,
      target,
      identity(after),
      input.query,
      input.kind,
      entries,
    ]),
  );
  invariant(
    !cursor || cursor.fingerprint === fingerprint,
    'DIRECTORY_CURSOR_STALE',
    '目录或筛选已变化，请从第一页重新浏览',
    409,
  );
  const query = input.query.toLowerCase();
  const filtered = entries.filter(
    (entry) =>
      (input.kind === 'all' || entry.kind === 'directory') &&
      entry.name.toLowerCase().includes(query),
  );
  const offset = cursor?.offset ?? 0;
  invariant(
    !cursor || offset < filtered.length,
    'INVALID_DIRECTORY_CURSOR',
    '目录分页位置无效，请重新浏览',
  );
  const page = filtered.slice(offset, offset + input.limit);
  check();
  for (const entry of page) requireDirectory(store, current, path.join(target, entry.name));
  const end = offset + page.length;
  const nextCursor =
    end < filtered.length
      ? Buffer.from(JSON.stringify({ fingerprint, offset: end })).toString('base64url')
      : null;
  return {
    entries: page,
    total: filtered.length,
    offset,
    nextCursor,
    truncated: nextCursor !== null,
  };
}
