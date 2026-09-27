import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, invariant } from './errors.ts';

export function acquireHome(home: string): () => void {
  const root = path.resolve(home);
  invariant(
    !root.split(/[\\/]/).some((s) => s.toLowerCase() === '.hanako'),
    'LEGACY_HOME',
    '请选择独立的新数据目录',
  );
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  invariant(
    !fs
      .realpathSync(root)
      .split(/[\\/]/)
      .some((p) => p.toLowerCase() === '.hanako'),
    'LEGACY_HOME',
    '新数据目录不能指向旧数据目录',
  );
  const file = path.join(root, 'runtime.lock'),
    nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, nonce }), {
        flag: 'wx',
        mode: 0o600,
      });
      return () => {
        try {
          const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (owner.nonce === nonce) fs.unlinkSync(file);
        } catch {}
      };
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      let owner: { pid: number };
      try {
        owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        throw new AppError('HOME_LOCKED', '数据目录锁无法读取，请确认其他实例已退出', 409);
      }
      invariant(
        Number.isSafeInteger(owner.pid) && owner.pid > 0,
        'HOME_LOCKED',
        '数据目录锁无效，已停止启动',
        409,
      );
      try {
        process.kill(owner.pid, 0);
        throw new AppError('HOME_LOCKED', '此数据目录已被另一个实例使用', 409);
      } catch (error: any) {
        if (error.code !== 'ESRCH') throw error;
        fs.unlinkSync(file);
      }
    }
  }
  throw new AppError('HOME_LOCKED', '无法独占此数据目录', 409);
}
