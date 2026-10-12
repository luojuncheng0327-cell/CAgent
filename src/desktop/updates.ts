import { EventEmitter } from 'node:events';
import type { UpdateState } from '../shared/updates.ts';

// The updater owns version comparison, HTTPS downloads, checksum verification
// and the NSIS install handoff. The renderer only receives these small states.
export interface UpdateClient {
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(silent?: boolean, restart?: boolean): void;
}
export class Updates extends EventEmitter {
  private state: UpdateState;
  private busy = false;
  private beforeInstall: () => Promise<void>;
  private client: UpdateClient | null;
  constructor(version: string, client: UpdateClient | null, beforeInstall: () => Promise<void>) {
    super();
    this.client = client;
    this.beforeInstall = beforeInstall;
    this.state = { phase: client ? 'idle' : 'unsupported', currentVersion: version };
    client?.on('update-available', (info: { version: string }) => {
      this.change({
        phase: 'available',
        version: info.version,
        percent: undefined,
        error: undefined,
      });
    });
    client?.on('update-not-available', () => {
      this.change({ phase: 'current', version: undefined, percent: undefined, error: undefined });
    });
    client?.on('download-progress', (progress: { percent: number }) => {
      if (this.state.phase === 'downloading')
        this.change({ percent: Math.min(100, Math.max(0, Math.round(progress.percent))) });
    });
    client?.on('update-downloaded', (info: { version: string }) => {
      this.change({ phase: 'downloaded', version: info.version, percent: 100, error: undefined });
    });
    client?.on('error', () =>
      this.change({ phase: 'error', error: '更新失败，请检查网络后重试。' }),
    );
  }
  snapshot() {
    return { ...this.state };
  }
  private change(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    this.emit('changed', this.snapshot());
  }
  async check() {
    if (
      !this.client ||
      this.busy ||
      ['downloading', 'downloaded', 'installing'].includes(this.state.phase)
    )
      return this.snapshot();
    this.busy = true;
    this.change({ phase: 'checking', error: undefined });
    try {
      await this.client.checkForUpdates();
    } catch {
      this.change({ phase: 'error', error: '更新失败，请检查网络后重试。' });
    } finally {
      this.busy = false;
    }
    return this.snapshot();
  }
  async download() {
    if (!this.client || this.busy || this.state.phase !== 'available') return this.snapshot();
    this.busy = true;
    this.change({ phase: 'downloading', percent: 0, error: undefined });
    try {
      await this.client.downloadUpdate();
    } catch {
      this.change({ phase: 'error', error: '更新失败，请检查网络后重试。' });
    } finally {
      this.busy = false;
    }
    return this.snapshot();
  }
  async install() {
    if (!this.client || this.busy || this.state.phase !== 'downloaded') return this.snapshot();
    this.busy = true;
    this.change({ phase: 'installing', error: undefined });
    try {
      await this.beforeInstall();
      this.client.quitAndInstall(false, true);
    } catch (error) {
      this.change({
        phase: 'downloaded',
        error: error instanceof Error ? error.message : '无法开始安装，请重试。',
      });
    } finally {
      this.busy = false;
    }
    return this.snapshot();
  }
}
