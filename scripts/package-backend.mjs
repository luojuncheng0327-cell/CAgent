import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const environment = path.join(root, '.runtime', 'backend-venv');
const python = path.join(environment, 'Scripts', 'python.exe');
const uv = path.join(environment, 'Scripts', 'uv.exe');
const output = path.join(root, '.runtime', 'backend-package');
const base = path.join(output, 'python');
const site = path.join(base, 'Lib', 'site-packages');
if (process.platform !== 'win32') throw new Error('This backend bundle targets Windows x64.');
async function run(executable, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        UV_CACHE_DIR: path.join(root, '.runtime', 'uv-cache'),
      },
      windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let text = '';
    if (capture)
      child.stdout.on('data', (data) => {
        text += data;
      });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve(text.trim()) : reject(new Error('Python bundle failed: ' + code)),
    );
  });
}
const interpreter = await run(python, ['-c', 'import sys; print(sys.base_prefix)'], true);
await fs.mkdir(base, { recursive: true });
for (const name of [
  'python.exe',
  'python3.dll',
  'python312.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
  'LICENSE.txt',
])
  await fs.copyFile(path.join(interpreter, name), path.join(base, name));
const exclude = new Set([
  'site-packages',
  '__pycache__',
  'test',
  'tests',
  'idlelib',
  'tkinter',
  'turtledemo',
  'ensurepip',
]);
await fs.cp(path.join(interpreter, 'Lib'), path.join(base, 'Lib'), {
  recursive: true,
  filter: (source) => !exclude.has(path.basename(source)),
});
await fs.cp(path.join(interpreter, 'DLLs'), path.join(base, 'DLLs'), {
  recursive: true,
  filter: (source) => !path.basename(source).includes('_tkinter'),
});
await fs.mkdir(site, { recursive: true });
const requirements = path.join(output, 'requirements.txt');
await run(uv, [
  'export',
  '--project',
  'backend',
  '--frozen',
  '--no-dev',
  '--no-emit-project',
  '--extra',
  'postgres',
  '--output-file',
  requirements,
]);
await run(uv, [
  'pip',
  'install',
  '--python',
  python,
  '--target',
  site,
  '--requirements',
  requirements,
  '--require-hashes',
]);
await fs.cp(
  path.join(root, 'backend', 'cagent_backend'),
  path.join(output, 'backend', 'cagent_backend'),
  {
    recursive: true,
    filter: (source) => !['__pycache__', '.pytest_cache'].includes(path.basename(source)),
  },
);
await fs.cp(path.join(root, 'backend', 'alembic'), path.join(output, 'backend', 'alembic'), {
  recursive: true,
  filter: (source) => path.basename(source) !== '__pycache__',
});
await fs.copyFile(
  path.join(root, 'backend', 'alembic.ini'),
  path.join(output, 'backend', 'alembic.ini'),
);
await fs.copyFile(
  path.join(root, 'backend', 'pyproject.toml'),
  path.join(output, 'backend', 'pyproject.toml'),
);
// Only the local bundle is modified. The host interpreter and its packages remain unchanged.
await fs.writeFile(
  path.join(base, 'python312._pth'),
  'DLLs\nLib\nLib/site-packages\n../backend\nimport site\n',
);
await fs.writeFile(
  path.join(output, 'backend', 'DEPENDENCIES.md'),
  '# Python 后端依赖\n\n固定版本及哈希见随包 requirements.txt 和项目 backend/uv.lock。各包原始 dist-info 许可证随 site-packages 保留。\n',
);
await fs.copyFile(requirements, path.join(output, 'backend', 'requirements.txt'));
await run(path.join(base, 'python.exe'), [
  '-c',
  'import fastapi, langgraph, langchain, sqlalchemy, qdrant_client, neo4j, cagent_backend.app; print("Packaged Python imports verified")',
]);
console.log('Backend bundle ready: ' + output);
