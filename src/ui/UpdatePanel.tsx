import React, { useEffect, useState } from 'react';
import type { UpdateState } from '../shared/updates.ts';
import { t } from './i18n.ts';

export function UpdatePanel({ banner = false }: { banner?: boolean }) {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    const desktop = window.cagent;
    if (!desktop) return;
    let active = true;
    let eventReceived = false;
    const unsubscribe = desktop.onUpdate((next) => {
      eventReceived = true;
      if (active) setState(next);
    });
    void desktop
      .updateStatus()
      .then((next) => {
        if (active && !eventReceived) setState(next);
      })
      .catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  if (
    !state ||
    (banner &&
      !['available', 'downloading', 'downloaded', 'installing'].includes(state.phase) &&
      !(state.phase === 'error' && state.version))
  )
    return null;
  const labels = {
    unsupported: '安装版支持应用内更新',
    idle: '启动后自动检查更新',
    checking: '正在检查更新…',
    current: '已是最新版本',
    available: '发现新版本 {0}',
    downloading: '正在下载更新：{0}%',
    downloaded: '更新已下载，重启后安装',
    installing: '正在准备安装…',
    error: '更新失败，请检查网络后重试。',
  };
  const action = async (name: 'checkUpdate' | 'downloadUpdate' | 'installUpdate') => {
    try {
      await window.cagent?.[name]();
    } catch {
      setState((old) => old && { ...old, error: '更新失败，请检查网络后重试。' });
    }
  };
  return (
    <div
      className={banner ? 'update-banner' : 'settings-card update-panel'}
      aria-label={t('应用更新')}
    >
      {!banner && <p>{t('当前版本：{0}', [state.currentVersion])}</p>}
      <span role="status">
        {t(labels[state.phase], [
          state.phase === 'downloading' ? String(state.percent ?? 0) : (state.version ?? ''),
        ])}
      </span>
      {state.phase === 'downloading' && (
        <progress aria-label={t('更新下载进度')} max={100} value={state.percent ?? 0} />
      )}
      {state.error && state.phase !== 'error' && <p role="alert">{t(state.error)}</p>}
      {['idle', 'current', 'error'].includes(state.phase) && (
        <button onClick={() => void action('checkUpdate')}>{t('检查更新')}</button>
      )}
      {state.phase === 'available' && (
        <button onClick={() => void action('downloadUpdate')}>{t('下载更新')}</button>
      )}
      {state.phase === 'downloaded' && (
        <button onClick={() => void action('installUpdate')}>{t('重启安装')}</button>
      )}
    </div>
  );
}
