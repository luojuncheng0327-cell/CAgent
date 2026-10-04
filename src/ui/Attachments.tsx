import { t } from './i18n.ts';
import React, { useEffect, useRef, useState } from 'react';
import type { Resource } from '../shared/contracts.ts';
import { ApiError } from './api.ts';
import { Icon } from './Marks.tsx';

function resourceDescription(resource: Resource) {
  if (resource.extraction)
    return t('{0}{1} · 已提取文字', [
      resource.extraction.format.toUpperCase(),
      resource.extraction.pages ? ' · ' + t('{0} 页', [resource.extraction.pages]) : '',
    ]);
  if (resource.image)
    return t('图片 · {0} × {1}{2}', [
      resource.image.width,
      resource.image.height,
      resource.image.frames > 1 ? ' · ' + t('{0} 帧', [resource.image.frames]) : '',
    ]);
  return resource.kind === 'image' ? t('图片') : t('文本');
}

export function ResourceLinks({
  ids,
  resources,
  sessionId,
  onSave,
  saveDisabled = false,
}: {
  ids: string[];
  resources: Resource[];
  sessionId: string;
  onSave?: (resource: Resource) => void;
  saveDisabled?: boolean;
}) {
  return (
    <div className="attachment-list">
      {ids.map((id) => {
        const r = resources.find((r) => r.id === id),
          url = `/api/v1/sessions/${sessionId}/resources/${id}/body`;
        return (
          <div className="attachment-card" key={id}>
            {r?.kind === 'image' && <img loading="lazy" src={url + '?inline=true'} alt={r.name} />}
            <a href={url} download={r?.name ?? id}>
              {r?.name ?? t('附件已失效（') + id + '）'}
            </a>
            {r && (
              <small>
                {r.bytes < 1024 ? r.bytes + t(' 字节') : (r.bytes / 1024).toFixed(1) + ' KiB'}
                {' · '}
                {resourceDescription(r)}
              </small>
            )}
            {r && onSave && (
              <button
                aria-label={t('保存到工作区 {0}', [r.name])}
                disabled={saveDisabled}
                onClick={() => onSave(r)}
              >
                {t('保存到工作区')}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
export function AttachmentPicker({
  sessionId,
  ids,
  resources,
  disabled,
  onChange,
  onUploaded,
  onBusy,
  children,
}: {
  children: React.ReactNode;
  sessionId: string;
  ids: string[];
  resources: Resource[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
  onUploaded: (resource: Resource) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [errors, setErrors] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null),
    latest = useRef(ids),
    sizes = useRef(new Map<string, number>());
  latest.current = ids;
  for (const resource of resources) sizes.current.set(resource.id, resource.bytes);
  useEffect(() => () => controller.current?.abort(), []);
  async function upload(files: File[]) {
    if (!files.length || disabled) return;
    if (controller.current) {
      setErrors((old) => [...old, t('附件正在上传，请完成后再添加')]);
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    onBusy(true);
    setErrors([]);
    try {
      for (const file of files) {
        if (abort.signal.aborted) break;
        try {
          if (latest.current.length >= 8) throw new Error(t('每条消息最多 8 个附件'));
          if (file.size > 4 * 1024 * 1024) throw new Error(t('文件超过 4 MiB'));
          const total = latest.current.reduce((sum, id) => sum + (sizes.current.get(id) ?? 0), 0);
          if (total + file.size > 16 * 1024 * 1024)
            throw new Error(t('每条消息的附件总计不能超过 16 MiB'));
          const response = await fetch(`/api/v1/sessions/${sessionId}/resources`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-File-Name': encodeURIComponent(file.name),
            },
            body: file,
            signal: abort.signal,
          });
          const result = await response.json();
          if (!response.ok) throw new ApiError(result.error.code, result.error.message);
          if (abort.signal.aborted) break;
          sizes.current.set(result.data.id, result.data.bytes);
          onUploaded(result.data);
          latest.current = [...latest.current, result.data.id];
          onChange(latest.current);
        } catch (e) {
          if (!abort.signal.aborted)
            setErrors((old) => [
              ...old,
              `${file.name}：${e instanceof Error ? e.message : t('上传失败')}`,
            ]);
        }
      }
    } finally {
      controller.current = null;
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <div
      className="attachment-picker"
      onPaste={(event) => {
        const files = [...event.clipboardData.files];
        if (!files.length) return;
        event.preventDefault();
        void upload(files);
      }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        void upload([...e.dataTransfer.files]);
      }}
    >
      <label
        className="button-file attach-trigger"
        title={busy ? t('正在保存附件…') : t('添加附件 / 拖入或粘贴文件')}
      >
        <Icon name={busy ? 'clock' : 'plus'} size={16} />
        <input
          aria-label={t('添加附件')}
          type="file"
          multiple
          disabled={disabled || busy}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            void upload(files);
          }}
        />
      </label>
      {children}
      {ids.length > 0 && (
        <div className="draft-attachments">
          {ids.map((id) => (
            <span key={id}>
              {resources.find((r) => r.id === id)?.name ?? t('失效附件')}
              {resources.find((r) => r.id === id)?.extraction && (
                <small>{resourceDescription(resources.find((r) => r.id === id)!)}</small>
              )}
              <button
                type="button"
                disabled={disabled || busy}
                aria-label={t('移除附件 ') + (resources.find((r) => r.id === id)?.name ?? id)}
                onClick={() => {
                  latest.current = ids.filter((x) => x !== id);
                  onChange(latest.current);
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {ids.some((id) => resources.find((r) => r.id === id)?.kind === 'document') && (
        <p className="muted">
          {t('文档仅发送提取的文字，不含图片和完整排版；扫描件请先进行 OCR。')}
        </p>
      )}
      {resources
        .filter((r) => ids.includes(r.id))
        .flatMap((r) =>
          (r.extraction?.warnings ?? []).map((warning, index) => (
            <p role="status" className="muted" key={r.id + ':' + index}>
              {r.name}：
              {warning.match(/^(\d+) 页没有可提取文字，可能是空白页或扫描图片$/)
                ? t('{0} 页没有可提取文字，可能是空白页或扫描图片', [warning.split(' ')[0]])
                : t(warning)}
            </p>
          )),
        )}
      {errors.map((error, i) => (
        <p role="alert" className="inline-error" key={i}>
          {error}
        </p>
      ))}
    </div>
  );
}
