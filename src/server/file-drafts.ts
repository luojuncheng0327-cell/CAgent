import path from 'node:path';
import { z } from 'zod';
import type { Session, Stored } from '../shared/contracts.ts';
import type { Store } from './store.ts';
import { invariant } from './errors.ts';
import { hash, workspacePath, readWorkspaceFile } from './tools.ts';
import { requireDirectory, sameDirectory, withinDirectory } from './directories.ts';

const mode = z.enum(['document', 'source', 'preview']);
const tabSchema = z.object({
  path: z.string().min(1).max(4096),
  text: z.string(),
  saved: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  scroll: z.number().finite().min(0).max(100000000),
  mode,
  editMode: z.enum(['document', 'source']).optional(),
});
const draftSchema = z.object({
  workspace: z.string().min(1).max(4096),
  revision: z.number().int().min(0),
  tabs: z.array(tabSchema).max(10),
  active: z.string().nullable(),
});
type DraftTab = z.infer<typeof tabSchema>;
interface DraftRecord extends Stored {
  sessionId: string;
  workspace: string;
  tabs: DraftTab[];
  active: string | null;
}
async function rootFor(store: Store, session: Session, input: string) {
  invariant(path.isAbsolute(input), 'INVALID_PATH', '草稿必须指定工作区');
  const root = await workspacePath(store, session, input);
  const grant = requireDirectory(store, session, root);
  invariant(sameDirectory(root, grant.path), 'OUTSIDE_WORKSPACE', '草稿工作区未授权', 403);
  return root;
}
function targetFor(root: string, input: string) {
  const target = path.resolve(root, input);
  invariant(
    withinDirectory(root, target) && !sameDirectory(root, target),
    'OUTSIDE_WORKSPACE',
    '草稿路径超出工作区',
    403,
  );
  return target;
}
const keyFor = (sessionId: string, root: string) => hash(JSON.stringify([sessionId, root]));

export async function saveFileDrafts(store: Store, session: Session, raw: unknown) {
  const input = draftSchema.parse(raw);
  const root = await rootFor(store, session, input.workspace);
  let size = 0;
  const targets: string[] = [];
  for (const tab of input.tabs) {
    const bytes = Buffer.byteLength(tab.text) + Buffer.byteLength(tab.saved);
    invariant(
      Buffer.byteLength(tab.text) <= 2 * 1024 * 1024 &&
        Buffer.byteLength(tab.saved) <= 2 * 1024 * 1024,
      'DRAFT_SIZE',
      '每个文件草稿和原文各不能超过 2 MiB',
      413,
    );
    size += bytes;
    invariant(size <= 8 * 1024 * 1024, 'DRAFT_SIZE', '每个工作区的草稿合计不能超过 8 MiB', 413);
    invariant(hash(tab.saved) === tab.sha256, 'DRAFT_BASELINE', '草稿原文与版本校验不一致');
    const target = targetFor(root, tab.path);
    await workspacePath(store, session, target, true);
    invariant(
      !targets.some((existing) => sameDirectory(existing, target)),
      'DRAFT_DUPLICATE',
      '同一文件不能重复保存草稿',
    );
    targets.push(target);
  }
  invariant(
    input.active === null || input.tabs.some((tab) => tab.path === input.active),
    'DRAFT_ACTIVE',
    '当前标签不在草稿列表中',
  );
  // Authorization and the version are checked again after all asynchronous file checks.
  requireDirectory(store, session, root);
  targets.forEach((target) => requireDirectory(store, session, target));
  const key = keyFor(session.id, root);
  const previous = store.get<DraftRecord>('file-drafts', key);
  invariant(
    (previous?.revision ?? 0) === input.revision,
    'VERSION_CONFLICT',
    '文件草稿已被其他窗口更新，请重新打开工作区',
    409,
  );
  const saved = store.put<DraftRecord>(
    'file-drafts',
    key,
    {
      sessionId: session.id,
      workspace: root,
      tabs: input.tabs,
      active: input.active,
    },
    previous?.revision,
  );
  return { revision: saved.revision };
}

export async function loadFileDrafts(store: Store, session: Session, workspace: string) {
  const root = await rootFor(store, session, workspace);
  const saved = store.get<DraftRecord>('file-drafts', keyFor(session.id, root));
  const tabs: (DraftTab & { changed: boolean })[] = [];
  for (const tab of saved?.tabs ?? []) {
    const target = targetFor(root, tab.path);
    // Revoked or replaced paths must not expose their stored contents.
    try {
      await workspacePath(store, session, target, true);
    } catch {
      continue;
    }
    const disk = await readWorkspaceFile(store, session, target).catch(() => null);
    try {
      requireDirectory(store, session, target);
    } catch {
      continue;
    }
    tabs.push({ ...tab, changed: !disk || disk.sha256 !== tab.sha256 });
  }
  requireDirectory(store, session, root);
  return {
    workspace: root,
    revision: saved?.revision ?? 0,
    tabs,
    active: tabs.some((tab) => tab.path === saved?.active)
      ? saved!.active
      : (tabs.at(-1)?.path ?? null),
    hidden: (saved?.tabs.length ?? 0) - tabs.length,
  };
}
