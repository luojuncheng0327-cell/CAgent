import React, { useEffect, useId, useState } from 'react';
import type { Model, ContextUsage } from '../shared/contracts.ts';
import { api } from './api.ts';
import { t, currentLocaleTag } from './i18n.ts';

export function ContextMeter({
  sessionId,
  model,
  draft,
  attachmentIds,
  eventCursor,
  live,
}: {
  sessionId: string;
  model: Model | undefined;
  draft: string;
  attachmentIds: string[];
  eventCursor: number;
  live: string;
}) {
  const tooltipId = useId();
  const [usage, setUsage] = useState<ContextUsage | null>(null),
    [visible, setVisible] = useState(false),
    [failed, setFailed] = useState(false);
  const attachments = JSON.stringify(attachmentIds);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setVisible(false);
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, []);
  useEffect(() => {
    setFailed(false);
    if (!model) {
      setUsage(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<ContextUsage | null>(
        '/sessions/' + sessionId + '/context-usage',
        'POST',
        { text: draft, attachmentIds: JSON.parse(attachments) },
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) setUsage(result);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setUsage(null);
            setFailed(true);
          }
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [sessionId, model?.id, model?.revision, draft, attachments, eventCursor]);
  const used =
      model && usage?.modelId === model.id
        ? usage.estimatedTokens + Math.ceil(live.length / 2)
        : null,
    limit = model?.contextWindow ?? 0,
    percent = used !== null && limit > 0 ? (used / limit) * 100 : 0,
    available = limit - (model?.maxOutput ?? 0),
    level =
      used !== null && used >= available
        ? 'full'
        : used !== null && used >= available * 0.8
          ? 'near'
          : 'normal';
  const count = (value: number) => value.toLocaleString(currentLocaleTag());
  const description =
    used !== null
      ? t('上下文已用约 {0} / {1} token（{2}%）', [count(used), count(limit), percent.toFixed(1)])
      : !model
        ? t('请先选择聊天模型')
        : failed
          ? t('暂时无法估算上下文')
          : t('正在估算上下文…');
  return (
    <div
      className="context-meter"
      data-level={level}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) setVisible(false);
      }}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      <button
        type="button"
        aria-label={t('上下文用量')}
        aria-describedby={visible ? tooltipId : undefined}
        onClick={() => setVisible(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setVisible(false);
          }
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 20 20"
          role="progressbar"
          aria-label={t('上下文占用')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={used === null ? undefined : Math.min(100, Number(percent.toFixed(2)))}
          aria-valuetext={description}
        >
          <circle className="context-track" cx="10" cy="10" r="7" />
          <circle
            className="context-fill"
            cx="10"
            cy="10"
            r="7"
            pathLength="100"
            strokeDasharray={`${Math.min(100, percent)} 100`}
            transform="rotate(-90 10 10)"
          />
        </svg>
      </button>
      {visible && (
        <div className="context-tooltip" id={tooltipId} role="tooltip">
          <strong>{t('上下文用量')}</strong>
          <p>{description}</p>
          {model && <p>{t('预留输出：{0} token', [count(model.maxOutput)])}</p>}
          {used !== null && level !== 'normal' && <p>{t('输入接近上限，可先压缩上下文。')}</p>}
          <small>{t('按文本与附件估算，实际 token 数以模型返回为准。')}</small>
        </div>
      )}
    </div>
  );
}
