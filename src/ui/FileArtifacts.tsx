import React, { useEffect, useRef, useState } from 'react';
import type {
  FileArtifactPage,
  FileArtifactView,
  FileArtifactLocation,
  Session,
} from '../shared/contracts.ts';
import { api, ApiError } from './api.ts';
import { t } from './i18n.ts';
import { Modal } from './components.tsx';

const stateText = {
  ready: '文件可用',
  changed: '文件已变化',
  missing: '文件已不存在',
  denied: '访问已受限',
  unchecked: '待核对',
} as const;
export function FileArtifacts({
  session,
  refresh,
  onCount,
  openFile,
  locateSource,
  report,
}: {
  session: Session;
  refresh: number;
  onCount: (count: number) => void;
  openFile: (location: FileArtifactLocation) => Promise<void>;
  locateSource: (messageId: string) => void;
  report: (error: unknown) => void;
}) {
  const scope = JSON.stringify([
    session.id,
    session.workspace,
    session.directoryGrants,
    session.blockedDirectories,
  ]);
  const prefix = `/sessions/${session.id}/file-artifacts`;
  const [page, setPage] = useState<FileArtifactPage>({ items: [], total: 0, nextBefore: null });
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<FileArtifactView | null>(null);
  const [error, setError] = useState('');
  const currentScope = useRef(scope),
    generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const actions = useRef(new Set<AbortController>()),
    mounted = useRef(false);
  currentScope.current = scope;
  async function load(before?: number) {
    const ticket = ++generation.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError('');
    if (!before) setPage({ items: [], total: 0, nextBefore: null });
    try {
      const result = await api<FileArtifactPage>(
        prefix + (before ? `?before=${before}` : ''),
        'GET',
        undefined,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        ticket !== generation.current ||
        currentScope.current !== scope
      )
        return;
      setPage((old) => ({
        ...result,
        items: before ? [...old.items, ...result.items] : result.items,
      }));
      onCount(result.total);
    } catch (error) {
      if (!controller.signal.aborted && ticket === generation.current) setError(String(error));
    } finally {
      if (ticket === generation.current && !controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    setRemoving(null);
    setBusy(false);
    void load();
    return () => {
      mounted.current = false;
      pending.current?.abort();
      generation.current++;
      for (const controller of actions.current) controller.abort();
    };
  }, [scope, refresh]);

  async function act(item: FileArtifactView, action: 'open' | 'download' | 'remove') {
    const controller = new AbortController();
    actions.current.add(controller);
    setBusy(true);
    const valid = () =>
      mounted.current && currentScope.current === scope && !controller.signal.aborted;
    try {
      if (action === 'open') {
        const result = await api<FileArtifactLocation>(
          `${prefix}/${item.id}/locate`,
          'GET',
          undefined,
          controller.signal,
        );
        if (valid()) await openFile(result);
      } else if (action === 'remove') {
        await api(`${prefix}/${item.id}`, 'DELETE', undefined, controller.signal);
        if (valid()) {
          setRemoving(null);
          await load();
        }
      } else {
        const response = await fetch('/api/v1' + `${prefix}/${item.id}/body`, {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) {
          const result = await response.json();
          throw new ApiError(result.error.code, result.error.message);
        }
        const blob = await response.blob();
        if (!valid()) return;
        const url = URL.createObjectURL(blob),
          link = document.createElement('a');
        link.href = url;
        link.download = item.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      if (valid()) {
        report(error);
        void load();
      }
    } finally {
      actions.current.delete(controller);
      if (valid()) setBusy(false);
    }
  }
  return (
    <section className="file-artifacts" aria-label={t('工具生成的文件')}>
      <div className="artifact-heading">
        <h3>{t('工具生成的文件')}</h3>
        <button aria-label={t('刷新工具文件')} disabled={busy} onClick={() => void load()}>
          {t('刷新')}
        </button>
      </div>
      <p className="artifact-note">{t('记录指向原文件；文件变化后可打开当前版本核对。')}</p>
      {loading && (
        <p role="status" className="muted">
          {t('正在核对文件…')}
        </p>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {page.items.map((item) => (
        <article className="file-artifact" data-artifact-id={item.id} key={item.id}>
          <strong title={item.path}>{item.name}</strong>
          <small className="artifact-path" title={item.path}>
            {item.path}
          </small>
          <small>
            {item.bytes < 1024
              ? t('{0} 字节', [item.bytes])
              : `${(item.bytes / 1024).toFixed(1)} KiB`}
          </small>
          <small className="artifact-state" role="status">
            {t(stateText[item.state])}
          </small>
          <div className="artifact-actions">
            <button
              aria-label={t('打开文件 {0}', [item.name])}
              disabled={busy || item.state === 'missing' || item.state === 'denied'}
              onClick={() => void act(item, 'open')}
            >
              {t('打开')}
            </button>
            <button
              aria-label={t('下载文件 {0}', [item.name])}
              disabled={busy || !['ready', 'unchecked'].includes(item.state)}
              onClick={() => void act(item, 'download')}
            >
              {t('下载')}
            </button>
            <button
              aria-label={t('定位工具消息 {0}', [item.name])}
              disabled={busy}
              onClick={() => locateSource(item.messageId)}
            >
              {t('来源')}
            </button>
            <button
              aria-label={t('移除文件记录 {0}', [item.name])}
              disabled={busy}
              onClick={() => setRemoving(item)}
            >
              {t('移除记录')}
            </button>
          </div>
        </article>
      ))}
      {page.nextBefore !== null && (
        <button
          className="artifact-more"
          disabled={loading || busy}
          onClick={() => void load(page.nextBefore!)}
        >
          {t('加载更多工具文件')}
        </button>
      )}
      {removing && (
        <Modal
          title={t('移除文件记录')}
          onClose={() => {
            if (!busy) setRemoving(null);
          }}
        >
          <p>{removing.name}</p>
          <p>{t('仅移除此会话的文件记录，磁盘文件会保留。')}</p>
          <div className="form-actions">
            <button disabled={busy} onClick={() => setRemoving(null)}>
              {t('取消')}
            </button>
            <button disabled={busy} onClick={() => void act(removing, 'remove')}>
              {t('确认移除记录')}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
