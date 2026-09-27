import { useEffect, useState } from 'react';
import type { AutoUpdateState } from '../types';

function devWebPreviewState(): AutoUpdateState | null {
  if (!window.__HANA_DEV_WEB__) return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get('hana_update_preview') !== 'downloaded') return null;
  return {
    status: 'downloaded',
    version: params.get('hana_update_version') || '0.237.14',
    releaseNotes: null,
    releaseUrl: null,
    downloadUrl: null,
    progress: null,
    error: null,
    digest: {
      schemaVersion: 1,
      tag: `v${params.get('hana_update_version') || '0.237.14'}`,
      version: params.get('hana_update_version') || '0.237.14',
      previousTag: 'v0.237.13',
      generatedAt: new Date().toISOString(),
      noUserFacingChanges: false,
      summary: {
        zh: '这次更新整理了自动更新体验，并补上了国内镜像链路。',
        en: 'This update improves the updater experience and adds a domestic mirror path.',
      },
      counts: { feature: 1, fix: 1, improvement: 1, migration: 0 },
      items: [
        {
          id: 'preview-updater',
          kind: 'improvement',
          importance: 'high',
          title: { zh: '更新说明更清楚', en: 'Clearer update notes' },
          summary: {
            zh: 'About 页会显示这次版本带来的具体变化。',
            en: 'The About page can show what this version brings.',
          },
          details: [],
          sources: [],
        },
      ],
    },
    digestUrl: null,
    digestError: null,
    updateSource: { provider: 'github', owner: 'luojuncheng0327-cell', repo: 'CAgent' },
  };
}

export function useAutoUpdateState(): AutoUpdateState | null {
  const [state, setState] = useState<AutoUpdateState | null>(() => devWebPreviewState());

  useEffect(() => {
    const previewState = devWebPreviewState();
    if (previewState) {
      setState(previewState);
      const rerenderAfterLocaleLoad = window.setTimeout(() => setState({ ...previewState }), 500);
      return () => window.clearTimeout(rerenderAfterLocaleLoad);
    }

    let alive = true;

    window.hana?.autoUpdateState?.()
      .then((nextState) => {
        if (alive && nextState) {
          setState(nextState);
        }
      })
      .catch(() => {});

    const unsubscribe = window.hana?.onAutoUpdateState?.((nextState) => {
      setState(nextState);
    });

    return () => {
      alive = false;
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, []);

  return state;
}
