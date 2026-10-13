import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const environment = path.join(root, '.runtime', 'backend-venv');
const bin = process.platform === 'win32' ? 'Scripts' : 'bin';
const python = path.join(environment, bin, process.platform === 'win32' ? 'python.exe' : 'python');
const uv = path.join(environment, bin, process.platform === 'win32' ? 'uv.exe' : 'uv');
const mode = process.argv[2] ?? 'test';
function run(executable, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        UV_CACHE_DIR: path.join(root, '.runtime', 'uv-cache'),
        UV_PROJECT_ENVIRONMENT: environment,
      },
      windowsHide: true,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Backend command exited ' + code)),
    );
  });
}
if (mode === 'setup') {
  let base = process.env.CAGENT_PYTHON;
  if (!base) {
    const bundled = path.join(
      os.homedir(),
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'python',
      'python.exe',
    );
    base = fs.existsSync(bundled) ? bundled : process.platform === 'win32' ? 'python' : 'python3';
  }
  if (!fs.existsSync(python)) await run(base, ['-m', 'venv', environment]);
  if (!fs.existsSync(uv)) await run(python, ['-m', 'pip', 'install', 'uv==0.13.0']);
  await run(uv, [
    'sync',
    '--project',
    'backend',
    '--frozen',
    '--group',
    'dev',
    '--extra',
    'postgres',
    '--extra',
    'worker',
  ]);
} else {
  if (!fs.existsSync(python)) throw new Error('Run pnpm run setup:backend first.');
  if (mode === 'test') await run(python, ['-m', 'pytest', '-q'], path.join(root, 'backend'));
  else if (mode === 'check') {
    await run(
      python,
      ['-m', 'ruff', 'check', 'cagent_backend', 'tests'],
      path.join(root, 'backend'),
    );
    await run(
      python,
      ['-m', 'ruff', 'format', '--check', 'cagent_backend', 'tests'],
      path.join(root, 'backend'),
    );
  } else if (mode === 'format') {
    await run(
      python,
      ['-m', 'ruff', 'check', '--fix', 'cagent_backend', 'tests'],
      path.join(root, 'backend'),
    );
    await run(
      python,
      ['-m', 'ruff', 'format', 'cagent_backend', 'tests'],
      path.join(root, 'backend'),
    );
  } else throw new Error('Unknown backend command.');
}
