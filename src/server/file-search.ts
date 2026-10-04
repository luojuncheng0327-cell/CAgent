import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Store } from './store.ts';
import type { Session } from '../shared/contracts.ts';
import { AppError, invariant } from './errors.ts';
import { workspacePath } from './tools.ts';

export const fileSearchSchema = z.object({
  path: z.string().min(1).max(4096).default('.'),
  mode: z.enum(['filename', 'content']).default('content'),
  query: z.string().min(1).max(500).optional(),
  glob: z.string().min(1).max(500).default('**/*'),
  caseSensitive: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(100),
  workspace: z.string().nullable().optional(),
});

export interface FileSearchResult {
  root: string;
  matches: { path: string; line?: number; text?: string }[];
  visited: number;
  readBytes: number;
  truncated: boolean;
  reasons: string[];
  skipped: { denied: number; unreadable: number; large: number; binary: number; encoding: number };
}

// These limits apply to all callers, including a model repeatedly asking for more results.
const budgets = { entries: 1000, depth: 16, bytes: 8 * 1024 * 1024, file: 512 * 1024, ms: 5000 };
const ignored = new Set(['.git', 'node_modules', '.cagent', '.hanako']);
const authorization = (s: Session) =>
  JSON.stringify([s.workspace, s.directoryGrants, s.blockedDirectories]);

export async function searchWorkspaceFiles(
  store: Store,
  session: Session,
  raw: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<FileSearchResult> {
  const input = fileSearchSchema.parse(raw);
  const current = store.need<Session>('session', session.id);
  const scope = authorization(current);
  invariant(
    input.workspace === undefined || input.workspace === current.workspace,
    'WORKSPACE_CHANGED',
    '当前工作台已切换，请重新搜索',
    409,
  );
  invariant(input.mode === 'filename' || input.query, 'SEARCH_QUERY', '请输入要搜索的正文');
  const pattern = input.glob.replace(/\\/g, '/');
  invariant(
    !pattern.startsWith('/') &&
      !pattern.includes(':') &&
      !pattern.includes('\0') &&
      !pattern.split('/').includes('..'),
    'INVALID_GLOB',
    '通配符必须相对于搜索目录，不能包含上级路径',
  );
  const root = await workspacePath(store, current, input.path);
  invariant((await fs.stat(root)).isDirectory(), 'SEARCH_DIRECTORY', '请选择要搜索的文件夹');
  const result: FileSearchResult = {
    root,
    matches: [],
    visited: 0,
    readBytes: 0,
    truncated: false,
    reasons: [],
    skipped: { denied: 0, unreadable: 0, large: 0, binary: 0, encoding: 0 },
  };
  const deadline = performance.now() + budgets.ms;
  let stopped = false;
  const incomplete = (reason: string) => {
    result.truncated = true;
    if (!result.reasons.includes(reason)) result.reasons.push(reason);
  };
  function check() {
    signal.throwIfAborted();
    invariant(
      authorization(store.need<Session>('session', session.id)) === scope,
      'SEARCH_CHANGED',
      '搜索期间工作区授权发生变化，请重新搜索',
      409,
    );
    if (performance.now() > deadline) {
      incomplete('time-limit');
      stopped = true;
    }
    return !stopped;
  }
  async function allowed(target: string) {
    check();
    try {
      await workspacePath(store, current, target);
      check();
      return !stopped;
    } catch (error) {
      check();
      if (
        error instanceof AppError &&
        ['PRIVATE_DATA', 'OUTSIDE_WORKSPACE', 'LINK_DENIED'].includes(error.code)
      ) {
        result.skipped.denied++;
        incomplete('access-denied');
        return false;
      }
      if (
        ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      ) {
        result.skipped.unreadable++;
        incomplete('unreadable');
        return false;
      }
      throw error;
    }
  }
  function add(match: FileSearchResult['matches'][number]) {
    if (result.matches.length === input.limit) {
      incomplete('result-limit');
      stopped = true;
      return;
    }
    result.matches.push(match);
  }
  const needle = input.caseSensitive ? input.query : input.query?.toLowerCase();
  async function content(target: string, relative: string) {
    const handle = await fs.open(target, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return;
      if (stat.size > budgets.file) {
        result.skipped.large++;
        incomplete('large-file');
        return;
      }
      if (result.readBytes + stat.size > budgets.bytes) {
        incomplete('byte-limit');
        stopped = true;
        return;
      }
      const buffer = Buffer.alloc(Math.min(budgets.file, budgets.bytes - result.readBytes) + 1);
      let size = 0;
      while (check() && size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (!check() || !(await allowed(target))) return;
      if (size > budgets.file || result.readBytes + size > budgets.bytes) {
        incomplete(size > budgets.file ? 'large-file' : 'byte-limit');
        if (size > budgets.file) result.skipped.large++;
        else stopped = true;
        return;
      }
      result.readBytes += size;
      const bytes = buffer.subarray(0, size);
      if (bytes.includes(0)) {
        result.skipped.binary++;
        incomplete('binary-file');
        return;
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        result.skipped.encoding++;
        incomplete('text-encoding');
        return;
      }
      const lines = text.split(/\r\n|\r|\n/);
      for (let i = 0; i < lines.length && check(); i++) {
        const line = lines[i];
        const at = (input.caseSensitive ? line : line.toLowerCase()).indexOf(needle!);
        if (at < 0) continue;
        const start = Math.max(0, at - 120);
        add({ path: relative, line: i + 1, text: line.slice(start, start + 500) });
      }
    } finally {
      await handle.close();
    }
  }
  async function scan(directory: string, depth: number) {
    if (!check() || !(await allowed(directory))) return;
    try {
      const entries = await fs.opendir(directory);
      for await (const entry of entries) {
        if (!check()) break;
        if (result.visited >= budgets.entries) {
          incomplete('scan-limit');
          stopped = true;
          break;
        }
        result.visited++;
        if (entry.isSymbolicLink() || ignored.has(entry.name.toLowerCase())) continue;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (depth >= budgets.depth) incomplete('depth-limit');
          else await scan(target, depth + 1);
        } else if (entry.isFile() && (await allowed(target))) {
          const relative = path.relative(root, target).split(path.sep).join('/');
          if (!path.posix.matchesGlob(relative, pattern)) continue;
          if (input.mode === 'filename') {
            if (
              !needle ||
              (input.caseSensitive ? relative : relative.toLowerCase()).includes(needle)
            )
              add({ path: relative });
          } else {
            try {
              await content(target, relative);
            } catch (error) {
              check();
              if (
                !['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(
                  (error as NodeJS.ErrnoException).code ?? '',
                )
              )
                throw error;
              result.skipped.unreadable++;
              incomplete('unreadable');
            }
          }
        }
      }
    } catch (error) {
      check();
      if (
        !['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
      result.skipped.unreadable++;
      incomplete('unreadable');
    }
  }
  await scan(root, 0);
  check();
  return result;
}
