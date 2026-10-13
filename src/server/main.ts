import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startBackend, backendRuntimePaths } from '../desktop/backend-process.ts';

const home = path.resolve(
  process.env.CAGENT_HOME ??
    path.join(os.homedir(), process.platform === 'win32' ? '.CAgent' : '.cagent'),
);
const uiDir = path.resolve('dist/ui');
const app = await startBackend({
  home,
  workerPath: path.resolve('src/server/backend-worker.ts'),
  nodeExecutable: process.execPath,
  ...backendRuntimePaths(path.resolve('.'), '', false),
  uiDir: fs.existsSync(uiDir) ? uiDir : undefined,
  onFailure: () => void stop(),
});
fs.writeFileSync(
  path.join(home, 'connection.json'),
  JSON.stringify({
    origin: app.origin,
    token: app.token,
    pid: process.pid,
    backendPid: app.backendPid,
    workerPid: app.workerPid,
  }),
  { mode: 0o600 },
);
console.log(`CAgent ready: ${app.origin}\n本机连接信息：${path.join(home, 'connection.json')}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  fs.rmSync(path.join(home, 'connection.json'), { force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
