import path from 'node:path';
import type { Store } from './store.ts';
import type { Session, WorkspacePreview } from '../shared/contracts.ts';
import { readWorkspaceBytes } from './file-operations.ts';
import { identifyResource, resourceLimit } from './resources.ts';
import { parseAttachment } from './attachment-parser.ts';
import { invariant } from './errors.ts';

export async function previewWorkspaceFile(
  store: Store,
  session: Session,
  input: string,
  signal?: AbortSignal,
): Promise<WorkspacePreview> {
  signal?.throwIfAborted();
  const file = await readWorkspaceBytes(store, session, input, resourceLimit);
  invariant(
    /\.(png|jpe?g|gif|webp|pdf|docx)$/i.test(input),
    'PREVIEW_TYPE',
    '当前预览支持 PNG/JPEG/GIF/WebP 图片和 PDF/DOCX 文字',
    415,
  );
  const type = identifyResource(path.basename(input), file.content);
  invariant(
    type.kind !== 'text',
    'PREVIEW_TYPE',
    '当前预览支持 PNG/JPEG/GIF/WebP 图片和 PDF/DOCX 文字',
    415,
  );
  const parsed = await parseAttachment(type.mime, file.content, signal);
  signal?.throwIfAborted();
  // Recheck authorization, selected workspace and bytes after parsing in another worker.
  const current = await readWorkspaceBytes(store, session, input, resourceLimit);
  signal?.throwIfAborted();
  invariant(current.sha256 === file.sha256, 'FILE_CONFLICT', '预览期间文件已变化，请重新读取', 409);
  const common = { path: input, mime: type.mime, sha256: file.sha256, bytes: file.bytes };
  if (type.kind === 'image')
    return {
      ...common,
      kind: 'image',
      image: parsed.image!,
      imageUrl: `data:${type.mime};base64,${file.content.toString('base64')}`,
    };
  return { ...common, kind: 'document', text: parsed.text!, extraction: parsed.extraction! };
}
