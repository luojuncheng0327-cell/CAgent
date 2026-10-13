import { spawn } from 'node:child_process';
import http from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { Preferences } from '../shared/contracts.ts';

export interface BackendOptions {
  home: string;
  workerPath: string;
  backendDir: string;
  python: string;
  nodeExecutable: string;
  uiDir?: string;
  trashItem?: (target: string) => Promise<void>;
  pythonArgs?: string[];
  onFailure?: () => void;
  diagnostic?: (text: string) => void;
}
const readySchema = z.object({
  kind: z.literal('ready'),
  origin: z.string().url(),
  pid: z.number().int().positive(),
});
function localJson(url: string, token: string, method = 'GET', body?: unknown) {
  return new Promise<{ status: number; data: any }>((resolve, reject) => {
    const request = http.request(
      url,
      {
        method,
        agent: false,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      },
      (response) => {
        let text = '';
        response.on('data', (part) => {
          text += part;
          if (text.length > 512000) request.destroy(new Error('Invalid local response'));
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode ?? 500, data: JSON.parse(text) });
          } catch {
            reject(new Error('Invalid local response'));
          }
        });
      },
    );
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
function ready(
  child: ChildProcess,
  label: string,
): Promise<z.infer<typeof readySchema> & { preferences?: Preferences }> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    const timer = setTimeout(() => fail(), 60000);
    const fail = () => {
      clearTimeout(timer);
      lines.close();
      reject(new Error(label + '启动失败，请检查后端依赖和数据目录权限。'));
    };
    child.once('error', fail);
    child.once('exit', fail);
    lines.on('line', (line) => {
      if (line.length > 65536) return fail();
      try {
        const value = JSON.parse(line);
        const parsed = readySchema.parse(value);
        const url = new URL(parsed.origin);
        if (
          url.protocol !== 'http:' ||
          url.hostname !== '127.0.0.1' ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        )
          return fail();
        // Windows venv python.exe is a launcher; its interpreter has a different PID.
        // Readiness comes from this child's private stdout pipe, and shutdown owns the launcher.
        clearTimeout(timer);
        child.off('error', fail);
        child.off('exit', fail);
        lines.close();
        child.stdout?.resume();
        resolve({ ...parsed, preferences: value.preferences });
      } catch {
        fail();
      }
    });
  });
}
const shutdowns = new WeakMap<ChildProcess, Promise<void>>();
function waitForExit(child: ChildProcess, timeout: number) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    child.once('exit', onExit);
  });
}
function stop(child: ChildProcess): Promise<void> {
  const pending = shutdowns.get(child);
  if (pending) return pending;
  const shutdown = (async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.end();
    if (await waitForExit(child, 10000)) return;
    if (process.platform === 'win32' && child.pid) {
      // Windows venv launchers own an interpreter child. Wait for tree termination,
      // rather than reporting shutdown complete when only the launcher was killed.
      await new Promise<void>((resolve) => {
        const terminate = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        terminate.once('error', () => {
          child.kill('SIGKILL');
          resolve();
        });
        terminate.once('exit', () => resolve());
      });
    } else child.kill('SIGKILL');
    if (!(await waitForExit(child, 5000))) throw new Error('后端进程关闭未完成');
  })();
  shutdowns.set(child, shutdown);
  return shutdown;
}
export function backendRuntimePaths(appDir: string, resourcesPath: string, packaged: boolean) {
  const backendDir = packaged ? path.join(resourcesPath, 'backend') : path.join(appDir, 'backend');
  const candidates = packaged
    ? [path.join(resourcesPath, 'python', 'python.exe')]
    : [
        process.env.CAGENT_PYTHON,
        path.join(appDir, '.runtime', 'backend-venv', 'Scripts', 'python.exe'),
        path.join(appDir, '.runtime', 'backend-venv', 'bin', 'python'),
      ].filter((x): x is string => !!x);
  const python = candidates.find((candidate) => fs.existsSync(candidate));
  if (!python) throw new Error('Python 后端尚未准备好，请先运行 pnpm run setup:backend。');
  return { backendDir, python };
}
export async function startBackend(options: BackendOptions) {
  const token = randomBytes(32).toString('base64url');
  const internalToken = randomBytes(32).toString('base64url');
  const events = new EventEmitter();
  const children: ChildProcess[] = [];
  let closing = false;
  let startupComplete = false;
  let preferences: Preferences;
  const temporaryDir = path.join(options.home, 'backend', 'tmp');
  fs.mkdirSync(temporaryDir, { recursive: true });
  const spawnService = (
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    ipc = false,
  ) => {
    const child = spawn(executable, args, {
      env,
      windowsHide: true,
      stdio: ipc ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    child.on('error', () => events.emit('failed'));
    // Arbitrary interpreter or HTTP errors may include credentials. Public diagnostics use codes only.
    child.stderr?.on('data', (bytes) => options.diagnostic?.(String(bytes)));
    child.on('exit', () => {
      if (!closing) {
        closing = true;
        for (const other of children) if (other !== child) void stop(other);
        if (startupComplete) options.onFailure?.();
        events.emit('failed');
      }
    });
    return child;
  };
  try {
    const worker = spawnService(
      options.nodeExecutable,
      [options.workerPath],
      {
        ...process.env,
        TEMP: temporaryDir,
        TMP: temporaryDir,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_USE_ENV_PROXY: '1',
      },
      true,
    );
    worker.on('message', (message: unknown) => {
      const payload = z
        .object({
          kind: z.string(),
          id: z.string().optional(),
          path: z.string().optional(),
          preferences: z.unknown().optional(),
        })
        .safeParse(message);
      if (!payload.success) return;
      if (payload.data.kind === 'preferences') {
        preferences = payload.data.preferences as Preferences;
        events.emit('preferences.changed');
      }
      if (payload.data.kind === 'native-trash' && payload.data.id && payload.data.path) {
        const { id, path: target } = payload.data;
        void Promise.resolve()
          .then(() => {
            if (!options.trashItem) throw new Error('Unavailable');
            return options.trashItem(target!);
          })
          .then(
            () => worker.connected && worker.send?.({ kind: 'native-result', id }, () => {}),
            () =>
              worker.connected &&
              worker.send?.({ kind: 'native-result', id, error: '系统回收站操作未完成' }, () => {}),
          );
      }
    });
    const workerReady = ready(worker, '本机兼容服务');
    worker.stdin!.write(
      JSON.stringify({ home: options.home, token, internalToken, uiDir: options.uiDir }) + '\n',
    );
    const upstream = await workerReady;
    preferences = upstream.preferences!;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TEMP: temporaryDir,
      TMP: temporaryDir,
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
      PYTHONPATH: options.backendDir,
      LANGCHAIN_TRACING_V2: 'false',
      LANGSMITH_TRACING: 'false',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const python = spawnService(
      options.python,
      [...(options.pythonArgs ?? []), '-m', 'cagent_backend', '--config-stdin', '--port', '0'],
      env,
    );
    const pythonReady = ready(python, 'Python 后端');
    python.stdin!.write(
      JSON.stringify({
        home: options.home,
        upstreamOrigin: upstream.origin,
        internalToken,
        publicToken: token,
        uiDir: options.uiDir,
      }) + '\n',
    );
    const backend = await pythonReady;
    const internal = async (route: string, method = 'GET', body?: unknown) => {
      const result = await localJson(
        upstream.origin + '/internal/v1' + route,
        internalToken,
        method,
        body,
      );
      if (result.status !== 200) throw new Error('后端状态读取失败');
      return result.data.data;
    };
    await internal('/configure', 'POST', { origin: backend.origin });
    const architecture = await localJson(backend.origin + '/api/v1/architecture', token);
    if (architecture.status !== 200) throw new Error('Python 后端就绪检查失败');
    startupComplete = true;
    return {
      origin: backend.origin,
      token,
      workerPid: upstream.pid,
      backendPid: backend.pid,
      events,
      preferences: () => preferences,
      busy: async () => !!(await internal('/runtime')).busy,
      close: async () => {
        closing = true;
        // Stop the compatibility worker first so active graph requests cancel while Python is alive.
        await stop(worker);
        await stop(python);
      },
    };
  } catch (error) {
    closing = true;
    for (const child of children) await stop(child);
    throw error;
  }
}
