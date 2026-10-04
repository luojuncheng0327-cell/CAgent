import { useEffect, useState } from 'react';
import type { Session } from '../shared/contracts.ts';
import type { DirectoryPage } from '../shared/file-list.ts';
import { api, ApiError } from './api.ts';

const emptyPage: DirectoryPage = {
  entries: [],
  total: 0,
  offset: 0,
  nextCursor: null,
  truncated: false,
};
export function useDirectoryPage({
  session,
  folder,
  query = '',
  kind = 'all',
  limit = 100,
  refresh,
  enabled = true,
}: {
  session: Session;
  folder: string;
  query?: string;
  kind?: 'all' | 'directories';
  limit?: number;
  refresh: number;
  enabled?: boolean;
}) {
  const scope = JSON.stringify([
    session.id,
    session.workspace,
    session.directoryGrants,
    session.blockedDirectories,
    folder,
    query,
    kind,
    limit,
  ]);
  const [navigation, setNavigation] = useState<{
    scope: string;
    cursors: (string | undefined)[];
    index: number;
  }>({
    scope,
    cursors: [undefined],
    index: 0,
  });
  const index = navigation.scope === scope ? navigation.index : 0;
  const cursor = navigation.scope === scope ? navigation.cursors[index] : undefined;
  const key = scope + '|' + index;
  const [result, setResult] = useState<{
    key: string;
    data?: DirectoryPage;
    error?: ApiError;
    loading: boolean;
  }>({ key: '', loading: true });
  const [notice, setNotice] = useState({ scope: '', text: '' });
  useEffect(() => {
    if (!enabled || !session.workspace) return;
    if (navigation.scope !== scope) setNavigation({ scope, cursors: [undefined], index: 0 });
    const controller = new AbortController();
    let current = true;
    setResult((old) => ({ key, data: old.key === key ? old.data : undefined, loading: true }));
    const params = new URLSearchParams({
      path: folder,
      query,
      kind,
      limit: String(limit),
      workspace: session.workspace,
    });
    if (cursor) params.set('cursor', cursor);
    const timer = setTimeout(() => {
      void api<DirectoryPage>(
        `/sessions/${session.id}/files?${params}`,
        'GET',
        undefined,
        controller.signal,
      )
        .then((data) => {
          if (current) setResult({ key, data, loading: false });
        })
        .catch((error) => {
          if (!current) return;
          if (error instanceof ApiError && error.code === 'DIRECTORY_CURSOR_STALE' && cursor) {
            setNotice({ scope, text: '目录内容已变化，已回到第一页' });
            setNavigation({ scope, cursors: [undefined], index: 0 });
          } else setResult({ key, error, loading: false });
        });
    }, 100);
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [scope, key, cursor, enabled, refresh]);
  const visible = result.key === key;
  const page = visible ? (result.data ?? emptyPage) : emptyPage;
  const loading = enabled && (!visible || result.loading);
  return {
    page,
    loading,
    error: visible ? result.error : undefined,
    notice: notice.scope === scope ? notice.text : '',
    index,
    previous: () => {
      if (!loading && index > 0) setNavigation((old) => ({ ...old, index: old.index - 1 }));
    },
    next: () => {
      if (!loading && page.nextCursor)
        setNavigation((old) => ({
          scope,
          cursors: [
            ...(old.scope === scope ? old.cursors.slice(0, index + 1) : [undefined]),
            page.nextCursor!,
          ],
          index: index + 1,
        }));
    },
  };
}
export type DirectoryNavigation = ReturnType<typeof useDirectoryPage>;
