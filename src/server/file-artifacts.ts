import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type {
  FileArtifact,
  FileArtifactPage,
  FileArtifactView,
  Message,
  Session,
  ToolCall,
} from '../shared/contracts.ts';
import type { Store } from './store.ts';
import { AppError, invariant } from './errors.ts';
import { workspacePath } from './tools.ts';
import { readWorkspaceBytes, workspaceUploadLimit } from './file-operations.ts';
import { requireDirectory } from './directories.ts';

const outputTools = new Set(['write_file', 'edit_file', 'copy_file', 'materialize_attachment']);
const outputSchema = z.object({
  path: z.string().min(1).max(4096),
  bytes: z.number().int().min(0).max(workspaceUploadLimit),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const fileArtifactPageSchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});

// Only our successful file tools supply this metadata. Do not infer artifacts from model text,
// command stdout, imported history, or incomplete tool results.
export function recordToolArtifact(
  store: Store,
  session: Session,
  call: ToolCall,
  message: Message,
  output: unknown,
) {
  if (!outputTools.has(call.name) || !output || typeof output !== 'object' || 'error' in output)
    return;
  const parsed = outputSchema.safeParse(output);
  if (!parsed.success) return;
  const target = path.resolve(session.workspace ?? '.', parsed.data.path);
  return store.put<FileArtifact>('file-artifact', message.id, {
    sessionId: session.id,
    runId: message.runId,
    messageId: message.id,
    position: message.position,
    callId: call.id,
    tool: call.name,
    workspace: session.workspace,
    path: target,
    name: path.basename(target),
    bytes: parsed.data.bytes,
    sha256: parsed.data.sha256,
  });
}

export function countFileArtifacts(store: Store, sessionId: string) {
  const row = store.db
    .prepare(
      "SELECT count(*) AS total FROM records WHERE kind='file-artifact' AND json_extract(body,'$.sessionId')=?",
    )
    .get(sessionId) as { total: number };
  return row.total;
}
function ownedArtifact(store: Store, session: Session, id: string) {
  const artifact = store.get<FileArtifact>('file-artifact', id);
  invariant(
    artifact?.sessionId === session.id,
    'FILE_ARTIFACT_MISSING',
    '此会话的文件记录不存在',
    404,
  );
  return artifact;
}

export async function readFileArtifact(
  store: Store,
  session: Session,
  id: string,
  signal?: AbortSignal,
  limit = workspaceUploadLimit,
) {
  const artifact = ownedArtifact(store, session, id);
  signal?.throwIfAborted();
  const data = await readWorkspaceBytes(store, session, artifact.path, limit);
  signal?.throwIfAborted();
  requireDirectory(store, session, artifact.path);
  invariant(
    data.sha256 === artifact.sha256 && data.bytes === artifact.bytes,
    'FILE_ARTIFACT_CHANGED',
    '文件已变化，原产物版本不可下载；可打开当前文件核对',
    409,
  );
  return { artifact, ...data };
}

function artifactState(error: any): FileArtifactView['state'] {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'WORKSPACE_MISSING')
    return 'missing';
  if (
    error.code === 'FILE_ARTIFACT_CHANGED' ||
    error.code === 'FILE_SIZE' ||
    error.code === 'FILE_TYPE' ||
    error.code === 'FILE_CONFLICT' ||
    error.code === 'FILE_TREE_LIMIT'
  )
    return 'changed';
  return 'denied';
}

export async function listFileArtifacts(
  store: Store,
  session: Session,
  input: unknown = {},
  signal?: AbortSignal,
): Promise<FileArtifactPage> {
  const { before, limit } = fileArtifactPageSchema.parse(input);
  const rows = store.db
    .prepare(
      "SELECT id FROM records WHERE kind='file-artifact' AND json_extract(body,'$.sessionId')=? AND json_extract(body,'$.position')<? ORDER BY json_extract(body,'$.position') DESC LIMIT ?",
    )
    .all(session.id, before ?? Number.MAX_SAFE_INTEGER, limit + 1) as { id: string }[];
  const items: FileArtifactView[] = [];
  let remaining = 32 * 1024 * 1024;
  const deadline = Date.now() + 5000;
  for (const row of rows.slice(0, limit)) {
    signal?.throwIfAborted();
    const artifact = ownedArtifact(store, session, row.id);
    let state: FileArtifactView['state'] = 'unchecked';
    if (Date.now() < deadline) {
      try {
        const target = await workspacePath(store, session, artifact.path);
        const stat = await fs.stat(target);
        if (!stat.isFile() || stat.size > workspaceUploadLimit) state = 'changed';
        else if (stat.size <= remaining) {
          // Use the current size, not the original artifact size, to bound changed files too.
          remaining -= Math.max(stat.size, 1);
          await readFileArtifact(store, session, artifact.id, signal, stat.size);
          state = 'ready';
        }
      } catch (error) {
        signal?.throwIfAborted();
        state = artifactState(error);
      }
    }
    items.push({ ...artifact, state });
  }
  signal?.throwIfAborted();
  return {
    items,
    total: countFileArtifacts(store, session.id),
    nextBefore: rows.length > limit ? items.at(-1)!.position : null,
  };
}

export async function locateFileArtifact(store: Store, session: Session, id: string) {
  const artifact = ownedArtifact(store, session, id);
  try {
    const target = await workspacePath(store, session, artifact.path);
    invariant((await fs.stat(target)).isFile(), 'FILE_TYPE', '文件已被替换，无法打开');
    await workspacePath(store, session, target);
    const grant = requireDirectory(store, session, target);
    return {
      path: target,
      workspace: grant.path,
      relativePath: path.relative(grant.path, target),
      messageId: artifact.messageId,
    };
  } catch (error: any) {
    if (artifactState(error) === 'missing')
      throw new AppError('FILE_ARTIFACT_MISSING', '文件已不存在，记录仍保留', 404);
    throw error;
  }
}

export function removeFileArtifact(store: Store, session: Session, id: string) {
  ownedArtifact(store, session, id);
  store.remove('file-artifact', id);
}

export function cloneFileArtifacts(
  store: Store,
  sourceSession: string,
  targetSession: string,
  messages: Map<string, Message>,
) {
  const rows = store.db
    .prepare(
      "SELECT id FROM records WHERE kind='file-artifact' AND json_extract(body,'$.sessionId')=?",
    )
    .all(sourceSession) as { id: string }[];
  for (const row of rows) {
    const artifact = store.need<FileArtifact>('file-artifact', row.id);
    const message = messages.get(artifact.messageId);
    if (message)
      store.put<FileArtifact>('file-artifact', message.id, {
        ...artifact,
        sessionId: targetSession,
        runId: null,
        messageId: message.id,
        position: message.position,
      });
  }
}
