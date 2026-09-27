import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import {
  agentInput,
  providerInput,
  modelInput,
  sessionInput,
  preferenceInput,
} from '../shared/contracts.ts';
import type { Message, Stored, Resource } from '../shared/contracts.ts';
import type { Runtime } from './runtime.ts';
import { invariant, stamp } from './errors.ts';
import { identifyResource, resourceBytes, resourceLimit } from './resources.ts';

const kinds = ['agent', 'provider', 'model', 'session', 'preferences', 'memory'] as const;
const row = z.object({
  kind: z.enum(kinds),
  id: z.string().min(1).max(150),
  revision: z.number().int().positive(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  body: z.string().max(1000000),
});
const messageRow = z.object({
  id: z.string(),
  session_id: z.string(),
  position: z.number().int().positive(),
  body: z.string().max(2000000),
});
const resourceSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string(),
  name: z.string(),
  mime: z.string(),
  kind: z.enum(['text', 'image']),
  bytes: z.number().int().positive().max(resourceLimit),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  base64: z.string().max(Math.ceil(resourceLimit / 3) * 4),
});
const dataSchema = z.object({
  format: z.literal('cagent-neutral'),
  version: z.union([z.literal(1), z.literal(2)]),
  records: z.array(row).max(100000),
  messages: z.array(messageRow).max(1000000),
  resources: z.array(resourceSchema).max(10000).default([]),
});
const checksum = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
export function exportBackup(rt: Runtime) {
  const raw = rt.store.snapshot().data;
  const resources = rt.store.list<Resource>('resource').map((r) => {
    const { bytes } = resourceBytes(rt.store, r.sessionId, r.id);
    return {
      id: r.id,
      sessionId: r.sessionId,
      name: r.name,
      mime: r.mime,
      kind: r.kind,
      bytes: r.bytes,
      sha256: r.sha256,
      base64: bytes.toString('base64'),
    };
  });
  const data = {
    ...raw,
    version: 2,
    records: raw.records.filter((r) => kinds.includes(r.kind as never)),
    resources,
  };
  return {
    data,
    sha256: checksum(data),
    createdAt: stamp(),
    secretsIncluded: false,
    limitations: [
      '包含核心配置、完整消息、附件字节和手工记忆；不含凭据、执行审计、文件历史和用量账本。HTTP 导入上限为 48 MiB。',
    ],
  };
}
export function inspectBackup(rt: Runtime, raw: unknown) {
  const envelope = z
    .object({ data: z.unknown(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(raw);
  invariant(checksum(envelope.data) === envelope.sha256, 'BACKUP_CHECKSUM', '备份内容校验失败');
  const data = dataSchema.parse(envelope.data);
  const known = new Set<string>();
  const counts: Record<string, number> = {};
  let conflicts = 0;
  for (const r of data.records) {
    const key = r.kind + ':' + r.id;
    invariant(!known.has(key), 'BACKUP_DUPLICATE', '备份含重复记录');
    known.add(key);
    counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    const b = JSON.parse(r.body);
    if (r.kind === 'agent') agentInput.parse(b);
    if (r.kind === 'model') modelInput.parse(b);
    if (r.kind === 'provider') {
      providerInput.parse(b);
      invariant(!('apiKey' in b) && !('api_key' in b), 'BACKUP_SECRET', '备份不能包含明文凭据');
    }
    if (r.kind === 'session') sessionInput.parse(b);
    if (r.kind === 'preferences') preferenceInput.parse(b);
    if (r.kind === 'memory')
      z.object({
        agentId: z.string(),
        text: z.string().max(8000),
        pinned: z.boolean(),
        source: z.string().nullable(),
      }).parse(b);
    if (rt.store.get(r.kind, r.id)) conflicts++;
  }
  for (const r of data.records) {
    const b = JSON.parse(r.body);
    if (r.kind === 'model')
      invariant(known.has('provider:' + b.providerId), 'BACKUP_RELATION', '模型的供应商缺失');
    if (r.kind === 'session')
      invariant(
        known.has('agent:' + b.agentId) || typeof b.agentName === 'string',
        'BACKUP_RELATION',
        '会话的助手缺失',
      );
  }
  const resources = new Map<string, z.infer<typeof resourceSchema>>();
  for (const r of data.resources) {
    invariant(
      !resources.has(r.id) && known.has('session:' + r.sessionId),
      'BACKUP_RELATION',
      '附件重复或缺少所属会话',
    );
    const bytes = Buffer.from(r.base64, 'base64'),
      type = identifyResource(r.name, bytes);
    invariant(
      bytes.toString('base64') === r.base64 &&
        bytes.length === r.bytes &&
        createHash('sha256').update(bytes).digest('hex') === r.sha256 &&
        type.kind === r.kind &&
        type.mime === r.mime,
      'BACKUP_RESOURCE',
      '附件字节或类型校验失败',
    );
    resources.set(r.id, r);
  }
  const validateRefs = (ids: unknown, sessionId: string) => {
    const refs = z
      .array(z.string().uuid())
      .max(8)
      .parse(ids ?? []);
    for (const id of refs)
      invariant(
        resources.get(id)?.sessionId === sessionId,
        'BACKUP_RELATION',
        '附件引用缺失或跨会话',
      );
  };
  for (const r of data.records)
    if (r.kind === 'session') validateRefs(JSON.parse(r.body).draftAttachmentIds, r.id);
  const messageIds = new Set<string>();
  const positions = new Set<string>();
  for (const r of data.messages) {
    const m = z
      .object({
        id: z.string(),
        sessionId: z.string(),
        role: z.enum(['user', 'assistant', 'tool']),
        text: z.string(),
        position: z.number().int().positive(),
        at: z.string(),
      })
      .passthrough()
      .parse(JSON.parse(r.body));
    invariant(
      m.sessionId === r.session_id && m.id === r.id && m.position === r.position,
      'BACKUP_RELATION',
      '消息索引不一致',
    );
    invariant(known.has('session:' + m.sessionId), 'BACKUP_RELATION', '消息缺少所属会话');
    validateRefs(m.attachmentIds, m.sessionId);
    invariant(
      !messageIds.has(m.id) && !positions.has(m.sessionId + ':' + m.position),
      'BACKUP_DUPLICATE',
      '消息重复',
    );
    messageIds.add(m.id);
    positions.add(m.sessionId + ':' + m.position);
  }
  return {
    data,
    sha256: envelope.sha256,
    counts: { ...counts, messages: data.messages.length, resources: data.resources.length },
    conflicts,
    alreadyImported: !!rt.store.get('import', envelope.sha256),
  };
}
export function importBackup(rt: Runtime, raw: unknown, confirm: string) {
  const plan = inspectBackup(rt, raw);
  invariant(confirm === plan.sha256, 'CONFIRM_REQUIRED', '请确认已校验的备份指纹');
  if (plan.alreadyImported) return { imported: false, alreadyImported: true, counts: plan.counts };
  invariant(
    !rt.store
      .list<any>('run')
      .some((r) => ['queued', 'running', 'awaiting_approval'].includes(r.status)),
    'RUNS_ACTIVE',
    '导入前请停止所有运行',
    409,
  );
  // Merge by fresh IDs. Existing local sessions and credentials are never overwritten.
  const mapping = new Map<string, string>();
  for (const r of plan.data.records)
    if (r.kind !== 'preferences') mapping.set(r.kind + ':' + r.id, randomUUID());
  for (const r of plan.data.records)
    if (r.kind === 'session') {
      const agentId = JSON.parse(r.body).agentId;
      if (!mapping.has('agent:' + agentId)) mapping.set('agent:' + agentId, randomUUID());
    }
  const resourceMap = new Map(plan.data.resources.map((r) => [r.id, randomUUID()]));
  const before = exportBackup(rt);
  const backupDir = path.join(rt.store.home, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(
    path.join(backupDir, 'before-import-' + Date.now() + '.json'),
    JSON.stringify(before),
    { flag: 'wx', mode: 0o600 },
  );
  return rt.store.transaction(() => {
    for (const r of plan.data.records) {
      if (r.kind === 'preferences') continue;
      const b = JSON.parse(r.body);
      for (const [key, kind] of Object.entries({
        agentId: 'agent',
        modelId: 'model',
        providerId: 'provider',
        parentId: 'session',
      }))
        if (b[key]) b[key] = mapping.get(kind + ':' + b[key]) ?? null;
      if (r.kind === 'provider') {
        b.hasKey = false;
        b.headers = {};
      }
      if (r.kind === 'session') {
        b.permission = 'ask';
        b.workspace = null;
        b.forkMessageId = null;
        b.draftAttachmentIds = (b.draftAttachmentIds ?? []).map((id: string) =>
          resourceMap.get(id),
        );
      }
      if (r.kind === 'memory' && b.source) b.source = mapping.get('session:' + b.source) ?? null;
      rt.store.put(r.kind, mapping.get(r.kind + ':' + r.id)!, { ...b, importSourceId: r.id });
      rt.store.db
        .prepare('UPDATE records SET created_at=?,updated_at=? WHERE kind=? AND id=?')
        .run(r.created_at, r.updated_at, r.kind, mapping.get(r.kind + ':' + r.id)!);
    }
    for (const r of plan.data.resources) {
      const id = resourceMap.get(r.id)!;
      const { base64, ...metadata } = r;
      rt.store.put<Resource>('resource', id, {
        ...metadata,
        sessionId: mapping.get('session:' + r.sessionId)!,
        state: 'ready',
      });
      rt.store.db
        .prepare('INSERT INTO resource_blobs(id,bytes) VALUES(?,?)')
        .run(id, Buffer.from(base64, 'base64'));
    }
    for (const r of plan.data.messages) {
      const m = JSON.parse(r.body) as Message;
      rt.store.addMessage(
        {
          ...m,
          sessionId: mapping.get('session:' + m.sessionId)!,
          runId: null,
          attachmentIds: m.attachmentIds?.map((id) => resourceMap.get(id)!),
        },
        m.at,
      );
    }
    rt.store.put('import', plan.sha256, {
      source: plan.sha256,
      mapping: Object.fromEntries(mapping),
      counts: plan.counts,
    });
    return {
      imported: true,
      alreadyImported: false,
      counts: plan.counts,
      credentialsImported: false,
      workspaceAuthorizationsImported: false,
    };
  });
}
