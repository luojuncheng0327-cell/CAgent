import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { stageArtifact } = require('../shared/artifact-core/ota-core.cjs');
const { validateManifest } = require('../shared/artifact-core/manifest.cjs');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const parts = [Buffer.from('first archive segment'), Buffer.from('second archive segment')];
const archive = Buffer.concat(parts);
const entry = {
  version: '0.450.1', path: 'server.tar.gz', size: archive.length, sha256: sha256(archive),
  parts: parts.map((bytes, index) => ({ path: `part-${index}`, size: bytes.length, sha256: sha256(bytes) })),
};
const manifest = {
  schema: 1, train: 1, channel: 'stable', releasedAt: '2026-09-27T00:00:00Z', keyId: 'test',
  minShell: '0.450.1', contract: { preload: 1, serverProtocol: 1 }, urgent: false,
  rollout: { percent: 100, salt: 'test' }, artifacts: { server: { 'win32-x64': entry } }, mirrors: ['https://release.example'],
};
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

describe('signed multipart artifacts', () => {
  it('validates every part and requires their sizes to match the signed archive', () => {
    expect(() => validateManifest(manifest)).not.toThrow();
    const invalid = structuredClone(manifest);
    invalid.artifacts.server['win32-x64'].parts[0].size++;
    expect(() => validateManifest(invalid)).toThrow(/total size mismatch/);
    invalid.artifacts.server['win32-x64'].parts[0].sha256 = 'invalid';
    expect(() => validateManifest(invalid)).toThrow(/sha256/);
  });

  it.each(['valid', 'corrupt-part', 'corrupt-archive'] as const)('downloads and verifies split artifacts: %s', async (scenario) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-parts-'));
    dirs.push(dir);
    const finalPath = path.join(dir, 'server.tar.gz');
    const fetchOnce = vi.fn(async (url: string) => {
      const index = Number(url.split('-').pop());
      const bytes = scenario === 'corrupt-part' && index === 1 ? Buffer.from('corrupt bytes') : parts[index];
      return { statusCode: 200, headers: {}, bodyStream: Readable.from([bytes]) };
    });
    const progress = vi.fn();
    const candidate = { ...entry, sha256: scenario === 'corrupt-archive' ? '0'.repeat(64) : entry.sha256 };
    const staging = stageArtifact({ finalPath, entry: candidate, mirrors: manifest.mirrors, log: () => {}, onProgress: progress, fetchOnce });
    if (scenario === 'valid') {
      await staging;
      expect(await fs.readFile(finalPath)).toEqual(archive);
      expect(progress).toHaveBeenLastCalledWith(archive.length);
      expect(fetchOnce.mock.calls.map(call => call[0])).toEqual(['https://release.example/part-0', 'https://release.example/part-1']);
      expect(await fs.readdir(dir)).toEqual(['server.tar.gz']);
    } else {
      await expect(staging).rejects.toThrow(/sha256 mismatch/);
      expect(await fs.readdir(dir)).toEqual([]);
    }
  });
});
