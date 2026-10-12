import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Updates } from '../src/desktop/updates.ts';

class Client extends EventEmitter {
  checks = 0;
  downloads = 0;
  installs = 0;
  async checkForUpdates() {
    this.checks++;
    this.emit('update-available', { version: '0.1.2' });
  }
  async downloadUpdate() {
    this.downloads++;
    this.emit('download-progress', { percent: 50.2 });
    this.emit('update-downloaded', { version: '0.1.2' });
  }
  quitAndInstall(silent?: boolean, restart?: boolean) {
    assert.equal(silent, false);
    assert.equal(restart, true);
    this.installs++;
  }
}

test('更新必须先检查再下载，下载完成且草稿保存后才能安装；重复操作不重复执行', async () => {
  const client = new Client();
  let saved = false;
  const updates = new Updates('0.1.1', client, async () => {
    saved = true;
  });
  const phases: string[] = [];
  updates.on('changed', (state) => phases.push(state.phase));
  await updates.install();
  await updates.download();
  assert.equal(client.installs + client.downloads, 0);
  await Promise.all([updates.check(), updates.check()]);
  assert.equal(client.checks, 1);
  await Promise.all([updates.download(), updates.download()]);
  assert.equal(client.downloads, 1);
  assert.equal(updates.snapshot().percent, 100);
  await updates.check();
  assert.equal(client.checks, 1);
  await Promise.all([updates.install(), updates.install()]);
  assert.equal(saved, true);
  assert.equal(client.installs, 1);
  assert.deepEqual(phases, [
    'checking',
    'available',
    'downloading',
    'downloading',
    'downloaded',
    'installing',
  ]);
});

test('保存失败或会话正在运行时不退出，下载的更新保留并允许重试', async () => {
  const client = new Client();
  let blocked = true;
  const updates = new Updates('0.1.1', client, async () => {
    if (blocked) throw new Error('草稿尚未保存');
  });
  await updates.check();
  await updates.download();
  await updates.install();
  assert.equal(updates.snapshot().phase, 'downloaded');
  assert.equal(updates.snapshot().error, '草稿尚未保存');
  assert.equal(client.installs, 0);
  blocked = false;
  await updates.install();
  assert.equal(client.installs, 1);
});

test('网络或下载校验失败不提供安装入口，重新检查后可恢复', async () => {
  const client = new Client();
  const updates = new Updates('0.1.1', client, async () => {});
  client.checkForUpdates = async () => {
    throw new Error('network');
  };
  await updates.check();
  assert.equal(updates.snapshot().phase, 'error');
  client.checkForUpdates = async () => {
    client.emit('update-available', { version: '0.1.2' });
  };
  await updates.check();
  client.downloadUpdate = async () => {
    client.emit('error', new Error('checksum mismatch'));
    throw new Error('checksum mismatch');
  };
  await updates.download();
  await updates.install();
  assert.equal(updates.snapshot().phase, 'error');
  assert.equal(client.installs, 0);
  await updates.check();
  assert.equal(updates.snapshot().phase, 'available');
});

test('开发模式不检查网络或安装，检查无新版本清理旧状态', async () => {
  const disabled = new Updates('0.1.1', null, async () => {
    throw new Error('must not install');
  });
  await disabled.check();
  await disabled.download();
  await disabled.install();
  assert.equal(disabled.snapshot().phase, 'unsupported');
  const client = new Client();
  const updates = new Updates('0.1.1', client, async () => {});
  await updates.check();
  client.checkForUpdates = async () => {
    client.emit('update-not-available');
  };
  await updates.check();
  assert.equal(updates.snapshot().phase, 'current');
  assert.equal(updates.snapshot().version, undefined);
});
