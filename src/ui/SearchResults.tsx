import React, { useEffect, useRef, useState } from 'react';
import type { SearchPage, SearchHit } from '../shared/contracts.ts';
import { api, ApiError } from './api.ts';

export function SearchResults({
  query,
  archived = false,
  sessionId,
  choose,
  report,
}: {
  query: string;
  archived?: boolean;
  sessionId?: string;
  choose: (hit: SearchHit) => void;
  report: (error: unknown) => void;
}) {
  const [page, setPage] = useState<SearchPage>({ hits: [], cursor: null });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const route = `/sessions/search?q=${encodeURIComponent(query.trim())}&archived=${archived}${sessionId ? '&sessionId=' + encodeURIComponent(sessionId) : ''}`;
  useEffect(() => {
    const version = ++generation.current;
    setPage({ hits: [], cursor: null });
    setError('');
    setBusy(!!query.trim());
    if (!query.trim()) return;
    const timer = setTimeout(() => {
      void api<SearchPage>(route)
        .then((result) => {
          if (generation.current === version) setPage(result);
        })
        .catch((e) => {
          if (generation.current === version) setError(e.message);
        })
        .finally(() => {
          if (generation.current === version) setBusy(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [route, retry]);
  async function more() {
    if (!page.cursor || busy) return;
    const version = generation.current;
    setBusy(true);
    try {
      const next = await api<SearchPage>(route + '&cursor=' + encodeURIComponent(page.cursor));
      if (generation.current === version)
        setPage((previous) => ({ hits: [...previous.hits, ...next.hits], cursor: next.cursor }));
    } catch (e) {
      if (generation.current !== version) return;
      if (e instanceof ApiError && e.code === 'SEARCH_CURSOR_EXPIRED') {
        report(e);
        setRetry((x) => x + 1);
      } else setError(e instanceof Error ? e.message : '搜索失败');
    } finally {
      if (generation.current === version) setBusy(false);
    }
  }
  return (
    <div className="search-results" aria-busy={busy}>
      <p className="search-count" role="status">
        {busy
          ? '正在搜索…'
          : page.hits.length
            ? `已载入 ${page.hits.length} 个命中`
            : '没有匹配的内容'}
      </p>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button onClick={() => setRetry((x) => x + 1)}>重试搜索</button>
        </div>
      )}
      {page.hits.map((hit) => (
        <button
          className="search-hit"
          key={hit.sessionId + ':' + hit.messageId}
          onClick={() => choose(hit)}
        >
          <b>{hit.title}</b>
          <span>
            {hit.snippet.slice(0, hit.matchStart)}
            <mark>{hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)}</mark>
            {hit.snippet.slice(hit.matchStart + hit.matchLength)}
          </span>
          <small>{hit.source === 'title' ? '会话标题' : `消息 ${hit.position}`}</small>
        </button>
      ))}
      {page.cursor && (
        <button disabled={busy} className="history-more" onClick={() => void more()}>
          更多搜索结果
        </button>
      )}
    </div>
  );
}
