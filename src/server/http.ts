import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { z } from 'zod';
import packageInfo from '../../package.json' with { type: 'json' };
import type { Runtime } from './runtime.ts';
import { completeSetup, prepareSetupWorkspace } from './setup.ts';
import { saveProfile } from './profiles.ts';
import { fileSearchSchema, searchWorkspaceFiles } from './file-search.ts';
import { directoryPageSchema, listWorkspaceDirectory } from './file-list.ts';
import type {
  Session,
  Run,
  RunEvent,
  Memory,
  Model,
  Agent,
  Provider,
} from '../shared/contracts.ts';
import { publicError, AppError, invariant } from './errors.ts';
import { readWorkspaceFile, writeWorkspaceFile, workspacePath } from './tools.ts';
import { exportBackup, inspectBackup, importBackup } from './backup.ts';
import { discoverModels, discoverModelLimits } from './discovery.ts';
import { createResource, resourceBytes, removeResource, resourceLimit } from './resources.ts';
import { fileHistory, restoreFile, manageFile, watchWorkspace } from './workspace.ts';
import { usageReport } from './usage.ts';
import { searchSessions, orderedSessions, saveSessionOrder } from './session-navigation.ts';
import { loadFileDrafts, saveFileDrafts } from './file-drafts.ts';
import { materializeAttachment } from './file-transfer.ts';
import { previewWorkspaceFile } from './file-preview.ts';
import {
  listFileArtifacts,
  readFileArtifact,
  locateFileArtifact,
  removeFileArtifact,
} from './file-artifacts.ts';
import {
  inspectWorkspaceItem,
  uploadWorkspaceFile,
  workspaceUploadLimit,
} from './file-operations.ts';

interface ServerOptions {
  port?: number;
  token?: string;
  uiDir?: string;
  trashItem?: (target: string) => Promise<void>;
  internalRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
}
const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export async function serve(rt: Runtime, options: ServerOptions = {}) {
  const token = options.token ?? randomBytes(32).toString('base64url');
  const cookies = new Set<string>();
  let origin = '';
  const json = (res: http.ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
  };
  async function bytes(req: http.IncomingMessage, limit: number) {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      invariant(size <= limit, 'BODY_TOO_LARGE', '请求超过大小上限', 413);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function body(req: http.IncomingMessage) {
    invariant(
      req.headers['content-type']?.startsWith('application/json'),
      'CONTENT_TYPE',
      '仅接受 JSON 请求',
      415,
    );
    const raw = await bytes(req, 48 * 1024 * 1024);
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AppError('INVALID_JSON', '请求不是有效 JSON');
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const url = new URL(req.url ?? '/', origin);
      const route = url.pathname;
      const method = req.method ?? 'GET';
      invariant(req.headers.host === new URL(origin).host, 'INVALID_HOST', '访问来源不匹配', 403);
      if (req.headers.origin)
        invariant(req.headers.origin === origin, 'INVALID_ORIGIN', '跨来源请求已拒绝', 403);
      if (route.startsWith('/internal/')) {
        invariant(options.internalRequest, 'NOT_FOUND', '此接口不存在', 404);
        await options.internalRequest(req, res);
        return;
      }
      if (route === '/api/v1/auth' && method === 'POST') {
        const input = z.object({ token: z.string().max(256) }).parse(await body(req));
        invariant(equal(input.token, token), 'UNAUTHORIZED', '连接凭据无效', 401);
        const session = randomBytes(32).toString('base64url');
        cookies.add(session);
        if (cookies.size > 32) cookies.delete(cookies.values().next().value!);
        res.setHeader('Set-Cookie', `cagent_session=${session}; Path=/; HttpOnly; SameSite=Strict`);
        json(res, { data: { authenticated: true } });
        return;
      }
      if (!route.startsWith('/api/')) {
        invariant(method === 'GET', 'METHOD_NOT_ALLOWED', '请求方法不支持', 405);
        if (!options.uiDir) {
          json(res, { data: { name: 'CAgent', state: 'server-ready', ui: '请先运行构建命令' } });
          return;
        }
        const relative = route === '/' ? 'index.html' : decodeURIComponent(route.slice(1));
        invariant(
          !relative.includes('..') && !relative.includes('\\') && !relative.includes('\0'),
          'INVALID_PATH',
          '路径无效',
          403,
        );
        const file = path.resolve(options.uiDir, relative);
        invariant(
          file.startsWith(path.resolve(options.uiDir) + path.sep),
          'INVALID_PATH',
          '路径无效',
          403,
        );
        const bytes = await fs.readFile(file).catch(() => {
          throw new AppError('NOT_FOUND', '文件不存在', 404);
        });
        const types: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.woff2': 'font/woff2',
        };
        res.writeHead(200, {
          'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(bytes);
        return;
      }
      const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const cookie = (req.headers.cookie ?? '')
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('cagent_session='))
        ?.split('=')[1];
      const byBearer = !!bearer && equal(bearer, token);
      invariant(
        byBearer || (cookie && cookies.has(cookie)),
        'UNAUTHORIZED',
        '请连接此 CAgent 实例',
        401,
      );
      if (!['GET', 'HEAD'].includes(method) && !byBearer)
        invariant(req.headers.origin === origin, 'INVALID_ORIGIN', '修改请求必须来自本应用', 403);
      if (route === '/api/v1/logout' && method === 'POST') {
        if (cookie) cookies.delete(cookie);
        res.setHeader(
          'Set-Cookie',
          'cagent_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
        );
        json(res, { data: { authenticated: false } });
        return;
      }
      if (route === '/api/v1/health' && method === 'GET') {
        json(res, {
          data: {
            name: 'CAgent',
            version: packageInfo.version,
            runtime: 'independent',
            platform: process.platform,
            keystore: rt.vault.available,
            osSandbox: false,
          },
        });
        return;
      }
      if (route === '/api/v1/bootstrap' && method === 'GET') {
        json(res, {
          data: {
            preferences: rt.preferences(),
            suggestedWorkspace: rt.suggestedWorkspace,
            agents: rt.store.list('agent'),
            providers: rt.store.list('provider'),
            models: rt.store.list('model'),
            sessions: rt.store.list('session'),
            sessionOrder: rt.sessionOrder(),
            runs: rt.store
              .list<Run>('run')
              .filter(
                (r) => !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(r.status),
              ),
            capabilities: {
              chat: true,
              workspace: true,
              attachments: true,
              manualMemory: true,
              knowledge: rt.knowledgeAvailable,
              backup: true,
              oauth: false,
              mcp: false,
              plugins: false,
              bridge: false,
              osSandbox: false,
            },
          },
        });
        return;
      }
      if (route === '/api/v1/preferences' && method === 'PUT') {
        json(res, { data: rt.savePreferences(await body(req)) });
        return;
      }
      const profile = route.match(/^\/api\/v1\/profiles\/(user|agents\/([^/]+))$/);
      if (profile && method === 'PUT') {
        json(res, {
          data: await saveProfile(
            rt,
            profile[2] ? decodeURIComponent(profile[2]) : null,
            await body(req),
          ),
        });
        return;
      }
      if (route === '/api/v1/setup/workspace' && method === 'POST') {
        json(res, { data: await prepareSetupWorkspace(rt, await body(req)) });
        return;
      }
      if (route === '/api/v1/setup/complete' && method === 'POST') {
        json(res, { data: await completeSetup(rt, await body(req)) });
        return;
      }
      for (const [kind, save] of [
        ['providers', (b: unknown, id?: string) => rt.saveProvider(b, id)],
        ['models', (b: unknown, id?: string) => rt.saveModel(b, id)],
        ['agents', (b: unknown, id?: string) => rt.saveAgent(b, id)],
      ] as const) {
        if (route === `/api/v1/${kind}` && method === 'POST') {
          json(res, { data: save(await body(req)) }, 201);
          return;
        }
        const match = route.match(new RegExp(`^/api/v1/${kind}/([^/]+)$`));
        if (match && method === 'PUT') {
          json(res, { data: save(await body(req), decodeURIComponent(match[1])) });
          return;
        }
        if (match && method === 'DELETE') {
          const id = decodeURIComponent(match[1]);
          if (kind === 'agents') rt.deleteAgent(id);
          else if (kind === 'models') {
            invariant(
              !rt.store.list<Session>('session').some((s) => s.modelId === id) &&
                !rt.store.list<Agent>('agent').some((a) => a.modelId === id) &&
                ![rt.preferences().smallToolModelId, rt.preferences().largeToolModelId].includes(
                  id,
                ),
              'MODEL_IN_USE',
              '模型仍被会话或助手使用',
              409,
            );
            rt.store.remove('model', id);
          } else rt.deleteProvider(id);
          json(res, { data: { deleted: true } });
          return;
        }
      }
      let match = route.match(/^\/api\/v1\/providers\/([^/]+)\/model-limits$/);
      if (match && method === 'POST') {
        const input = z.object({ model: z.string().trim().min(1).max(120) }).parse(await body(req));
        const p = rt.store.need<Provider>('provider', match[1]);
        json(res, {
          data: await discoverModelLimits(
            p,
            rt.vault.get(p.id),
            JSON.parse(rt.vault.get(p.id + ':headers') ?? '{}'),
            input.model,
            rt.fetcher,
          ),
        });
        return;
      }
      match = route.match(/^\/api\/v1\/providers\/([^/]+)\/discover$/);
      if (match && method === 'POST') {
        const p = rt.store.need<Provider>('provider', match[1]);
        json(res, {
          data: await discoverModels(
            p,
            rt.vault.get(p.id),
            JSON.parse(rt.vault.get(p.id + ':headers') ?? '{}'),
            rt.fetcher,
          ),
        });
        return;
      }
      match = route.match(/^\/api\/v1\/models\/([^/]+)\/test$/);
      if (match && method === 'POST') {
        json(res, { data: await rt.testModel(match[1]) });
        return;
      }
      if (route === '/api/v1/sessions/search' && method === 'GET') {
        json(res, { data: searchSessions(rt.store, Object.fromEntries(url.searchParams)) });
        return;
      }
      if (route === '/api/v1/sessions/order' && ['GET', 'PUT'].includes(method)) {
        json(res, {
          data: method === 'GET' ? rt.sessionOrder() : saveSessionOrder(rt.store, await body(req)),
        });
        return;
      }
      if (route === '/api/v1/sessions' && method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').toLowerCase(),
          archived = url.searchParams.get('archived') === 'true';
        const sessions = orderedSessions(
          rt.store,
          rt.preferences().sessionSort === 'manual',
        ).filter(
          (s) =>
            s.archived === archived &&
            (!q ||
              s.title.toLowerCase().includes(q) ||
              !!rt.store.db
                .prepare(
                  "SELECT 1 FROM messages WHERE session_id=? AND instr(lower(json_extract(body,'$.text')),?)>0 LIMIT 1",
                )
                .get(s.id, q)),
        );
        json(res, { data: sessions });
        return;
      }
      if (route === '/api/v1/sessions' && method === 'POST') {
        json(res, { data: await rt.createSession(await body(req)) }, 201);
        return;
      }
      match = route.match(/^\/api\/v1\/sessions\/([^/]+)(?:\/(.+))?$/);
      if (match) {
        const id = match[1],
          action = match[2];
        const session = rt.store.need<Session>('session', id);
        if (!action && method === 'GET') {
          json(res, { data: rt.snapshot(id) });
          return;
        }
        if (!action && method === 'PATCH') {
          json(res, { data: await rt.updateSession(id, await body(req)) });
          return;
        }
        if (!action && method === 'DELETE') {
          rt.deleteSession(id);
          json(res, { data: { deleted: true } });
          return;
        }
        if (action === 'runs' && method === 'POST') {
          json(res, { data: await rt.start(id, await body(req)) }, 202);
          return;
        }
        if (action === 'context-usage' && method === 'POST') {
          const input = z
            .object({
              text: z.string().max(200000).default(''),
              attachmentIds: z.array(z.string().uuid()).max(8).default([]),
            })
            .parse(await body(req));
          json(res, { data: await rt.contextUsage(id, input.text, input.attachmentIds) });
          return;
        }
        if (action === 'revisions' && method === 'POST') {
          json(res, { data: await rt.reviseSession(id, await body(req)) }, 201);
          return;
        }
        if (action === 'compact' && method === 'POST') {
          const b = z.object({ requestId: z.string().uuid() }).parse(await body(req));
          json(res, { data: await rt.start(id, b, { purpose: 'compact' }) }, 202);
          return;
        }
        if (action === 'messages' && method === 'GET') {
          const q = z
            .object({
              before: z.coerce.number().int().positive().optional(),
              limit: z.coerce.number().int().min(1).max(200).default(80),
              around: z.string().min(1).max(150).optional(),
            })
            .parse(Object.fromEntries(url.searchParams));
          invariant(
            !q.around || q.before === undefined,
            'INVALID_PAGE',
            '定位与向前分页不能同时使用',
          );
          json(res, {
            data: q.around
              ? rt.store.messageWindow(id, q.around, q.limit)
              : rt.store.messagePage(id, q.before, q.limit),
          });
          return;
        }
        if (action === 'resources' && method === 'POST') {
          const name = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
          const data = await bytes(req, resourceLimit);
          const abort = new AbortController();
          const disconnected = () => {
            if (!res.writableEnded) abort.abort();
          };
          res.once('close', disconnected);
          try {
            json(res, { data: await createResource(rt.store, id, name, data, abort.signal) }, 201);
          } finally {
            res.off('close', disconnected);
          }
          return;
        }
        if (action === 'file-artifacts' && method === 'GET') {
          const abort = new AbortController();
          const disconnected = () => {
            if (!res.writableEnded) abort.abort();
          };
          res.once('close', disconnected);
          try {
            json(res, {
              data: await listFileArtifacts(
                rt.store,
                session,
                Object.fromEntries(url.searchParams),
                abort.signal,
              ),
            });
          } finally {
            res.off('close', disconnected);
          }
          return;
        }
        const artifact = action?.match(/^file-artifacts\/([^/]+)(?:\/(body|locate))?$/);
        if (artifact) {
          if (method === 'DELETE' && !artifact[2]) {
            removeFileArtifact(rt.store, session, artifact[1]);
            json(res, { data: { removed: true } });
            return;
          }
          if (method === 'GET' && artifact[2] === 'locate') {
            json(res, { data: await locateFileArtifact(rt.store, session, artifact[1]) });
            return;
          }
          if (method === 'GET' && artifact[2] === 'body') {
            const data = await readFileArtifact(rt.store, session, artifact[1]).catch((error) => {
              if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
                throw new AppError('FILE_ARTIFACT_MISSING', '文件已不存在，记录仍保留', 404);
              throw error;
            });
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Length': data.bytes,
              'Content-Disposition':
                'attachment; filename="file"; filename*=UTF-8\'\'' +
                encodeURIComponent(data.artifact.name).replace(/'/g, '%27'),
              'Cache-Control': 'no-store',
            });
            res.end(data.content);
            return;
          }
        }
        if (action === 'materialize-attachment' && method === 'POST') {
          const b = z
            .object({
              attachmentId: z.string().min(1).max(128),
              path: z.string().min(1).max(4096),
              workspace: z.string().min(1).max(4096),
            })
            .parse(await body(req));
          invariant(
            session.workspace === b.workspace,
            'WORKSPACE_CHANGED',
            '当前工作台已切换，请重新打开文件操作',
            409,
          );
          json(res, {
            data: await materializeAttachment(rt.store, session, b.attachmentId, b.path),
          });
          return;
        }
        const resource = action?.match(/^resources\/([^/]+)(\/body)?$/);
        if (resource) {
          if (method === 'DELETE' && !resource[2]) {
            removeResource(rt.store, id, resource[1]);
            json(res, { data: { deleted: true } });
            return;
          }
          if (method === 'GET') {
            const data = resourceBytes(rt.store, id, resource[1]);
            if (!resource[2]) json(res, { data: data.resource });
            else {
              res.writeHead(200, {
                'Content-Type': data.resource.mime,
                'Content-Length': data.bytes.length,
                'Content-Disposition': `${url.searchParams.get('inline') === 'true' && data.resource.kind === 'image' ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(data.resource.name).replace(/'/g, '%27')}`,
                'Cache-Control': 'no-store',
              });
              res.end(data.bytes);
            }
            return;
          }
        }
        if (action === 'fork' && method === 'POST') {
          const b = z.object({ messageId: z.string() }).parse(await body(req));
          json(res, { data: await rt.forkSession(id, b.messageId) }, 201);
          return;
        }
        if (action === 'cancel' && method === 'POST') {
          const b = z.object({ runId: z.string() }).parse(await body(req));
          json(res, { data: await rt.cancel(id, b.runId) });
          return;
        }
        if (action === 'export' && method === 'GET') {
          const messages = rt.store.allMessages(id);
          json(res, {
            data: {
              session,
              messages,
              resources: rt.snapshot(id).resources,
              markdown: messages
                .map(
                  (m) =>
                    `## ${m.role} · ${m.at}\n\n${m.text}${m.reasoning ? '\n\n思考：\n' + m.reasoning : ''}${m.calls?.length ? '\n\n工具调用：\n```json\n' + JSON.stringify(m.calls, null, 2) + '\n```' : ''}${m.callId ? '\n\n工具调用 ID：' + m.callId : ''}${m.attachmentIds?.length ? '\n\n附件资源：' + m.attachmentIds.join(', ') : ''}`,
                )
                .join('\n\n'),
            },
          });
          return;
        }
        if (action === 'workspace-events' && method === 'GET') {
          let closeWatcher: () => void = () => {};
          req.on('close', () => closeWatcher());
          closeWatcher = await watchWorkspace(rt.store, session, (event) => {
            if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
          });
          if (req.destroyed) {
            closeWatcher();
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.flushHeaders();
          res.write('data: {"kind":"ready"}\n\n');
          const ping = setInterval(() => res.write(': keepalive\n\n'), 15000);
          ping.unref();
          req.on('close', () => clearInterval(ping));
          return;
        }
        if (action === 'events' && method === 'GET') {
          const after = z.coerce
            .number()
            .int()
            .min(0)
            .parse(url.searchParams.get('after') ?? '0');
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          });
          res.flushHeaders();
          let last = after;
          const send = (event: RunEvent) => {
            if (event.sessionId !== id || event.id <= last) return;
            if (res.writableLength > 1024 * 1024) {
              res.destroy();
              return;
            }
            last = event.id;
            res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
          };
          rt.events.on('event', send);
          let page;
          do {
            page = rt.store.events(id, last);
            page.forEach(send);
          } while (page.length === 2000 && !res.destroyed);
          const ping = setInterval(() => res.write(': keepalive\n\n'), 15000);
          ping.unref();
          req.on('close', () => {
            clearInterval(ping);
            rt.events.off('event', send);
          });
          return;
        }
        if (action === 'file-drafts' && method === 'GET') {
          json(res, {
            data: await loadFileDrafts(rt.store, session, url.searchParams.get('workspace') ?? ''),
          });
          return;
        }
        if (action === 'file-info' && method === 'GET') {
          invariant(
            !url.searchParams.has('workspace') ||
              url.searchParams.get('workspace') === session.workspace,
            'WORKSPACE_CHANGED',
            '当前工作台已切换，请重新打开文件操作',
            409,
          );
          json(res, {
            data: await inspectWorkspaceItem(rt.store, session, url.searchParams.get('path') ?? ''),
          });
          return;
        }
        if (action === 'file-upload' && method === 'POST') {
          invariant(
            !url.searchParams.has('workspace') ||
              url.searchParams.get('workspace') === session.workspace,
            'WORKSPACE_CHANGED',
            '当前工作台已切换，请重新上传',
            409,
          );
          json(
            res,
            {
              data: await uploadWorkspaceFile(
                rt.store,
                session,
                url.searchParams.get('path') ?? '',
                await bytes(req, workspaceUploadLimit),
              ),
            },
            201,
          );
          return;
        }
        if (action === 'file-drafts' && method === 'PUT') {
          json(res, { data: await saveFileDrafts(rt.store, session, await body(req)) });
          return;
        }
        if (action === 'file-search' && method === 'GET') {
          const input = fileSearchSchema
            .extend({
              query: z.string().min(1).max(500),
              limit: z.coerce.number().int().min(1).max(100).default(100),
            })
            .parse(Object.fromEntries(url.searchParams));
          const abort = new AbortController();
          const disconnected = () => {
            if (!res.writableEnded) abort.abort();
          };
          res.once('close', disconnected);
          try {
            json(res, { data: await searchWorkspaceFiles(rt.store, session, input, abort.signal) });
          } finally {
            res.off('close', disconnected);
          }
          return;
        }
        if (action === 'files' && method === 'GET') {
          const input = directoryPageSchema
            .extend({
              limit: z.coerce.number().int().min(1).max(500).default(200),
            })
            .parse(Object.fromEntries(url.searchParams));
          const abort = new AbortController();
          const disconnected = () => {
            if (!res.writableEnded) abort.abort();
          };
          res.once('close', disconnected);
          try {
            json(res, {
              data: await listWorkspaceDirectory(rt.store, session, input, abort.signal),
            });
          } finally {
            res.off('close', disconnected);
          }
          return;
        }
        if (action === 'file-preview' && method === 'GET') {
          const input = z
            .object({
              path: z.string().min(1).max(4096),
              workspace: z.string().min(1).max(4096),
            })
            .parse(Object.fromEntries(url.searchParams));
          invariant(
            session.workspace === input.workspace,
            'WORKSPACE_CHANGED',
            '当前工作台已切换，请重新打开文件操作',
            409,
          );
          const abort = new AbortController();
          const disconnected = () => {
            if (!res.writableEnded) abort.abort();
          };
          res.once('close', disconnected);
          try {
            json(res, {
              data: await previewWorkspaceFile(rt.store, session, input.path, abort.signal),
            });
          } finally {
            res.off('close', disconnected);
          }
          return;
        }
        if (action === 'file' && method === 'GET') {
          json(res, {
            data: await readWorkspaceFile(rt.store, session, url.searchParams.get('path') ?? ''),
          });
          return;
        }
        if (action === 'file' && method === 'PUT') {
          invariant(session.permission !== 'read', 'READ_ONLY', '此会话工作区为只读', 403);
          const b = z
            .object({
              path: z.string(),
              text: z.string().max(1000000),
              expectedHash: z.string().optional(),
            })
            .parse(await body(req));
          json(res, {
            data: await writeWorkspaceFile(rt.store, session, b.path, b.text, b.expectedHash),
          });
          return;
        }
        if (action === 'file-history' && method === 'GET') {
          json(res, {
            data: await fileHistory(rt.store, session, url.searchParams.get('path') ?? ''),
          });
          return;
        }
        if (action === 'file-restore' && method === 'POST') {
          json(res, { data: await restoreFile(rt.store, session, await body(req)) });
          return;
        }
        if (action === 'file-operation' && method === 'POST') {
          json(res, { data: await manageFile(rt.store, session, await body(req), options) });
          return;
        }
      }
      match = route.match(/^\/api\/v1\/approvals\/([^/]+)$/);
      if (match && method === 'POST') {
        json(res, { data: rt.decideApproval(match[1], await body(req)) });
        return;
      }
      if (route === '/api/v1/memory' && method === 'GET') {
        const agentId = url.searchParams.get('agentId');
        rt.store.need('agent', agentId ?? '');
        json(res, { data: rt.store.list<Memory>('memory').filter((m) => m.agentId === agentId) });
        return;
      }
      if (route === '/api/v1/memory' && method === 'POST') {
        const b = z
          .object({
            agentId: z.string(),
            text: z.string().min(1).max(8000),
            pinned: z.boolean().default(false),
          })
          .parse(await body(req));
        rt.store.need('agent', b.agentId);
        json(
          res,
          { data: rt.store.put<Memory>('memory', randomUUID(), { ...b, source: null }) },
          201,
        );
        return;
      }
      match = route.match(/^\/api\/v1\/memory\/([^/]+)$/);
      if (match && method === 'DELETE') {
        rt.store.need('memory', match[1]);
        rt.store.remove('memory', match[1]);
        json(res, { data: { deleted: true } });
        return;
      }
      if (route === '/api/v1/usage' && method === 'GET') {
        json(res, { data: usageReport(rt.store, Object.fromEntries(url.searchParams)) });
        return;
      }
      if (route === '/api/v1/backup' && method === 'GET') {
        json(res, { data: exportBackup(rt) });
        return;
      }
      if (route === '/api/v1/backup/inspect' && method === 'POST') {
        const plan = inspectBackup(rt, await body(req));
        json(res, {
          data: {
            sha256: plan.sha256,
            counts: plan.counts,
            conflicts: plan.conflicts,
            alreadyImported: plan.alreadyImported,
          },
        });
        return;
      }
      if (route === '/api/v1/backup/import' && method === 'POST') {
        const b = z.object({ backup: z.unknown(), confirm: z.string() }).parse(await body(req));
        json(res, { data: await importBackup(rt, b.backup, b.confirm) });
        return;
      }
      throw new AppError('NOT_FOUND', '此接口不存在或尚未实现', 404);
    } catch (e) {
      const error = publicError(e);
      if (!res.headersSent)
        json(
          res,
          { error: { code: error.code, message: error.message, retryable: error.retryable } },
          error.status,
        );
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  invariant(address && typeof address === 'object', 'SERVER_START', '无法取得监听端口', 500);
  origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    origin,
    token,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
