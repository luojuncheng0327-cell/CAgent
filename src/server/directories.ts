import fs from 'node:fs/promises';
import path from 'node:path';
import { sessionDirectories } from '../shared/contracts.ts';
import type { Session, DirectoryGrant } from '../shared/contracts.ts';
import type { Store } from './store.ts';
import { invariant } from './errors.ts';

export function withinDirectory(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    !relative ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
}
export const sameDirectory = (a: string, b: string) => path.relative(a, b) === '';
export function privatePath(store: Store, target: string) {
  return (
    withinDirectory(store.home, target) ||
    target.split(/[\\/]/).some((part) => ['.hanako', '.cagent'].includes(part.toLowerCase()))
  );
}
export async function normalizeDirectories(
  store: Store,
  grants: DirectoryGrant[],
): Promise<DirectoryGrant[]> {
  const result: DirectoryGrant[] = [];
  for (const grant of grants) {
    invariant(
      !grant.path.includes('\0') && !grant.path.startsWith('\\\\') && !grant.path.startsWith('//'),
      'INVALID_PATH',
      '请选择本机文件夹',
    );
    const stat = await fs.stat(grant.path).catch(() => null);
    invariant(stat?.isDirectory(), 'WORKSPACE_MISSING', '授权的文件夹不存在');
    const canonical = await fs.realpath(grant.path);
    invariant(
      !privatePath(store, canonical),
      'PRIVATE_DATA',
      '不能把应用私有数据目录作为工作区',
      403,
    );
    invariant(
      !result.some((root) => sameDirectory(root.path, canonical)),
      'DUPLICATE_DIRECTORY',
      '同一个文件夹不能重复授权',
    );
    result.push({ path: canonical, access: grant.access });
  }
  return result;
}
export function directoryFor(session: Session, target: string): DirectoryGrant | undefined {
  const grant = sessionDirectories(session)
    .filter((grant) => withinDirectory(grant.path, target))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return grant &&
    !(session.blockedDirectories ?? []).some(
      (blocked) => blocked.length >= grant.path.length && withinDirectory(blocked, target),
    )
    ? grant
    : undefined;
}
export function directoryBlocks(previous: Session, grants: DirectoryGrant[]): string[] {
  const removed = sessionDirectories(previous)
    .filter((old) => !grants.some((next) => sameDirectory(old.path, next.path)))
    .map((old) => old.path);
  const blocked = [...new Set([...(previous.blockedDirectories ?? []), ...removed])].filter(
    (root) =>
      !grants.some((grant) => sameDirectory(grant.path, root)) &&
      grants.some((grant) => withinDirectory(grant.path, root)),
  );
  invariant(blocked.length <= 256, 'DIRECTORY_LIMIT', '子目录撤销记录过多，请整理授权目录');
  return blocked;
}
export function requireDirectory(
  store: Store,
  session: Session,
  target: string,
  write = false,
): DirectoryGrant {
  const latest = store.need<Session>('session', session.id);
  invariant(sessionDirectories(latest).length, 'NO_WORKSPACE', '此会话还没有授权工作区', 403);
  invariant(!privatePath(store, target), 'PRIVATE_DATA', '不能通过工作区工具访问应用私有数据', 403);
  const grant = directoryFor(latest, target);
  invariant(grant, 'OUTSIDE_WORKSPACE', '路径超出此会话授权的工作区', 403);
  if (write) {
    invariant(latest.permission !== 'read', 'READ_ONLY', '当前会话为只读', 403);
    invariant(grant.access === 'write', 'DIRECTORY_READ_ONLY', '此文件夹只允许读取', 403);
  }
  return grant;
}
