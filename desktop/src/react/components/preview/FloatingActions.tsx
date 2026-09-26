import { copyTextToClipboard } from '../../utils/clipboard';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import styles from './FloatingActions.module.css';
import { COVER_GALLERY_ITEMS, type CoverGalleryItem } from './cover-gallery-assets';
import {
  applyMarkdownCoverImage,
  applyMarkdownCoverPreset,
  dispatchCoverNotice,
  requestMarkdownCoverGeneration,
} from '../../utils/markdown-cover-generation';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { useStore } from '../../stores';
import { Tooltip } from '../../ui';
import { extOfName, inferKindByExt } from '../../utils/file-kind';
import type { RemoteContentRef, RemoteWorkbenchContentRef } from '../../types';
import {
  encodeWorkbenchContentPath,
  isRemoteWorkbenchContentRef,
  normalizeWorkbenchContentRef,
} from '../../utils/remote-file-preview';
import { refreshPreviewDocumentTarget } from '../../utils/preview-document-refresh';
import type {
  MarkdownCoverImageInput,
  MarkdownCoverTargetInput,
  WorkbenchMarkdownCoverTarget,
} from '../../utils/markdown-cover-generation';

interface Props {
  content: string;
  filePath?: string;
  contentType?: string;
  language?: string | null;
  remoteContentRef?: RemoteContentRef | null;
  showMarkdownPreviewToggle?: boolean;
  markdownPreviewActive?: boolean;
  onToggleMarkdownPreview?: () => void;
}

type CoverGenerationStatus = {
  enabled?: boolean;
  executorAgentId?: string | null;
  disabledReason?: string | null;
  message?: string | null;
  settingsTarget?: string | null;
};

type CoverStatus = {
  systemCover?: {
    available?: boolean;
  };
  agentGenerate?: CoverGenerationStatus;
  available?: boolean;
  enabled?: boolean;
  agentId?: string | null;
};

function getAgentGenerateDisabledText(status: CoverGenerationStatus): string {
  if (status.message) return status.message;
  const t = window.t ?? ((key: string) => key);
  switch (status.disabledReason) {
    case 'beautify-disabled':
      return t('cover.agentGenerate.beautifyDisabled');
    case 'default-image-model-missing':
      return t('cover.agentGenerate.defaultModelMissing');
    case 'default-image-model-invalid':
      return t('cover.agentGenerate.defaultModelInvalid');
    case 'image-generation-unavailable':
      return t('cover.agentGenerate.imageGenUnavailable');
    case 'agent-unavailable':
      return t('cover.agentGenerate.agentUnavailable');
    default:
      return t('cover.agentGenerate.disabled');
  }
}

function CoverPaletteIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5a8.5 8.5 0 0 0 0 17h1.4a1.55 1.55 0 0 0 1.1-2.65l-.18-.18a1.18 1.18 0 0 1 .83-2.02H17a4 4 0 0 0 4-4c0-4.5-3.86-8.15-9-8.15z" />
      <circle cx="7.7" cy="10.2" r="1" />
      <circle cx="10.2" cy="7.4" r="1" />
      <circle cx="14" cy="7.6" r="1" />
      <circle cx="16.7" cy="10.3" r="1" />
    </svg>
  );
}

function GenerateCoverIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.2 3.3L16.5 7.5l-3.3 1.2L12 12l-1.2-3.3-3.3-1.2 3.3-1.2L12 3z" />
      <path d="M18 13l.8 2.2L21 16l-2.2.8L18 19l-.8-2.2L15 16l2.2-.8L18 13z" />
      <path d="M6 14l.6 1.6L8.2 16.2l-1.6.6L6 18.4l-.6-1.6-1.6-.6 1.6-.6L6 14z" />
    </svg>
  );
}

function GalleryCoverIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="4" width="14" height="12" rx="1.5" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
      <path d="M8 12.8l2.5-2.4 2 1.8 2-2.2L17 12.8" />
    </svg>
  );
}

function UploadCoverIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15V4" />
      <path d="M8 8l4-4 4 4" />
      <path d="M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16" />
    </svg>
  );
}

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || 'cover.png';
}

function remoteRefToCoverTarget(ref: RemoteWorkbenchContentRef): WorkbenchMarkdownCoverTarget {
  const normalized = normalizeWorkbenchContentRef(ref);
  return {
    kind: 'workbench-file',
    mountId: normalized.mountId || normalized.rootId || 'default',
    subdir: normalized.subdir,
    name: normalized.name,
  };
}

function readBrowserFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('failed to read cover image'));
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',').pop() || '' : result);
    };
    reader.readAsDataURL(file);
  });
}

async function refreshCoverTargetPreview(target: MarkdownCoverTargetInput): Promise<void> {
  if ('filePath' in target && target.filePath) {
    await refreshPreviewDocumentTarget({ kind: 'local-file', filePath: target.filePath });
    return;
  }
  if ('target' in target && target.target) {
    const normalized = {
      kind: 'workbench-file' as const,
      mountId: target.target.mountId || target.target.rootId || 'default',
      rootId: target.target.rootId,
      subdir: target.target.subdir || '',
      name: target.target.name,
    };
    await refreshPreviewDocumentTarget({
      kind: 'workbench-file',
      target: {
        ...normalized,
        contentPath: encodeWorkbenchContentPath(normalized),
      },
    });
  }
}

export function FloatingActions({
  content,
  filePath,
  contentType,
  language,
  remoteContentRef,
  showMarkdownPreviewToggle = false,
  markdownPreviewActive = false,
  onToggleMarkdownPreview,
}: Props) {
  const [copyLabel, setCopyLabel] = useState<string | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverMenuOpen, setCoverMenuOpen] = useState(false);
  const [coverGalleryOpen, setCoverGalleryOpen] = useState(false);
  const [coverStatus, setCoverStatus] = useState<CoverStatus | null>(null);
  const [brokenCoverGalleryIds, setBrokenCoverGalleryIds] = useState<ReadonlySet<string>>(() => new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coverMenuRef = useRef<HTMLDivElement | null>(null);
  const floatingActionsRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { t } = useI18n();
  const coverTarget = useMemo<MarkdownCoverTargetInput | null>(() => {
    if (filePath) return { filePath };
    if (isRemoteWorkbenchContentRef(remoteContentRef)) {
      return { target: remoteRefToCoverTarget(remoteContentRef) };
    }
    return null;
  }, [filePath, remoteContentRef]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  useEffect(() => {
    if (!coverMenuOpen && !coverGalleryOpen) return;
    const close = (event: PointerEvent) => {
      if (floatingActionsRef.current?.contains(event.target as Node)) return;
      setCoverMenuOpen(false);
      setCoverGalleryOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [coverGalleryOpen, coverMenuOpen]);

  useEffect(() => {
    if (contentType !== 'markdown' || !coverTarget) {
      setCoverStatus(null);
      return;
    }
    let cancelled = false;
    hanaFetch('/api/desk/beautify/status')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setCoverStatus(data || null);
      })
      .catch(() => {
        if (!cancelled) setCoverStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [contentType, coverTarget]);

  const handleCopy = useCallback(() => {
    copyTextToClipboard(content).then(() => {
      const _t = window.t ?? ((p: string) => p);
      setCopyLabel(_t('attach.copied'));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopyLabel(null), 1500);
    }).catch(() => {
      useStore.getState().addToast(t('attach.copyFailed'), 'error');
    });
  }, [content, t]);

  const handleScreenshot = useCallback(async () => {
    const { takeArticleScreenshot } = await import('../../utils/screenshot');
    await takeArticleScreenshot(content, {
      filePath,
      articleType: contentType,
      language,
    });
  }, [content, contentType, filePath, language]);

  const coverNotice = useCallback((key: string, vars?: Record<string, string>) => {
    const translated = t(key, vars);
    return translated !== key ? translated : key;
  }, [t]);

  const handleGenerateCover = useCallback(async () => {
    const generationStatus = coverStatus?.agentGenerate ?? {};
    const generationEnabled = Boolean(generationStatus.enabled ?? coverStatus?.enabled);
    if (!coverTarget || contentType !== 'markdown' || !generationEnabled) return;
    setCoverMenuOpen(false);
    setCoverBusy(true);
    try {
      const executorAgentId = generationStatus.executorAgentId || coverStatus?.agentId || undefined;
      const result = await requestMarkdownCoverGeneration({ ...coverTarget, executorAgentId });
      dispatchCoverNotice(
        result.ok
          ? coverNotice('cover.notice.taskCreated')
          : coverNotice('cover.notice.generateFailed', { error: result.error || '' }),
        result.ok ? 'success' : 'error',
      );
    } catch (err) {
      dispatchCoverNotice(
        coverNotice('cover.notice.generateFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
        'error',
      );
    } finally {
      setCoverBusy(false);
    }
  }, [contentType, coverNotice, coverStatus, coverTarget]);

  const applySelectedCoverImage = useCallback(async (image: MarkdownCoverImageInput) => {
    if (!coverTarget) return;
    setCoverBusy(true);
    try {
      const result = await applyMarkdownCoverImage({ ...coverTarget, ...image });
      dispatchCoverNotice(
        result.ok
          ? coverNotice('cover.notice.applySuccess')
          : coverNotice('cover.notice.applyFailed', { error: result.error || '' }),
        result.ok ? 'success' : 'error',
      );
      if (result.ok) await refreshCoverTargetPreview(coverTarget);
    } catch (err) {
      dispatchCoverNotice(
        coverNotice('cover.notice.applyFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
        'error',
      );
    } finally {
      setCoverBusy(false);
    }
  }, [coverNotice, coverTarget]);

  const handleUploadCover = useCallback(async () => {
    if (!coverTarget || contentType !== 'markdown') return;
    setCoverMenuOpen(false);
    if (typeof window.platform?.selectFiles === 'function') {
      const paths = await window.platform.selectFiles();
      const imageFilePath = paths?.[0];
      if (!imageFilePath) return;
      const kind = inferKindByExt(extOfName(imageFilePath));
      if (kind !== 'image' && kind !== 'svg') {
        dispatchCoverNotice(coverNotice('cover.notice.selectImageFile'), 'error');
        return;
      }
      if ('filePath' in coverTarget && coverTarget.filePath) {
        await applySelectedCoverImage({ imageFilePath });
        return;
      }
      const contentBase64 = await window.platform.readFileBase64?.(imageFilePath);
      if (!contentBase64) {
        dispatchCoverNotice(coverNotice('cover.notice.readImageFailed'), 'error');
        return;
      }
      await applySelectedCoverImage({
        image: {
          filename: fileNameFromPath(imageFilePath),
          contentBase64,
        },
      });
      return;
    }
    fileInputRef.current?.click();
  }, [applySelectedCoverImage, contentType, coverNotice, coverTarget]);

  const handleBrowserCoverInputChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    if (!coverTarget) return;
    const file = event.currentTarget.files?.[0] || null;
    event.currentTarget.value = '';
    if (!file) return;
    const kind = inferKindByExt(extOfName(file.name));
    if (kind !== 'image' && kind !== 'svg') {
      dispatchCoverNotice(coverNotice('cover.notice.selectImageFile'), 'error');
      return;
    }
    try {
      const contentBase64 = await readBrowserFileAsBase64(file);
      if (!contentBase64) {
        dispatchCoverNotice(coverNotice('cover.notice.readImageFailed'), 'error');
        return;
      }
      await applySelectedCoverImage({
        image: {
          filename: file.name || 'cover.png',
          contentBase64,
        },
      });
    } catch (err) {
      dispatchCoverNotice(
        coverNotice('cover.notice.applyFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
        'error',
      );
    }
  }, [applySelectedCoverImage, coverNotice, coverTarget]);

  const handlePresetCover = useCallback(() => {
    setCoverMenuOpen(false);
    setCoverGalleryOpen(true);
  }, []);

  const handleApplyPresetCover = useCallback(async (item: CoverGalleryItem) => {
    if (!coverTarget || contentType !== 'markdown') return;
    setCoverBusy(true);
    try {
      const result = await applyMarkdownCoverPreset({ ...coverTarget, presetId: item.id });
      dispatchCoverNotice(
        result.ok
          ? coverNotice('cover.notice.applySuccessGallery', { title: item.title })
          : coverNotice('cover.notice.applyFailed', { error: result.error || '' }),
        result.ok ? 'success' : 'error',
      );
      if (result.ok) {
        await refreshCoverTargetPreview(coverTarget);
        setCoverGalleryOpen(false);
      }
    } catch (err) {
      dispatchCoverNotice(
        coverNotice('cover.notice.applyFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
        'error',
      );
    } finally {
      setCoverBusy(false);
    }
  }, [contentType, coverNotice, coverTarget]);

  const visibleCoverGalleryItems = useMemo(
    () => COVER_GALLERY_ITEMS.filter(item => !brokenCoverGalleryIds.has(item.id)),
    [brokenCoverGalleryIds],
  );

  const systemCoverAvailable = Boolean(coverStatus?.systemCover?.available ?? coverStatus?.available);
  const agentGenerateStatus = coverStatus?.agentGenerate ?? {};
  const agentGenerateEnabled = Boolean(agentGenerateStatus.enabled ?? coverStatus?.enabled);
  const agentGenerateDisabledText = getAgentGenerateDisabledText(agentGenerateStatus);
  const canSelectCoverFile = typeof window.platform?.selectFiles === 'function'
    || typeof window.FileReader === 'function';

  const handleCoverGalleryImageError = useCallback((itemId: string) => {
    setBrokenCoverGalleryIds((current) => {
      if (current.has(itemId)) return current;
      const next = new Set(current);
      next.add(itemId);
      return next;
    });
  }, []);

  const floatingActionsClassName = [
    styles.floatingActions,
    (coverMenuOpen || coverGalleryOpen || coverBusy || copyLabel) ? styles.floatingActionsPinned : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={floatingActionsClassName} data-react-managed ref={floatingActionsRef}>
      <div className={styles.floatingActionsSurface}>
        <button className={styles.actionBtn} onClick={handleCopy}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          <span>{copyLabel ?? t('attach.copy')}</span>
        </button>
        {contentType === 'markdown' && coverTarget && systemCoverAvailable && (
          <div className={styles.coverActionWrap} ref={coverMenuRef}>
            <Tooltip content={t('cover.make')} placement="top" align="end">
              {({ ref, ...tooltipProps }) => (
                <button
                  ref={(node) => ref(node)}
                  className={`${styles.actionBtn}${coverBusy ? ` ${styles.actionBtnBusy}` : ''}${coverMenuOpen ? ` ${styles.actionBtnActive}` : ''}`}
                  onClick={() => setCoverMenuOpen(open => !open)}
                  aria-label={t('cover.make')}
                  disabled={coverBusy}
                  {...tooltipProps}
                >
                  <CoverPaletteIcon />
                </button>
              )}
            </Tooltip>
            {coverMenuOpen && (
              <div className={styles.coverMenu}>
                <Tooltip
                  content={agentGenerateDisabledText}
                  disabled={agentGenerateEnabled}
                  placement="left"
                  align="center"
                >
                  {({ ref, ...tooltipProps }) => (
                    <span
                      className={styles.coverMenuTooltipAnchor}
                      ref={(node) => ref(node)}
                      {...tooltipProps}
                    >
                      <button
                        type="button"
                        onClick={handleGenerateCover}
                        disabled={coverBusy || !agentGenerateEnabled}
                      >
                        <span className={styles.coverMenuIcon}><GenerateCoverIcon /></span>
                        <span>{t('cover.agentGenerate.label')}</span>
                      </button>
                    </span>
                  )}
                </Tooltip>
                <button type="button" onClick={handlePresetCover}>
                  <span className={styles.coverMenuIcon}><GalleryCoverIcon /></span>
                  <span>{t('cover.gallery.title')}</span>
                </button>
                {canSelectCoverFile && (
                  <button type="button" onClick={handleUploadCover}>
                    <span className={styles.coverMenuIcon}><UploadCoverIcon /></span>
                    <span>{t('cover.gallery.upload')}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {coverGalleryOpen && (
          <div className={styles.coverGalleryCard} role="dialog" aria-label={t('cover.gallery.title')}>
            <div className={styles.coverGalleryHeader}>
              <div>
                <div className={styles.coverGalleryTitle}>{t('cover.gallery.title')}</div>
              </div>
              <button
                type="button"
                className={styles.coverGalleryClose}
                onClick={() => setCoverGalleryOpen(false)}
                aria-label={t('cover.gallery.close')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 6L6 18" />
                  <path d="M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className={styles.coverGalleryGrid}>
              {visibleCoverGalleryItems.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={styles.coverGalleryItem}
                  onClick={() => handleApplyPresetCover(item)}
                  disabled={coverBusy}
                  aria-label={item.title}
                  title={item.title}
                >
                  <span className={styles.coverGalleryThumb}>
                    <img
                      src={item.src}
                      alt=""
                      draggable={false}
                      loading="lazy"
                      decoding="async"
                      onError={() => handleCoverGalleryImageError(item.id)}
                    />
                  </span>
                  <span className={styles.coverGalleryName}>{item.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {filePath && (
          <Tooltip content={t('preview.fileHistory')} placement="top" align="end">
            {({ ref, ...tooltipProps }) => (
              <button
                ref={(node) => ref(node)}
                className={styles.actionBtn}
                onClick={() => useStore.getState().openFileHistoryForAbsolutePath(filePath)}
                aria-label={t('preview.fileHistory')}
                {...tooltipProps}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M12 7v5l3 3" />
                </svg>
              </button>
            )}
          </Tooltip>
        )}
        {showMarkdownPreviewToggle && (
          <Tooltip content={t(markdownPreviewActive ? 'preview.exitMarkdownPreview' : 'preview.markdownPreview')} placement="top" align="end">
            {({ ref, ...tooltipProps }) => (
              <button
                ref={(node) => ref(node)}
                className={`${styles.actionBtn}${markdownPreviewActive ? ` ${styles.actionBtnActive}` : ''}`}
                onClick={onToggleMarkdownPreview}
                aria-label={t('preview.markdownPreview')}
                {...tooltipProps}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            )}
          </Tooltip>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.svg"
          hidden
          onChange={handleBrowserCoverInputChange}
        />
        <Tooltip content={t('common.screenshot')} placement="top" align="end">
          {({ ref, ...tooltipProps }) => (
            <button
              ref={(node) => ref(node)}
              className={styles.actionBtn}
              onClick={handleScreenshot}
              aria-label={t('common.screenshot')}
              {...tooltipProps}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </button>
          )}
        </Tooltip>
      </div>
    </div>
  );
}
