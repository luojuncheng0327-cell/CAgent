import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { Runtime } from './runtime.ts';
import { serve } from './http.ts';
import { HttpGraphClient } from './graph-client.ts';
import { HttpKnowledgeClient } from './knowledge-client.ts';
import { AppError, invariant } from './errors.ts';
import { terminalStatuses } from '../shared/contracts.ts';
import type { Run } from '../shared/contracts.ts';

const input = createInterface({ input: process.stdin });
const configuration = z.object({
  home: z.string().min(1),
  token: z.string().min(32),
  internalToken: z.string().min(32),
  uiDir: z.string().min(1).optional(),
});
let graphOrigin = '';
const pendingNative = new Map<string, (error?: string) => void>();
process.on('message', (raw: unknown) => {
  const result = z
    .object({ kind: z.literal('native-result'), id: z.string(), error: z.string().optional() })
    .safeParse(raw);
  if (result.success) pendingNative.get(result.data.id)?.(result.data.error);
});
function trashItem(target: string): Promise<void> {
  invariant(process.send, 'NATIVE_UNAVAILABLE', '系统回收站不可用', 503);
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => complete('系统回收站操作超时'), 20000);
    function complete(error?: string) {
      clearTimeout(timer);
      pendingNative.delete(id);
      error ? reject(new AppError('NATIVE_FAILED', error, 503)) : resolve();
    }
    pendingNative.set(id, complete);
    if (!process.connected) return complete('系统回收站不可用');
    process.send!({ kind: 'native-trash', id, path: target }, undefined, undefined, (error) => {
      if (error) complete('系统回收站不可用');
    });
  });
}
async function start(raw: string) {
  const config = configuration.parse(JSON.parse(raw));
  const rt = new Runtime(config.home, {
    knowledgeSearch: new HttpKnowledgeClient(() => graphOrigin, config.token).search,
    graphClient: new HttpGraphClient(() => {
      invariant(graphOrigin, 'GRAPH_UNAVAILABLE', '任务服务尚未就绪', 503);
      return graphOrigin;
    }, config.internalToken),
  });
  const server = await serve(rt, {
    token: config.token,
    uiDir: config.uiDir,
    trashItem,
    internalRequest: async (req, res) => {
      const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
      const expected = Buffer.from(config.internalToken);
      invariant(
        supplied.length === expected.length && timingSafeEqual(supplied, expected),
        'UNAUTHORIZED',
        '内部认证失败',
        401,
      );
      const route = new URL(req.url!, 'http://127.0.0.1').pathname;
      const json = (data: unknown, envelope = true) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(envelope ? { data } : data));
      };
      if (req.method === 'GET' && route === '/internal/v1/runtime') {
        json({
          preferences: rt.preferences(),
          busy: rt.store.list<Run>('run').some((run) => !terminalStatuses.has(run.status)),
          suggestedWorkspace: rt.suggestedWorkspace,
        });
        return;
      }
      invariant(req.method === 'POST', 'NOT_FOUND', '内部接口不存在', 404);
      let body = '';
      for await (const bytes of req) {
        body += bytes;
        invariant(
          Buffer.byteLength(body) <= 1024 * 1024,
          'BODY_TOO_LARGE',
          '内部请求超出上限',
          413,
        );
      }
      const payload = body ? JSON.parse(body) : {};
      if (route === '/internal/v1/configure') {
        const { origin } = z.object({ origin: z.string().url() }).parse(payload);
        const url = new URL(origin);
        invariant(
          url.protocol === 'http:' &&
            url.hostname === '127.0.0.1' &&
            !url.username &&
            !url.password &&
            url.pathname === '/' &&
            !url.search &&
            !url.hash,
          'INVALID_ORIGIN',
          '任务服务地址无效',
          400,
        );
        invariant(
          !graphOrigin || graphOrigin === url.origin,
          'ALREADY_CONFIGURED',
          '任务服务已配置',
          409,
        );
        graphOrigin = url.origin;
        json({ configured: true });
        return;
      }
      const step = route.match(/^\/internal\/v1\/runs\/([^/]+)\/steps\/(model|tool|compact)$/);
      invariant(step, 'NOT_FOUND', '内部接口不存在', 404);
      json(await rt.graphStep(step[1], step[2], payload), false);
    },
  });
  rt.events.on('preferences.changed', () => {
    if (process.connected)
      process.send?.(
        { kind: 'preferences', preferences: rt.preferences() },
        undefined,
        undefined,
        () => {},
      );
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await rt.close();
    await server.close();
    for (const settle of pendingNative.values()) settle('应用正在退出');
    input.close();
    process.exit(0);
  };
  process.on('disconnect', () => void stop());
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
  input.on('close', () => void stop());
  fs.mkdirSync(path.join(config.home, 'backend'), { recursive: true });
  console.log(
    JSON.stringify({
      kind: 'ready',
      origin: server.origin,
      pid: process.pid,
      preferences: rt.preferences(),
    }),
  );
}
input.once(
  'line',
  (line) =>
    void start(line).catch(() => {
      console.error('CAgent compatibility service startup failed');
      process.exit(1);
    }),
);
