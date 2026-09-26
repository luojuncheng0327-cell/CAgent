import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.ts';
import { errorBus } from './error-bus.ts';

export function safeReadFile(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    // ENOENT 是 fallback 的合法场景（可选文件不存在），不上报 ErrorBus
    if (err.code !== 'ENOENT') {
      const code = err.code === 'EACCES' ? 'FS_PERMISSION' : 'UNKNOWN';
      errorBus.report(new AppError(code, { cause: err, context: { filePath } }));
    }
    return fallback;
  }
}

export function safeReadJSON(filePath, fallback = null) {
  const text = safeReadFile(filePath, null);
  if (text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { filePath } }));
    return fallback;
  }
}

export async function safeReadYAML(filePath, fallback = null) {
  const text = safeReadFile(filePath, null);
  if (text === null) return fallback;
  try {
    const yaml = await import('js-yaml');
    return yaml.default?.load?.(text) ?? yaml.load(text);
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { filePath } }));
    return fallback;
  }
}

export function safeReadYAMLSync(filePath, fallback = null, yaml) {
  const text = safeReadFile(filePath, null);
  if (text === null) return fallback;
  try {
    return yaml.load(text);
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { filePath } }));
    return fallback;
  }
}

/**
 * Atomic file write: write to tmp, then rename over target.
 * Prevents partial writes if the process crashes mid-write.
 * @param {string} filePath - target path
 * @param {string} content - text content (utf-8)
 * @param {object} [opts]
 * @param {number} [opts.mode] - file permission bits (e.g. 0o600 for sensitive credentials)
 */
export function atomicWriteSync(filePath, content, { mode }: { mode?: number } = {}) {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf-8", flag: "wx", ...(mode !== undefined ? { mode } : {}) });
    if (mode !== undefined) {
      try { fs.chmodSync(tmp, mode); } catch { /* mode-on-create 兜底 */ }
    }
    fs.renameSync(tmp, filePath);
  } finally {
    // Each writer owns its temporary file; failures cannot delete another
    // process's in-progress write or leave sensitive temp contents behind.
    try { fs.unlinkSync(tmp); } catch { /* renamed or already removed */ }
  }
}

/**
 * Atomic directory copy with rollback.
 * 1. Copy src -> dst.tmp_{ts}
 * 2. If dst exists, rename dst -> dst.bak_{ts}
 * 3. Rename dst.tmp_{ts} -> dst
 * 4. Delete dst.bak_{ts}
 * Recovery: if step 3 fails, rename dst.bak_{ts} back to dst, clean up tmp.
 */
export function safeCopyDir(src, dst) {
  const ts = Date.now();
  const tmpDst = `${dst}.tmp_${ts}`;
  const bakDst = `${dst}.bak_${ts}`;

  try {
    _copyDirRecursive(src, tmpDst);

    let hadExisting = false;
    if (fs.existsSync(dst)) {
      fs.renameSync(dst, bakDst);
      hadExisting = true;
    }

    try {
      fs.renameSync(tmpDst, dst);
    } catch (renameErr) {
      if (hadExisting) {
        try { fs.renameSync(bakDst, dst); } catch { /* best effort rollback */ }
      }
      _cleanupDir(tmpDst);
      throw renameErr;
    }

    if (hadExisting) _cleanupDir(bakDst);
  } catch (err) {
    _cleanupDir(tmpDst);
    throw new AppError('FS_COPY_FAILED', { cause: err, context: { src, dst } });
  }
}

function _copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    const lstat = fs.lstatSync(s);
    if (lstat.isSymbolicLink()) {
      const targetStat = fs.statSync(s);
      if (targetStat.isDirectory()) {
        const rawTarget = fs.readlinkSync(s);
        const linkTarget = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(path.dirname(s), rawTarget);
        fs.symlinkSync(linkTarget, d, process.platform === "win32" ? "junction" : "dir");
      } else {
        fs.copyFileSync(s, d);
      }
    } else if (entry.isDirectory()) {
      _copyDirRecursive(s, d);
    } else {
      // 目标已存在且只读时 copyFileSync 会失败，先移走再复制。
      // 不能改用 chmod 放宽目标权限：这条路径也复制凭证文件，
      // 放宽后的权限会留在副本上，等于把源文件的保护级别丢掉。
      if (fs.existsSync(d)) {
        try { fs.rmSync(d, { force: true }); } catch { /* 交给 copyFileSync 报错 */ }
      }
      fs.copyFileSync(s, d);
      // copyFileSync 只在目标不存在时继承源权限，显式对齐一次更保险
      try { fs.chmodSync(d, lstat.mode & 0o777); } catch { /* Windows NTFS */ }
    }
  }
}

function _cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
