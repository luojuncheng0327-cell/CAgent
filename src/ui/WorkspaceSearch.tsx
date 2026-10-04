import React, { useEffect, useState } from 'react';
import type { Session } from '../shared/contracts.ts';
import type { FileSearchResult } from '../server/file-search.ts';
import { api } from './api.ts';
import { t } from './i18n.ts';
import { Icon } from './components.tsx';

export function WorkspaceSearch({
  session,
  query,
  mode,
  refresh,
  disabled,
  open,
  futurePreview,
}: {
  session: Session;
  query: string;
  mode: 'filename' | 'content';
  refresh: number;
  disabled: boolean;
  open: (path: string, line?: number) => Promise<void>;
  futurePreview: (name: string) => boolean;
}) {
  const [result, setResult] = useState<FileSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setResult(null);
    setError(null);
    const timer = setTimeout(() => {
      const parameters = new URLSearchParams({ query, mode, workspace: session.workspace ?? '' });
      void api<FileSearchResult>(
        `/sessions/${session.id}/file-search?${parameters}`,
        'GET',
        undefined,
        abort.signal,
      )
        .then((value) => {
          if (!abort.signal.aborted) setResult(value);
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(String(e.message ?? e));
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [
    session.id,
    session.workspace,
    session.directoryGrants,
    session.blockedDirectories,
    query,
    mode,
    refresh,
  ]);

  const reason = (value: string) => {
    switch (value) {
      case 'result-limit':
        return t('结果数量达到上限');
      case 'scan-limit':
        return t('扫描项目数量达到上限');
      case 'depth-limit':
        return t('目录层级达到上限');
      case 'byte-limit':
        return t('读取总量达到上限');
      case 'time-limit':
        return t('搜索时间达到上限');
      case 'access-denied':
        return t('跳过无权访问的目录');
      case 'unreadable':
        return t('部分文件无法读取');
      case 'large-file':
        return t('跳过超过 512 KiB 的文件');
      case 'binary-file':
        return t('跳过二进制文件');
      case 'text-encoding':
        return t('跳过非 UTF-8 文件');
      default:
        return value;
    }
  };
  return (
    <section
      className="workspace-search-results"
      aria-label={t('工作区搜索结果')}
      aria-busy={!result && !error}
    >
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : !result ? (
        <p className="panel-empty" role="status">
          {t('正在搜索工作区…')}
        </p>
      ) : (
        <>
          <p className="file-search-summary" role="status">
            {t('找到 {0} 项', [result.matches.length])}
          </p>
          {result.matches.length ? (
            result.matches.map((match) => (
              <button
                key={match.path + ':' + match.line}
                disabled={disabled || futurePreview(match.path)}
                aria-label={match.path + (match.line ? ':' + match.line : '')}
                title={match.path + (futurePreview(match.path) ? t(' · 即将提供') : '')}
                onClick={() =>
                  void open(match.path, match.line).catch((e) => setError(String(e.message ?? e)))
                }
              >
                <Icon name="file" size={14} />
                <span>
                  <strong>
                    {match.path}
                    {match.line ? ':' + match.line : ''}
                  </strong>
                  {match.text !== undefined && <small>{match.text}</small>}
                </span>
              </button>
            ))
          ) : (
            <p className="panel-empty">{t('没有匹配的文件')}</p>
          )}
          {result.truncated && (
            <p className="file-search-summary" role="status">
              {t('搜索范围不完整：{0}', [result.reasons.map(reason).join('；')])}
            </p>
          )}
        </>
      )}
    </section>
  );
}
