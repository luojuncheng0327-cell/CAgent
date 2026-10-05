import React, { useEffect, useState } from 'react';
import type { Session, WorkspacePreview } from '../shared/contracts.ts';
import { api } from './api.ts';
import { t } from './i18n.ts';
import { Modal } from './components.tsx';

export const canPreviewFile = (name: string) => /\.(png|jpe?g|gif|webp|pdf|docx)$/i.test(name);

export function FilePreview({
  session,
  path,
  onClose,
}: {
  session: Session;
  path: string;
  onClose: () => void;
}) {
  const name = path.split(/[\\/]/).at(-1) || path;
  const [value, setValue] = useState<WorkspacePreview | null>(null),
    [error, setError] = useState(''),
    [zoom, setZoom] = useState(1),
    [reload, setReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setValue(null);
    setError('');
    setZoom(1);
    void api<WorkspacePreview>(
      `/sessions/${session.id}/file-preview?${new URLSearchParams({ path, workspace: session.workspace ?? '' })}`,
      'GET',
      undefined,
      abort.signal,
    )
      .then((result) => {
        if (!abort.signal.aborted) setValue(result);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      });
    return () => abort.abort();
  }, [session.id, session.workspace, path, reload]);
  return (
    <Modal title={t('文件预览')} wide onClose={onClose}>
      <div className="workspace-file-preview">
        <div className="preview-heading">
          <strong title={path}>{name}</strong>
          <button onClick={() => setReload((n) => n + 1)}>{t('重新读取')}</button>
        </div>
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : !value ? (
          <p role="status">{t('正在读取文件预览…')}</p>
        ) : value.kind === 'image' ? (
          <>
            <div className="preview-controls" role="toolbar" aria-label={t('图片预览控制')}>
              <button
                aria-label={t('缩小预览')}
                disabled={zoom <= 0.25}
                onClick={() => setZoom((n) => Math.max(0.25, n - 0.25))}
              >
                −
              </button>
              <span aria-live="polite">{Math.round(zoom * 100)}%</span>
              <button
                aria-label={t('放大预览')}
                disabled={zoom >= 4}
                onClick={() => setZoom((n) => Math.min(4, n + 0.25))}
              >
                +
              </button>
              <button onClick={() => setZoom(1)}>{t('原始大小')}</button>
              <small>
                {t('图片 · {0} × {1}{2}', [
                  value.image.width,
                  value.image.height,
                  value.image.frames > 1 ? ' · ' + t('{0} 帧', [value.image.frames]) : '',
                ])}
              </small>
            </div>
            <div className="workspace-image-preview" tabIndex={0} aria-label={t('图片预览')}>
              <img
                src={value.imageUrl}
                alt={name}
                style={{ width: value.image.width * zoom, height: 'auto' }}
              />
            </div>
          </>
        ) : (
          <>
            <p className="muted">
              {value.extraction.format.toUpperCase()}
              {value.extraction.pages ? ' · ' + t('{0} 页', [value.extraction.pages]) : ''}
            </p>
            <p className="document-limit">
              {t('仅预览提取文字，不含图片和完整排版；扫描件请先进行 OCR。')}
            </p>
            {value.extraction.warnings.map((warning, i) => (
              <p role="status" className="muted" key={i}>
                {warning.match(/^(\d+) 页没有可提取文字，可能是空白页或扫描图片$/)
                  ? t('{0} 页没有可提取文字，可能是空白页或扫描图片', [warning.split(' ')[0]])
                  : t(warning)}
              </p>
            ))}
            <pre className="workspace-document-preview" tabIndex={0} aria-label={t('文档提取文字')}>
              {value.text}
            </pre>
          </>
        )}
      </div>
    </Modal>
  );
}
