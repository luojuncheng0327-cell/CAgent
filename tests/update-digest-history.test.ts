import { describe, expect, it, vi } from 'vitest';

const digest = (version: string) => ({
  schemaVersion: 1,
  tag: `v${version}`,
  version,
  previousTag: '',
  generatedAt: '2026-07-11T00:00:00.000Z',
  noUserFacingChanges: false,
  summary: { zh: `${version} 摘要`, en: `${version} summary` },
  counts: { feature: 0, fix: 0, improvement: 0, migration: 0 },
  items: [],
});

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

describe('update digest history loader', () => {
  it('loads the newest five published entries from this fork on Gitee', async () => {
    const entries = ['0.500.5', '0.500.4', '0.500.2', '0.500.1', '0.500.0', '0.499.9'].map(digest);
    const fetchImpl = vi.fn(async () => response({ schema: 2, entries }));
    const normalize = vi.fn((value: ReturnType<typeof digest>, expectedVersion: string) => (
      value.version === expectedVersion ? value : null
    ));

    const { createUpdateDigestHistoryLoader } = await import('../desktop/src/shared/update-digest-history.cjs');
    const load = createUpdateDigestHistoryLoader({
      fetchImpl,
      normalize,
      readBundledEntries: () => [],
    });

    const result = await load();

    expect(result.source).toBe('online');
    expect(result.complete).toBe(true);
    expect(result.entries.map((entry: { version: string }) => entry.version)).toEqual([
      '0.500.5',
      '0.500.4',
      '0.500.2',
      '0.500.1',
      '0.500.0',
    ]);
    expect(normalize).toHaveBeenCalledTimes(5);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      'https://gitee.com/luo-juncheng666/cagent/raw/master/updates/release-digest.v2.json',
      expect.any(Object),
    );
  });

  it('skips malformed and duplicate entries without contacting another release source', async () => {
    const entries = [
      { ...digest('0.500.5'), tag: 'invalid' },
      { ...digest('0.500.4'), version: '0.400.0' },
      digest('0.500.3'), digest('0.500.3'),
    ];
    const fetchImpl = vi.fn(async () => response({ schema: 2, entries }));
    const normalize = (value: ReturnType<typeof digest>, expectedVersion: string) => (
      value.version === expectedVersion ? value : null
    );

    const { createUpdateDigestHistoryLoader } = await import('../desktop/src/shared/update-digest-history.cjs');
    const load = createUpdateDigestHistoryLoader({ fetchImpl, normalize, readBundledEntries: () => [] });
    const result = await load();

    expect(result).toMatchObject({ source: 'online', complete: false });
    expect(result.entries.map((entry: { version: string }) => entry.version)).toEqual(['0.500.3']);
  });

  it('falls back explicitly to bundled entries when the website is unavailable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const bundled = [digest('0.500.1'), digest('0.500.0')];
    const log = vi.fn();

    const { createUpdateDigestHistoryLoader } = await import('../desktop/src/shared/update-digest-history.cjs');
    const load = createUpdateDigestHistoryLoader({
      fetchImpl,
      normalize: (value: ReturnType<typeof digest>) => value,
      readBundledEntries: () => bundled,
      log,
    });
    const result = await load();

    expect(result).toEqual({ entries: bundled, source: 'bundled', complete: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });

  it('caches a successful website result to avoid repeated API requests', async () => {
    const fetchImpl = vi.fn(async () => response({ schema: 2, entries: [digest('0.500.1')] }));

    const { createUpdateDigestHistoryLoader } = await import('../desktop/src/shared/update-digest-history.cjs');
    const load = createUpdateDigestHistoryLoader({
      fetchImpl,
      normalize: (value: ReturnType<typeof digest>) => value,
      readBundledEntries: () => [],
    });

    await load();
    await load();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
