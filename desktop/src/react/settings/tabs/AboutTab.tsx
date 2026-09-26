import { copyTextToClipboard } from '../../utils/clipboard';
import React, { useState, useCallback, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { autoSaveConfig, t } from '../helpers';
import { Toggle } from '@/ui';
import { loadSettingsConfig } from '../actions';
import { loadUpdateDigestHistory } from '../update-history-actions';
import { readConfigBoolean } from '../resource-state';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SettingsStack } from '../components/SettingsPrimitives';
import { ExpandableRow } from '../components/ExpandableRow';
import { digestLocale, digestText, kindLabel } from '../../components/shared/release-digest-text';
import { useAutoUpdateState } from '../../hooks/use-auto-update-state';
import { useTrainUpdateState } from '../../hooks/use-train-update-state';
import { ConfirmDialog, Overlay } from '../../ui';
import type { InviteChannelStatus, UpdateDigestHistoryResult } from '../../types';
import releaseSource from '../../../../../shared/release-source.cjs';
import appIconUrl from '../../../icon.png';
import styles from '../Settings.module.css';
import updateStyles from '../../components/AutoUpdateStatus.module.css';

const EMPTY_HISTORY: UpdateDigestHistoryResult = { entries: [], source: 'none', complete: false };

function UpdateHistoryDialog({
  open,
  loading,
  history,
  onClose,
}: {
  open: boolean;
  loading: boolean;
  history: UpdateDigestHistoryResult;
  onClose: () => void;
}) {
  const locale = digestLocale();
  const showNotice = !loading
    && history.entries.length > 0
    && (history.source !== 'online' || !history.complete);
  const noticeKey = history.source === 'bundled'
    ? 'settings.about.updateHistoryOffline'
    : history.source === 'online'
      ? 'settings.about.updateHistoryPartial'
      : 'settings.about.updateHistoryUnavailable';

  return (
    <Overlay
      scope="inline"
      open={open}
      onClose={onClose}
      backdrop="blur"
      zIndex={100}
      className={`${styles['memory-viewer']} ${styles['update-history-viewer']}`}
      backdropClassName={styles['memory-viewer-backdrop']}
      disableContainerAnimation
      contentProps={{
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'update-history-dialog-title',
      }}
    >
      <div className={styles['memory-viewer-header']}>
        <div>
          <h3 id="update-history-dialog-title" className={styles['memory-viewer-title']}>
            {t('settings.about.updateHistoryTitle')}
          </h3>
          <div className={styles['update-history-subtitle']}>
            {t('settings.about.updateHistorySubtitle')}
          </div>
        </div>
        <button
          type="button"
          className={styles['memory-viewer-close']}
          aria-label={t('settings.about.updateDigestClose')}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className={`${styles['memory-viewer-body']} ${styles['update-history-body']}`}>
        {loading && (
          <div className={styles['update-history-state']}>{t('settings.about.updateHistoryLoading')}</div>
        )}
        {showNotice && (
          <div className={styles['update-history-notice']}>{t(noticeKey)}</div>
        )}
        {!loading && history.entries.length === 0 && (
          <div className={styles['update-history-state']}>{t('settings.about.updateHistoryUnavailable')}</div>
        )}
        {!loading && history.entries.map((digest) => (
          <article key={digest.version} className={styles['update-history-release']}>
            <header className={styles['update-history-release-header']}>
              <h4 className={styles['update-history-version']}>v{digest.version}</h4>
            </header>
            <p className={styles['update-history-summary']}>{digestText(digest.summary, locale)}</p>
            {digest.items.length > 0 && (
              <div className={styles['update-history-items']}>
                {digest.items.map((item) => (
                  <section
                    key={`${digest.version}-${item.id || item.kind}-${item.title.en}`}
                    className={styles['update-history-item']}
                  >
                    <div className={styles['update-history-item-heading']}>
                      <span className={styles['update-history-kind']}>{kindLabel(item.kind)}</span>
                      <h5 className={styles['update-history-item-title']}>{digestText(item.title, locale)}</h5>
                    </div>
                    <p className={styles['update-history-item-summary']}>{digestText(item.summary, locale)}</p>
                  </section>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </Overlay>
  );
}

function updatePercentOf(progress: { receivedBytes: number; totalBytes: number } | null): number {
  if (!progress || !progress.totalBytes) return 0;
  return Math.max(0, Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100)));
}

function formatCheckedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

// 货架清单签发日期：只取日期，不带时间——这条是"清单本身多新"的中性背景
// 信息，不是"我刚检查过"那个已经有独立时间戳的结论（formatCheckedAt）。
function formatManifestDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString();
}

/**
 * 更新区状态机：四态互斥，phase 优先于 idle 分支——一轮检查/下载/应用
 * 正在进行时不该同时冒出"已是最新"这类只在真正 idle 时才成立的结论。
 * available 在 idle 分支里优先于 lastError：哪怕最近一次后台检查失败了，
 * 只要手头还攥着一个之前发现的可用更新，用户能做的动作就是去点它，
 * 不该被一条过期的错误信息挡住。
 */
function TrainUpdateArea({
  agentName,
  available,
  lastError,
  lastCheckedAt,
  manifestReleasedAt,
  phase,
  progress,
  onApply,
  onRetry,
}: {
  agentName: string;
  available: { version: string } | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  manifestReleasedAt: string | null;
  phase: 'idle' | 'checking' | 'downloading' | 'applying';
  progress: { receivedBytes: number; totalBytes: number } | null;
  onApply: () => void;
  onRetry: () => void;
}) {
  if (phase === 'checking') {
    return (
      <div className={updateStyles.root}>
        <div className={updateStyles.row}>
          <span className={updateStyles.message}>{t('settings.about.updateChecking')}</span>
        </div>
      </div>
    );
  }

  if (phase === 'downloading') {
    const percent = updatePercentOf(progress);
    return (
      <div className={updateStyles.root}>
        <div className={updateStyles.column}>
          <div className={updateStyles.downloadHeader}>
            <span className={updateStyles.message}>
              {t('settings.about.updateDownloading', { agentName })}
            </span>
            <span className={updateStyles.progressValue}>{t('settings.about.updateProgress', { percent })}</span>
          </div>
          <progress
            className={updateStyles.nativeProgress}
            aria-label={t('settings.about.updateDownloading', { agentName })}
            max={100}
            value={percent}
          />
        </div>
      </div>
    );
  }

  if (phase === 'applying') {
    return (
      <div className={updateStyles.root}>
        <div className={updateStyles.row}>
          <span className={updateStyles.message}>{t('settings.about.trainStickerApplying')}</span>
        </div>
      </div>
    );
  }

  // phase === 'idle' 以下——available 优先，其次 lastError，最后才是"已是最新"。
  if (available) {
    return (
      <div className={updateStyles.root}>
        <div className={updateStyles.row}>
          <span className={updateStyles.message}>{t('settings.about.updateAvailable', { version: available.version })}</span>
          <button type="button" className={updateStyles.action} onClick={onApply}>
            {t('settings.about.updateApply')}
          </button>
        </div>
      </div>
    );
  }

  if (lastError) {
    const sourceNotReady = /Gitee channel manifest request failed:.*HTTP 404\b/i.test(lastError);
    return (
      <div className={updateStyles.root}>
        <div className={updateStyles.column}>
          <div className={updateStyles.row} role="status">
            <span className={`${updateStyles.message}${sourceNotReady ? '' : ` ${updateStyles.error}`}`}>
              {t(sourceNotReady ? 'settings.about.updateSourceNotReady' : 'settings.about.updateError')}
            </span>
            <button type="button" className={updateStyles.action} onClick={onRetry}>
              {t('settings.about.updateRetryBtn')}
            </button>
          </div>
          {sourceNotReady && <span className={updateStyles.message}>{t('settings.about.updateSourceNotReadyHint')}</span>}
          <details className={updateStyles.errorDetails}>
            <summary>{t('settings.about.updateErrorDetails')}</summary>
            <pre>{lastError}</pre>
          </details>
        </div>
      </div>
    );
  }

  if (lastCheckedAt) {
    return (
      <div className={updateStyles.root}>
        <div className={updateStyles.row}>
          <span className={updateStyles.message}>
            {t('settings.about.updateLatestCheckedAt', { time: formatCheckedAt(lastCheckedAt) })}
          </span>
        </div>
        {/* 中性背景信息：货架清单本身的签发日期，不是告警。 */}
        {manifestReleasedAt && (
          <div className={updateStyles.row}>
            <span className={updateStyles.message}>
              {t('settings.about.updateManifestReleasedAt', { date: formatManifestDate(manifestReleasedAt) })}
            </span>
          </div>
        )}
      </div>
    );
  }

  // 从未检查过（既没有 available，也没有 lastError/lastCheckedAt）：不渲染
  // 任何结论性文案，只留下方的"检查更新"按钮可点。
  return null;
}

/**
 * 邀请制测试通道。三条纪律：
 *  1. 核销服务没配置（configured=false）就整块不渲染——正式构建在服务上线前
 *     看不到任何入口，而不是给出一个点了会报错的按钮。
 *  2. 核销成功只是拿到一个地址，绝不顺手落盘；写通道状态必须先过确认对话框。
 *  3. 失败文案只分两类：码本身不认（无效/用完）与够不着服务（网络/服务端），
 *     服务端原话原样附在下面，不美化、不重试。
 */
function InviteChannelSection() {
  const hana = window.hana;
  const shell = useAutoUpdateState();
  const [status, setStatus] = useState<InviteChannelStatus | null>(null);
  const [code, setCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [pending, setPending] = useState<{ feedUrl: string; inviteCodes: string[] } | null>(null);
  const [activating, setActivating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await hana?.inviteStatus?.();
        if (!cancelled && next) setStatus(next);
      } catch (err) {
        // 状态问不出来就不提供入口：宁可不露出一个行为不明的按钮，也不猜。
        console.error('[invite] failed to read the update channel status', err);
      }
    })();
    return () => { cancelled = true; };
  }, [hana]);

  const copyInviteCode = useCallback(async (value: string) => {
    if (!value) return;
    await copyTextToClipboard(value).catch(() => {
      useSettingsStore.getState().showToast(t('attach.copyFailed'), 'error');
    });
  }, []);

  const handleRedeem = useCallback(async () => {
    const trimmed = code.trim();
    if (!trimmed || redeeming) return;
    setRedeeming(true);
    setErrorKey(null);
    setErrorDetail(null);
    try {
      const result = await hana?.inviteRedeem?.(trimmed);
      if (!result) {
        setErrorKey('settings.about.inviteErrorNetwork');
        return;
      }
      if (result.ok) {
        setPending({ feedUrl: result.feedUrl, inviteCodes: result.childCodes });
        return;
      }
      // 只有"码本身不认"才归到邀请码文案；够不着服务的一律说是连接问题。
      setErrorKey(result.reason === 'invalid'
        ? 'settings.about.inviteErrorInvalid'
        : 'settings.about.inviteErrorNetwork');
      setErrorDetail(result.message || null);
    } catch (err) {
      setErrorKey('settings.about.inviteErrorNetwork');
      setErrorDetail(err instanceof Error ? err.message : String(err));
    } finally {
      setRedeeming(false);
    }
  }, [code, hana, redeeming]);

  const handleConfirmActivate = useCallback(async () => {
    if (!pending || activating) return;
    setActivating(true);
    try {
      const next = await hana?.inviteActivate?.(pending);
      if (next) setStatus(next);
      setPending(null);
      setCode('');
      setErrorKey(null);
      setErrorDetail(null);
    } catch (err) {
      setPending(null);
      setErrorKey('settings.about.inviteErrorActivate');
      setErrorDetail(err instanceof Error ? err.message : String(err));
    } finally {
      setActivating(false);
    }
  }, [activating, hana, pending]);

  if (!status?.configured) return null;

  return (
    <SettingsSection title={t('settings.about.inviteSectionTitle')}>
      {status.active ? (
        <>
          <SettingsRow
            label={t('settings.about.inviteChannelActive')}
            control={<span />}
          />
          <SettingsRow
            label={t('settings.about.platformCheckLabel')}
            hint={shell?.status === 'checking' ? t('settings.about.updateChecking')
              : shell?.status === 'available' || shell?.status === 'downloading'
                ? t('settings.about.updateAvailable', { version: shell?.version ?? '' })
                : shell?.status === 'downloaded'
                  ? t('settings.about.updateReadyInstall', { version: shell?.version ?? '' })
                  : shell?.status === 'error'
                    ? t('settings.about.updateError')
                    : undefined}
            control={
              <button
                type="button"
                className={styles['settings-btn-secondary']}
                onClick={() => { void hana?.autoUpdateCheck?.(); }}
                disabled={shell?.status === 'checking' || shell?.status === 'downloading'}
              >
                {t('settings.about.platformCheckBtn')}
              </button>
            }
          />
          {status.inviteCodes.length > 0 && (
            <SettingsRow
              label={t('settings.about.inviteCodesLabel')}
              hint={t('settings.about.inviteCodesHint')}
              layout="stacked"
              control={
                <SettingsStack gap="sm">
                  {status.inviteCodes.map((inviteCode) => (
                    <div key={inviteCode} className={styles['access-url-row']}>
                      <input className={styles['settings-input']} value={inviteCode} readOnly />
                      <button
                        type="button"
                        className={styles['settings-btn-secondary']}
                        onClick={() => { void copyInviteCode(inviteCode); }}
                      >
                        {t('settings.about.inviteCopy')}
                      </button>
                    </div>
                  ))}
                </SettingsStack>
              }
            />
          )}
        </>
      ) : (
        <SettingsRow
          label={t('settings.about.inviteCodeLabel')}
          hint={errorKey ? (
            <>
              <span>{t(errorKey)}</span>
              {errorDetail && <span title={errorDetail}> {errorDetail}</span>}
            </>
          ) : undefined}
          hintVariant={errorKey ? 'warn' : 'default'}
          layout="stacked"
          control={
            <div className={styles['access-url-row']}>
              <input
                className={styles['settings-input']}
                aria-label={t('settings.about.inviteCodeLabel')}
                placeholder={t('settings.about.inviteCodePlaceholder')}
                value={code}
                disabled={redeeming}
                onChange={(event) => setCode(event.target.value)}
              />
              <button
                type="button"
                className={styles['settings-btn-primary']}
                onClick={() => { void handleRedeem(); }}
                disabled={redeeming || !code.trim()}
              >
                {redeeming ? t('settings.about.inviteRedeeming') : t('settings.about.inviteRedeemBtn')}
              </button>
            </div>
          }
        />
      )}

      <ConfirmDialog
        open={Boolean(pending)}
        scope="inline"
        title={t('settings.about.inviteConfirmTitle')}
        confirmLabel={t('settings.about.inviteConfirmOk')}
        cancelLabel={t('settings.about.inviteConfirmCancel')}
        confirmTone="danger"
        busy={activating}
        onConfirm={() => { void handleConfirmActivate(); }}
        onCancel={() => setPending(null)}
      >
        {t('settings.about.inviteConfirmBody')}
      </ConfirmDialog>
    </SettingsSection>
  );
}

export function AboutTab() {
  const hana = window.hana;
  const settingsConfig = useSettingsStore(s => s.settingsConfig);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [history, setHistory] = useState<UpdateDigestHistoryResult>(EMPTY_HISTORY);
  const shellUpdate = useAutoUpdateState();
  const {
    currentVersion,
    available,
    minShellBlocked,
    lastError,
    lastCheckedAt,
    manifestReleasedAt,
    phase,
    progress,
    checkNow: checkTrainNow,
    applyNow: applyTrainNow,
  } = useTrainUpdateState();
  const isBeta = readConfigBoolean(settingsConfig, cfg => cfg.update_channel === 'beta', false);
  // 默认 true：老用户（preferences 里没写这个字段）保持原有"自动检查"行为
  const autoCheck = readConfigBoolean(settingsConfig, cfg => cfg.auto_check_updates, true);

  const handleCheck = useCallback(() => {
    void hana?.autoUpdateCheck?.();
    void checkTrainNow();
  }, [checkTrainNow, hana]);

  const handleApply = useCallback(() => {
    void applyTrainNow();
  }, [applyTrainNow]);

  const handleInstallShell = useCallback(async () => {
    await hana?.autoUpdateInstall?.();
  }, [hana]);

  const handleHistoryOpen = useCallback(async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      setHistory(await loadUpdateDigestHistory());
    } catch {
      setHistory(EMPTY_HISTORY);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const handleBetaToggle = useCallback(async (on: boolean) => {
    const channel = on ? 'beta' : 'stable';
    hana?.autoUpdateSetChannel?.(channel);
    await autoSaveConfig({ update_channel: channel }, { silent: true });
    await loadSettingsConfig();
    hana?.autoUpdateCheck?.();
    void checkTrainNow();
  }, [checkTrainNow, hana]);

  const handleAutoCheckToggle = useCallback(async (on: boolean) => {
    await autoSaveConfig({ auto_check_updates: on }, { silent: true });
    await loadSettingsConfig();
  }, []);

  // 平台更新条件行：仅当壳更新待命时出现，平时不渲染——一个
  // 一年两次的事件不该常年占一行。两层文案：minShell 真的挡住
  // 新列车时升级成更明确的警告措辞。这一行是唯一还会触发壳安装
  // （autoUpdateInstall）的地方——Hero 区的主更新按钮只会走 applyTrainNow。
  const showPlatformRow = shellUpdate?.status === 'downloaded';
  const platformRowLabel = minShellBlocked
    ? t('settings.about.shellStickerTitleBlocking')
    : t('settings.about.shellStickerTitle');

  // 忙碌（checking/downloading/applying）、已经有明确可用更新、或已经在
  // 展示带"重试"按钮的错误态时，这颗通用检查按钮就是多余的——要么已经在
  // 做同一件事，要么已经有一颗更贴切的按钮摆在上面了。只在"从未检查过"与
  // "已是最新"两种平静态下出现。
  const showCheckButton = phase === 'idle' && !available && !lastError;

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="about">
      {/* Hero：内容版本是唯一常规展示的版本号（单一源：useTrainUpdateState
          的 currentVersion，读自已激活内容，不是壳 package.json 版本）；
          更新主位是列车更新（check / "更新" 按钮 / 通道 / 历史，壳版本
          永不出现在这里）。 */}
      <div className={styles['about-hero']}>
        <img className={styles['about-icon']} src={appIconUrl} alt="HanaAgent" />
        <div className={styles['about-name']}>HanaAgent</div>
        <div className={styles['about-tagline']}>{t('settings.about.tagline')}</div>
        {currentVersion && <div className={styles['about-version']}>v{currentVersion}</div>}
        <TrainUpdateArea
          agentName={settingsConfig?.agent?.name || 'Hanako'}
          available={available}
          lastError={lastError}
          lastCheckedAt={lastCheckedAt}
          manifestReleasedAt={manifestReleasedAt}
          phase={phase}
          progress={progress}
          onApply={handleApply}
          onRetry={handleCheck}
        />
        <div className={styles['about-update-actions']}>
          {showCheckButton && (
            <button type="button" className={styles['about-check-update-btn']} onClick={handleCheck}>
              {t('settings.about.updateCheckBtn')}
            </button>
          )}
          <button type="button" className={styles['about-check-update-btn']} onClick={handleHistoryOpen}>
            {t('settings.about.updateHistoryTitle')}
          </button>
        </div>
      </div>

      {/* Info：许可证、版权、仓库和更新设置 +
          仅在壳更新待命时出现的条件行 */}
      <SettingsSection>
        <SettingsRow
          label={t('settings.about.license')}
          control={<span>Apache License 2.0</span>}
        />
        <SettingsRow
          label={t('settings.about.copyright')}
          control={<span>© 2026 @呈平安</span>}
        />
        <SettingsRow
          label="Gitee"
          control={
            <a
              className={styles['about-link']}
              href={releaseSource.repositoryUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                if (hana?.openExternal) {
                  e.preventDefault();
                  hana.openExternal(releaseSource.repositoryUrl);
                }
              }}
            >
              {releaseSource.repositoryUrl.replace(/^https:\/\//, '')}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          }
        />
        <SettingsRow
          label={t('settings.about.autoCheckUpdates')}
          control={<Toggle on={autoCheck} onChange={handleAutoCheckToggle} />}
        />
        <SettingsRow
          label={t('settings.about.betaUpdates')}
          control={<Toggle on={isBeta} onChange={handleBetaToggle} />}
        />
        {showPlatformRow && (
          <SettingsRow
            label={platformRowLabel}
            hint={shellUpdate?.version ? `v${shellUpdate.version}` : undefined}
            hintVariant={minShellBlocked ? 'warn' : 'default'}
            control={
              <button type="button" className={styles['about-check-update-btn']} onClick={handleInstallShell}>
                {t('settings.about.updateInstall')}
              </button>
            }
          />
        )}
      </SettingsSection>

      <InviteChannelSection />

      {/* License 全文：ExpandableRow 直接作为 tab 末尾元素 */}
      <ExpandableRow label={t('settings.about.licenseToggle')}>
        <pre className={styles['about-license-text']}>{LICENSE_TEXT}</pre>
      </ExpandableRow>

      <UpdateHistoryDialog
        open={historyOpen}
        loading={historyLoading}
        history={history}
        onClose={() => setHistoryOpen(false)}
      />
    </div>
  );
}

const LICENSE_TEXT = `Apache License, Version 2.0

Copyright 2026 liliMozi
Modifications Copyright 2026 @呈平安

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`;
