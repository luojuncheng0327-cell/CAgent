import { t, currentLocaleTag } from './i18n.ts';
import React, { useEffect, useState } from 'react';
import type { Bootstrap } from './api.ts';
import { api } from './api.ts';
import type { Usage } from '../shared/contracts.ts';

type Total = { known: number; unknown: number };
interface Report {
  rows: (Usage & { sessionTitle: string; status: string; purpose: string })[];
  requests: number;
  hasMore: boolean;
  before: string | null;
  totals: Record<'input' | 'output' | 'cached' | 'cost', Total>;
}
export function UsagePage({ data, report }: { data: Bootstrap; report: (error: unknown) => void }) {
  const [agentId, setAgentId] = useState(''),
    [modelId, setModelId] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [value, setValue] = useState<Report | null>(null),
    [busy, setBusy] = useState(false);
  const query = new URLSearchParams({
    ...(agentId ? { agentId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(from ? { from: new Date(from + 'T00:00:00Z').toISOString() } : {}),
    ...(to ? { to: new Date(to + 'T00:00:00Z').toISOString() } : {}),
  }).toString();
  useEffect(() => {
    let current = true;
    setBusy(true);
    void api<Report>('/usage?' + query)
      .then((r) => {
        if (current) setValue(r);
      })
      .catch(report)
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [query, report]);
  async function more() {
    if (!value?.before) return;
    setBusy(true);
    try {
      const next = await api<Report>(
        '/usage?' + query + '&before=' + encodeURIComponent(value.before),
      );
      setValue({ ...next, rows: [...value.rows, ...next.rows] });
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  const number = (n: number | null) =>
    n === null ? t('未知') : n.toLocaleString(currentLocaleTag(), { maximumFractionDigits: 6 });
  return (
    <section className="usage-page">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t('本机账本')}</p>
          <h1>{t('模型用量')}</h1>
          <p>
            {t(
              '含成功、失败、取消和上下文压缩请求。费用为保存时的价格估计，未返回的计数保留为未知。',
            )}
          </p>
        </div>
      </div>
      <div className="usage-filters">
        <label>
          {t('开始日期（UTC）')}
          <input
            aria-label={t('用量开始日期')}
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          {t('结束日期（UTC，不含）')}
          <input
            aria-label={t('用量结束日期')}
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <select
          aria-label={t('用量助手')}
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
        >
          <option value="">{t('所有助手')}</option>
          {data.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          aria-label={t('用量模型')}
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
        >
          <option value="">{t('所有模型')}</option>
          {data.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      {value && (
        <>
          <div className="usage-totals">
            {(['input', 'output', 'cached', 'cost'] as const).map((key, i) => (
              <article key={key}>
                <small>
                  {[t('输入 token'), t('输出 token'), t('缓存 token'), t('估算费用')][i]}
                </small>
                <b>{number(value.totals[key].known)}</b>
                <small>
                  {value.totals[key].unknown
                    ? t('{0} 笔未知，合计不完整', [value.totals[key].unknown])
                    : t('全部已知')}
                </small>
              </article>
            ))}
          </div>
          <p className="muted">
            {t('共')}
            {value.requests} {t('笔请求 · 价格币种由接口配置约定；账本不会进行汇率换算。')}
          </p>
          <div className="usage-table">
            <table>
              <thead>
                <tr>
                  {[
                    t('时间'),
                    t('会话 / 用途'),
                    t('模型'),
                    t('状态'),
                    t('输入'),
                    t('输出'),
                    t('缓存'),
                    t('费用'),
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {value.rows.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {new Date(u.createdAt).toLocaleString(currentLocaleTag(), {
                        timeZone: data.preferences.timezone,
                      })}
                    </td>
                    <td>
                      {u.sessionTitle}
                      <small>{u.purpose === 'compact' ? t('上下文压缩') : t('对话')}</small>
                    </td>
                    <td>{data.models.find((m) => m.id === u.modelId)?.name ?? u.modelId}</td>
                    <td>
                      {(
                        {
                          succeeded: t('成功'),
                          failed: t('失败'),
                          cancelled: t('取消'),
                          interrupted: t('中断'),
                          running: t('执行中'),
                          queued: t('排队'),
                          awaiting_approval: t('等待确认'),
                        } as Record<string, string>
                      )[u.status] ?? u.status}
                    </td>
                    {(['input', 'output', 'cached', 'cost'] as const).map((key) => (
                      <td key={key}>{number(u[key])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!value.rows.length && <p className="panel-empty">{t('当前范围没有用量记录')}</p>}
          {value.hasMore && (
            <button disabled={busy} onClick={() => void more()}>
              {t('加载更多记录')}
            </button>
          )}
        </>
      )}
      {busy && <p role="status">{t('正在读取用量…')}</p>}
    </section>
  );
}
