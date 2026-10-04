import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.ts';
import type { Session } from '../shared/contracts.ts';
import { sessionDirectories } from '../shared/contracts.ts';
import { AppError, invariant } from './errors.ts';
import { requireDirectory, sameDirectory, withinDirectory } from './directories.ts';
import { hash, workspacePath } from './tools.ts';

export const workspaceUploadLimit = 16 * 1024 * 1024;
export interface FileServices {
  trashItem?: (target: string) => Promise<void>;
}
interface NodeInfo {
  path: string;
  kind: 'file' | 'directory';
  sha256: string;
  bytes: number;
}
function selectedWorkspace(store: Store, session: Session) {
  invariant(
    store.need<Session>('session', session.id).workspace === session.workspace,
    'WORKSPACE_CHANGED',
    '当前工作台已切换，请重新打开文件操作',
    409,
  );
}

function checkNow(store: Store, session: Session, target: string, write: boolean, create = false) {
  const grant = requireDirectory(store, session, target, write);
  invariant(
    sameDirectory(fs.realpathSync(grant.path), grant.path),
    'WORKSPACE_CHANGED',
    '授权目录已被替换，请重新授权',
    403,
  );
  let cursor = grant.path;
  for (const segment of path.relative(grant.path, target).split(path.sep).filter(Boolean)) {
    invariant(!segment.includes(':') && !/[. ]$/.test(segment), 'INVALID_PATH', '路径不支持');
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error: any) {
      if (create && error.code === 'ENOENT' && sameDirectory(cursor, target)) return;
      throw error;
    }
    invariant(!stat.isSymbolicLink(), 'LINK_DENIED', '文件操作不跟随符号链接或目录联接', 403);
  }
}

function snapshot(store: Store, session: Session, target: string, write = false) {
  const nodes: NodeInfo[] = [];
  let bytes = 0;
  let fileBytes: Buffer | undefined;
  function visit(current: string, depth: number) {
    invariant(
      depth <= 32 && nodes.length < 1024,
      'FILE_TREE_LIMIT',
      '目录操作最多 1024 项、32 层',
      413,
    );
    checkNow(store, session, current, write);
    const stat = fs.lstatSync(current);
    invariant(stat.isFile() || stat.isDirectory(), 'FILE_TYPE', '仅支持普通文件和目录');
    const relative = path.relative(target, current);
    if (stat.isDirectory()) {
      nodes.push({ path: relative, kind: 'directory', sha256: '', bytes: 0 });
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), depth + 1);
    } else {
      invariant(
        stat.size <= workspaceUploadLimit && bytes + stat.size <= 32 * 1024 * 1024,
        'FILE_TREE_LIMIT',
        '单文件最多 16 MiB，目录操作总计最多 32 MiB',
        413,
      );
      const content = fs.readFileSync(current);
      const after = fs.lstatSync(current);
      invariant(
        content.length === stat.size &&
          stat.ino === after.ino &&
          stat.dev === after.dev &&
          stat.mtimeMs === after.mtimeMs &&
          stat.size === after.size,
        'FILE_CONFLICT',
        '读取期间文件发生变化，请刷新后再操作',
        409,
      );
      bytes += content.length;
      if (relative === '') fileBytes = content;
      nodes.push({ path: relative, kind: 'file', sha256: hash(content), bytes: content.length });
    }
  }
  visit(target, 0);
  const kind = nodes[0].kind;
  return {
    kind,
    bytes,
    entries: nodes.length,
    sha256: kind === 'file' ? nodes[0].sha256 : hash(JSON.stringify(nodes)),
    nodes,
    fileBytes,
  };
}
function writableItem(store: Store, session: Session, target: string) {
  requireDirectory(store, session, target, true);
  const latest = store.need<Session>('session', session.id);
  invariant(
    !sessionDirectories(latest).some((grant) => withinDirectory(target, grant.path)),
    'ROOT_OPERATION',
    '不能修改授权根目录或包含授权根的目录',
    403,
  );
}
function ensureAbsent(target: string) {
  try {
    fs.lstatSync(target);
  } catch (error: any) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new AppError('FILE_EXISTS', '目标已存在，未覆盖', 409);
}
function exclusiveBytes(store: Store, session: Session, destination: string, content: Buffer) {
  checkNow(store, session, destination, true, true);
  ensureAbsent(destination);
  const temporary = path.join(path.dirname(destination), '.cagent-transfer-' + randomUUID());
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    checkNow(store, session, destination, true, true);
    fs.linkSync(temporary, destination);
  } catch (error: any) {
    if (error.code === 'EEXIST') throw new AppError('FILE_EXISTS', '目标已存在，未覆盖', 409);
    throw error;
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export async function inspectWorkspaceItem(store: Store, session: Session, input: string) {
  selectedWorkspace(store, session);
  const target = await workspacePath(store, session, input);
  selectedWorkspace(store, session);
  const { kind, bytes, entries, sha256 } = snapshot(store, session, target);
  return { path: input, kind, bytes, entries, sha256 };
}

export async function readWorkspaceBytes(
  store: Store,
  session: Session,
  input: string,
  limit: number,
) {
  selectedWorkspace(store, session);
  const target = await workspacePath(store, session, input);
  selectedWorkspace(store, session);
  const stat = fs.lstatSync(target);
  invariant(stat.isFile(), 'FILE_TYPE', '仅支持普通文件');
  invariant(stat.size <= limit, 'FILE_SIZE', '预览文件不能超过 4 MiB', 413);
  const value = snapshot(store, session, target);
  return { content: value.fileBytes!, sha256: value.sha256, bytes: value.bytes };
}

export async function uploadWorkspaceFile(
  store: Store,
  session: Session,
  input: string,
  bytes: Buffer,
) {
  selectedWorkspace(store, session);
  invariant(bytes.length <= workspaceUploadLimit, 'FILE_SIZE', '上传文件不能超过 16 MiB', 413);
  const target = await workspacePath(store, session, input, true, true);
  selectedWorkspace(store, session);
  writableItem(store, session, target);
  exclusiveBytes(store, session, target, bytes);
  store.audit('workspace.upload', session.id, 'ok');
  return { path: input, bytes: bytes.length, sha256: hash(bytes) };
}

export async function changeWorkspaceItem(
  store: Store,
  session: Session,
  input: {
    operation: 'rename' | 'copy' | 'trash';
    path: string;
    destination?: string;
    expectedHash?: string;
    confirmed?: boolean;
  },
  services: FileServices = {},
) {
  selectedWorkspace(store, session);
  const target = await workspacePath(store, session, input.path, false, input.operation !== 'copy');
  if (input.operation !== 'copy') writableItem(store, session, target);
  let destination: string | undefined;
  if (input.operation !== 'trash') {
    invariant(input.destination, 'DESTINATION_REQUIRED', '需要目标路径');
    destination = await workspacePath(store, session, input.destination, true, true);
    invariant(
      !withinDirectory(target, destination),
      'INVALID_DESTINATION',
      '不能移动到自身或子目录',
    );
    writableItem(store, session, destination);
  } else {
    invariant(input.confirmed === true, 'CONFIRM_REQUIRED', '请确认移入系统回收站');
    invariant(services.trashItem, 'TRASH_UNAVAILABLE', '请在桌面应用中使用系统回收站', 501);
  }
  // No await between final permission/version/collision checks and the filesystem mutation.
  // This serializes app requests; it is not an OS sandbox against external path replacement.
  selectedWorkspace(store, session);
  const source = snapshot(store, session, target, input.operation !== 'copy');
  invariant(
    source.sha256 === input.expectedHash,
    'FILE_CONFLICT',
    '文件或目录内容已变化，请刷新后再操作',
    409,
  );
  if (input.operation === 'trash') {
    store.audit('workspace.trash.request', session.id, source.sha256);
    try {
      await services.trashItem!(target);
    } catch {
      store.audit('workspace.trash', session.id, 'failed');
      throw new AppError('TRASH_FAILED', '系统回收站操作失败，请检查原路径；未执行永久删除', 409);
    }
    store.audit('workspace.trash', session.id, 'ok');
    return { path: input.path, trashed: true };
  }
  checkNow(store, session, destination!, true, true);
  for (const node of source.nodes)
    requireDirectory(store, session, path.join(destination!, node.path), true);
  ensureAbsent(destination!);
  if (input.operation === 'copy') {
    invariant(
      source.kind === 'file',
      'DIRECTORY_COPY_UNSUPPORTED',
      '目录目前支持移动和回收；复制请选择文件',
    );
    exclusiveBytes(store, session, destination!, source.fileBytes!);
  } else {
    try {
      fs.renameSync(target, destination!);
    } catch (error: any) {
      if (error.code === 'EXDEV')
        throw new AppError('CROSS_VOLUME_MOVE', '跨磁盘移动尚未提供，原文件已保留', 409);
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code))
        throw new AppError('FILE_EXISTS', '目标已存在，未覆盖', 409);
      throw error;
    }
  }
  store.audit('workspace.' + input.operation, session.id, 'ok');
  return { path: input.destination, bytes: source.bytes, sha256: source.sha256 };
}
