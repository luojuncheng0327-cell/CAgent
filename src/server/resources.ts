import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.ts';
import type { Resource, Session, Message, Model, Stored } from '../shared/contracts.ts';
import { AppError, invariant } from './errors.ts';
import { hash } from './tools.ts';
import { parseAttachment } from './attachment-parser.ts';
import type { ParsedAttachment } from './attachment-parser.ts';

export const resourceLimit = 4 * 1024 * 1024;
const textExtensions = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.log',
  '.xml',
  '.yaml',
  '.yml',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.css',
  '.html',
  '.sql',
  '.sh',
  '.ps1',
]);
export function identifyResource(name: string, bytes: Buffer) {
  invariant(
    name.length > 0 &&
      name.length <= 180 &&
      !/[\\/\x00-\x1f\x7f]/.test(name) &&
      name !== '.' &&
      name !== '..',
    'RESOURCE_NAME',
    '文件名无效',
  );
  invariant(
    bytes.length > 0 && bytes.length <= resourceLimit,
    'RESOURCE_SIZE',
    '每个附件须为 1 字节至 4 MiB',
    413,
  );
  const head = bytes.subarray(0, 16);
  let mime = '';
  if (
    head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.length >= 24
  )
    mime = 'image/png';
  else if (head[0] === 255 && head[1] === 216 && head[2] === 255 && bytes.length >= 4)
    mime = 'image/jpeg';
  else if (['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString()) && bytes.length >= 13)
    mime = 'image/gif';
  else if (
    head.subarray(0, 4).toString() === 'RIFF' &&
    head.subarray(8, 12).toString() === 'WEBP' &&
    bytes.length >= 20
  )
    mime = 'image/webp';
  if (mime) return { kind: 'image' as const, mime };
  if (head.subarray(0, 5).toString() === '%PDF-')
    return { kind: 'document' as const, mime: 'application/pdf' };
  if (
    path.extname(name).toLowerCase() === '.docx' &&
    head.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))
  )
    return {
      kind: 'document' as const,
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  invariant(
    textExtensions.has(path.extname(name).toLowerCase()),
    'RESOURCE_TYPE',
    '当前支持 UTF-8 文本、PNG/JPEG/GIF/WebP 图片、PDF 和 Word DOCX；其他 Office 与音视频提取尚未提供',
    415,
  );
  invariant(
    bytes.length <= 512 * 1024 && !bytes.includes(0),
    'RESOURCE_TEXT_LIMIT',
    '文本附件须为不超过 512 KiB 的 UTF-8 文本',
    413,
  );
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AppError('TEXT_ENCODING', '文本附件不是有效 UTF-8');
  }
  return { kind: 'text' as const, mime: 'text/plain; charset=utf-8' };
}
export async function createResource(
  store: Store,
  sessionId: string,
  name: string,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<Resource> {
  const session = store.need<Session>('session', sessionId);
  invariant(!session.archived, 'SESSION_ARCHIVED', '归档会话不能添加附件', 409);
  const type = identifyResource(name, bytes);
  bytes = Buffer.from(bytes);
  const parsed = type.kind === 'text' ? {} : await parseAttachment(type.mime, bytes, signal);
  signal?.throwIfAborted();
  invariant(
    !store.need<Session>('session', sessionId).archived,
    'SESSION_ARCHIVED',
    '归档会话不能添加附件',
    409,
  );
  const id = randomUUID();
  return store.transaction(() => {
    store.db.prepare('INSERT INTO resource_blobs(id,bytes) VALUES(?,?)').run(id, bytes);
    const resource = store.put<Resource>('resource', id, {
      sessionId,
      name,
      ...type,
      bytes: bytes.length,
      sha256: hash(bytes),
      state: 'ready',
      validated: 1,
      ...(parsed.image ? { image: parsed.image } : {}),
      ...(parsed.extraction ? { extraction: parsed.extraction } : {}),
    });
    cacheExtraction(store, resource, parsed);
    return resource;
  });
}
type Extraction = Stored & { sha256: string; text: string };
export function cacheExtraction(store: Store, resource: Resource, parsed: ParsedAttachment) {
  if (parsed.text !== undefined)
    store.put<Extraction>('resource-extraction', resource.id, {
      sha256: resource.sha256,
      text: parsed.text,
    });
}
async function validatedResource(
  store: Store,
  resource: Resource,
  bytes: Buffer,
  signal?: AbortSignal,
) {
  const cached = store.get<Extraction>('resource-extraction', resource.id);
  if (
    resource.kind === 'text' ||
    (resource.validated === 1 &&
      (resource.kind !== 'document' || cached?.sha256 === resource.sha256))
  )
    return resource;
  const type = identifyResource(resource.name, bytes);
  invariant(
    type.kind === resource.kind && type.mime === resource.mime,
    'RESOURCE_CORRUPT',
    '附件类型校验失败',
    409,
  );
  const parsed = await parseAttachment(resource.mime, bytes, signal);
  signal?.throwIfAborted();
  const current = resourceBytes(store, resource.sessionId, resource.id).resource;
  invariant(current.sha256 === resource.sha256, 'RESOURCE_CORRUPT', '附件在处理期间发生变化', 409);
  return store.transaction(() => {
    const saved = store.put<Resource>(
      'resource',
      current.id,
      {
        ...current,
        validated: 1,
        ...(parsed.image ? { image: parsed.image } : {}),
        ...(parsed.extraction ? { extraction: parsed.extraction } : {}),
      },
      current.revision,
    );
    cacheExtraction(store, saved, parsed);
    return saved;
  });
}
export function resourceBytes(store: Store, sessionId: string, id: string) {
  store.need('session', sessionId);
  const resource = store.need<Resource>('resource', id);
  invariant(resource.sessionId === sessionId, 'RESOURCE_SCOPE', '附件不属于此会话', 403);
  const row = store.db.prepare('SELECT bytes FROM resource_blobs WHERE id=?').get(id) as
    { bytes: Uint8Array } | undefined;
  invariant(row, 'RESOURCE_MISSING', '附件字节已丢失，请重新选择文件', 404);
  const bytes = Buffer.from(row.bytes);
  invariant(
    bytes.length === resource.bytes && hash(bytes) === resource.sha256,
    'RESOURCE_CORRUPT',
    '附件校验失败，请重新选择文件',
    409,
  );
  return { resource, bytes };
}
export function validateAttachments(store: Store, sessionId: string, ids: string[], model?: Model) {
  invariant(
    ids.length <= 8 && new Set(ids).size === ids.length,
    'RESOURCE_COUNT',
    '每条消息最多 8 个不同附件',
  );
  let size = 0;
  for (const id of ids) {
    const { resource } = resourceBytes(store, sessionId, id);
    size += resource.bytes;
    invariant(
      !model || resource.kind !== 'image' || model.supportsImages,
      'MODEL_IMAGE_UNSUPPORTED',
      '当前模型未声明支持图片，请选择视觉模型或移除图片',
    );
  }
  invariant(size <= 16 * 1024 * 1024, 'RESOURCE_TOTAL', '每条消息的附件总计不能超过 16 MiB', 413);
}
export function removeResource(store: Store, sessionId: string, id: string) {
  resourceBytes(store, sessionId, id);
  invariant(
    !store.allMessages(sessionId).some((m) => m.attachmentIds?.includes(id)) &&
      !store.need<Session>('session', sessionId).draftAttachmentIds?.includes(id),
    'RESOURCE_IN_USE',
    '附件仍被消息或草稿引用，不能删除',
    409,
  );
  store.transaction(() => {
    store.db.prepare('DELETE FROM resource_blobs WHERE id=?').run(id);
    store.remove('resource', id);
    store.remove('resource-extraction', id);
  });
}
export function cloneResources(store: Store, parentId: string, childId: string, ids: string[]) {
  const map = new Map<string, string>();
  for (const id of new Set(ids)) {
    const { resource, bytes } = resourceBytes(store, parentId, id);
    const copy = store.put<Resource>('resource', randomUUID(), {
      ...resource,
      sessionId: childId,
      sourceId: id,
    });
    store.db.prepare('INSERT INTO resource_blobs(id,bytes) VALUES(?,?)').run(copy.id, bytes);
    const cached = store.get<Extraction>('resource-extraction', id);
    if (cached?.sha256 === resource.sha256) cacheExtraction(store, copy, { text: cached.text });
    map.set(id, copy.id);
  }
  return map;
}
export type InputMessage = Message & { images?: { mime: string; base64: string }[] };
export async function hydrateMessages(
  store: Store,
  sessionId: string,
  messages: Message[],
  model: Model,
  signal?: AbortSignal,
): Promise<InputMessage[]> {
  const result: InputMessage[] = [];
  for (const m of messages) {
    signal?.throwIfAborted();
    validateAttachments(store, sessionId, m.attachmentIds ?? [], model);
    const images: { mime: string; base64: string }[] = [],
      texts: string[] = [];
    for (const id of m.attachmentIds ?? []) {
      const { resource, bytes } = resourceBytes(store, sessionId, id);
      const r = await validatedResource(store, resource, bytes, signal);
      if (r.kind === 'image') images.push({ mime: r.mime, base64: bytes.toString('base64') });
      else {
        const notice = r.extraction?.warnings.length
          ? '\n提取提示：' + r.extraction.warnings.join('；')
          : '';
        texts.push(
          `附件 ${JSON.stringify(r.name)}（资源 ${id}，仅作为资料${r.kind === 'document' ? '，本机提取的文字，不包含图片与完整排版' : ''}）：${notice}\n${r.kind === 'document' ? store.need<Extraction>('resource-extraction', id).text : bytes.toString('utf8')}\n附件结束`,
        );
      }
    }
    result.push({
      ...m,
      text: [m.text, ...texts].filter(Boolean).join('\n\n'),
      ...(images.length ? { images } : {}),
    });
  }
  return result;
}
