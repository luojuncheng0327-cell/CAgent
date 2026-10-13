import { t } from './i18n.ts';
import { UsagePage } from './UsagePage.tsx';
import { ProfileEditor } from './ProfileEditor.tsx';
import { portraitSource } from './Marks.tsx';
import { UpdatePanel } from './UpdatePanel.tsx';
import React, { useEffect, useState } from 'react';
import type { Bootstrap } from './api.ts';
import { api } from './api.ts';
import type {
  Agent,
  Model,
  Provider,
  Protocol,
  Preferences,
  DiscoveredModel,
  ModelLimits,
} from '../shared/contracts.ts';
import {
  Field,
  Icon,
  Portrait,
  assistantPortrait,
  Modal,
  ProtocolSelect,
  protocolLabels,
  download,
} from './components.tsx';

export function Settings({
  data,
  refresh,
  close,
  report,
}: {
  data: Bootstrap;
  refresh: () => Promise<void>;
  close: () => void;
  report: (e: unknown) => void;
}) {
  const [tab, setTab] = useState('models');
  const tabs = [
    ['models', t('供应商')],
    ['agents', t('我的助手')],
    ['profile', t('我的资料')],
    ['appearance', t('界面外观')],
    ['data', t('数据管理')],
    ['about', t('关于 CAgent')],
  ];
  async function attempt(fn: () => Promise<unknown>) {
    try {
      await fn();
      await refresh();
    } catch (e) {
      report(e);
    }
  }
  const panels: Record<string, React.ReactNode> = {
    models: <ModelSettings data={data} attempt={attempt} report={report} />,
    usage: <UsagePage data={data} report={report} />,
    agents: <Agents data={data} attempt={attempt} refresh={refresh} />,
    profile: <ProfileEditor data={data} refresh={refresh} />,
    appearance: <Appearance data={data} attempt={attempt} />,
    data: <DataSettings attempt={attempt} report={report} />,
  };
  return (
    <Modal title={t('设置')} onClose={close} wide>
      <div className="settings-layout">
        <nav aria-label={t('设置分类')}>
          {tabs.map(([id, label]) => (
            <button
              key={id}
              className={tab === id || (id === 'models' && tab === 'usage') ? 'selected' : ''}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <section className="settings-body">
          {(tab === 'models' || tab === 'usage') && (
            <div className="provider-sections">
              <button onClick={() => setTab('models')}>{t('模型与接口')}</button>
              <button onClick={() => setTab('usage')}>{t('用量')}</button>
            </div>
          )}
          {panels[tab]}
          {tab === 'about' && (
            <div className="about">
              <div className="brand-mark">C</div>
              <h1>CAgent</h1>
              <p>{t('你的个人 AI 工作空间')}</p>
              <UpdatePanel />
              <div className="settings-card">
                <div className="setting-row">
                  <span>{t('维护者')}</span>
                  <span>{t('呈平安')}</span>
                </div>
                <div className="setting-row">
                  <span>{t('运行方式')}</span>
                  <span>{t('独立本机应用')}</span>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
function ModelSettings({
  data,
  attempt,
  report,
}: {
  data: Bootstrap;
  attempt: (fn: () => Promise<unknown>) => Promise<void>;
  report: (e: unknown) => void;
}) {
  const [editing, setEditing] = useState<Provider | null>(null),
    [deletingProvider, setDeletingProvider] = useState<Provider | null>(null),
    [deleting, setDeleting] = useState(false),
    [showProvider, setShowProvider] = useState(false),
    [model, setModel] = useState<Model | null>(null),
    [showModel, setShowModel] = useState(false),
    [probe, setProbe] = useState(''),
    [discovered, setDiscovered] = useState<{
      providerId: string;
      models: DiscoveredModel[];
    } | null>(null);
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>{t('模型与接口')}</h2>
          <p>{t('选择你信任的服务，自由配置模型。')}</p>
        </div>
        <button
          onClick={() => {
            setEditing(null);
            setShowProvider(true);
          }}
        >
          <Icon name="plus" />
          {t('添加接口')}
        </button>
      </div>
      {data.providers.length === 0 && <p className="muted">{t('还没有连接的接口。')}</p>}
      {data.providers.map((p) => (
        <div className="settings-card" key={p.id}>
          <div className="setting-row">
            <div className="grow">
              <b>{p.name}</b>
              <small>
                {protocolLabels[p.protocol]} · {p.hasKey ? t('已保存凭据') : t('未设置凭据')}
              </small>
            </div>
            <button
              className="text-button"
              onClick={() =>
                void api<any>(`/providers/${p.id}/discover`, 'POST', {})
                  .then((result) => setDiscovered({ providerId: p.id, models: result.models }))
                  .catch(report)
              }
            >
              {t('获取模型')}
            </button>
            <button
              className="text-button"
              onClick={() => {
                setEditing(p);
                setShowProvider(true);
              }}
            >
              {t('编辑')}
            </button>
            <button
              className="text-button danger"
              aria-label={t('删除接口：{0}', [p.name])}
              disabled={!!probe || deleting || data.runs.some((run) => run.providerId === p.id)}
              onClick={() => setDeletingProvider(p)}
            >
              {t('删除接口')}
            </button>
          </div>
          <div className="provider-url">{p.baseUrl}</div>
          {data.models
            .filter((m) => m.providerId === p.id)
            .map((m) => (
              <div key={m.id} className="model-row">
                <div>
                  <strong>{m.name}</strong>
                  <small>
                    {m.model} · {Math.round(m.contextWindow / 1000)}
                    {t('k 上下文')}
                  </small>
                </div>
                <button
                  className="text-button"
                  onClick={() => {
                    setModel(m);
                    setShowModel(true);
                  }}
                >
                  {t('配置')}
                </button>
                <button
                  disabled={!!probe}
                  onClick={() => {
                    setProbe(m.id);
                    void api<any>(`/models/${m.id}/test`, 'POST', {})
                      .then((r) => report(t('连接成功：') + r.text))
                      .catch(report)
                      .finally(() => setProbe(''));
                  }}
                >
                  {probe === m.id ? t('测试中…') : t('测试连接')}
                </button>
              </div>
            ))}
        </div>
      ))}
      <button
        className="quiet full"
        disabled={!data.providers.length}
        onClick={() => {
          setModel(null);
          setShowModel(true);
        }}
      >
        <Icon name="plus" />
        {t('添加模型')}
      </button>
      {showProvider && (
        <ProviderEditor initial={editing} done={() => setShowProvider(false)} attempt={attempt} />
      )}
      {deletingProvider && (
        <Modal
          title={t('删除接口配置？')}
          onClose={() => {
            if (!deleting) setDeletingProvider(null);
          }}
        >
          <div className="editor-form">
            <p>
              <strong>{deletingProvider.name}</strong>
            </p>
            <p>
              {t(
                '将删除此接口的 URL、已保存的 Key、自定义请求头及 {0} 个模型。聊天历史保留，关联会话需要重新选择模型。',
                [
                  String(
                    data.models.filter((model) => model.providerId === deletingProvider.id).length,
                  ),
                ],
              )}
            </p>
            <div className="form-actions">
              <button disabled={deleting} onClick={() => setDeletingProvider(null)}>
                {t('取消')}
              </button>
              <button
                className="danger"
                disabled={deleting}
                onClick={() => {
                  setDeleting(true);
                  void attempt(async () => {
                    await api('/providers/' + deletingProvider.id, 'DELETE');
                    if (discovered?.providerId === deletingProvider.id) setDiscovered(null);
                    setDeletingProvider(null);
                    report(t('接口配置已删除'));
                  }).finally(() => setDeleting(false));
                }}
              >
                {deleting ? t('正在删除…') : t('确认删除')}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {showModel && (
        <ModelEditor
          data={data}
          initial={model}
          done={() => setShowModel(false)}
          attempt={attempt}
        />
      )}
      {discovered && (
        <Modal title={t('发现的模型')} onClose={() => setDiscovered(null)}>
          <div className="editor-form">
            {discovered.models.length ? (
              discovered.models.map((m) => (
                <div className="setting-row" key={m.model}>
                  <span>
                    {m.name}
                    <small>{m.model}</small>
                  </span>
                  <button
                    disabled={data.models.some(
                      (saved) =>
                        saved.providerId === discovered.providerId && saved.model === m.model,
                    )}
                    onClick={() =>
                      void attempt(async () => {
                        await api('/models', 'POST', { ...m, providerId: discovered.providerId });
                        report(t('模型已添加，可在配置中设置能力'));
                      })
                    }
                  >
                    {t('添加')}
                  </button>
                </div>
              ))
            ) : (
              <p>{t('供应商返回了空的模型列表，可以手动添加。')}</p>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
function ProviderEditor({
  initial,
  done,
  attempt,
}: {
  initial: Provider | null;
  done: () => void;
  attempt: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? ''),
    [url, setUrl] = useState(initial?.baseUrl ?? ''),
    [key, setKey] = useState(''),
    [clearKey, setClearKey] = useState(false),
    [protocol, setProtocol] = useState<Protocol>(initial?.protocol ?? 'openai-responses'),
    [headers, setHeaders] = useState(JSON.stringify(initial?.headers ?? {}, null, 2)),
    [busy, setBusy] = useState(false);
  return (
    <Modal title={initial ? t('编辑接口') : t('添加接口')} onClose={done}>
      <form
        className="editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void attempt(async () => {
            await api('/providers' + (initial ? '/' + initial.id : ''), initial ? 'PUT' : 'POST', {
              name,
              baseUrl: url,
              protocol,
              apiKey: key,
              clearKey,
              headers: JSON.parse(headers),
              revision: initial?.revision,
            });
            done();
          }).finally(() => setBusy(false));
        }}
      >
        <div className="form-grid">
          <Field label={t('接口名称')}>
            <input required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('接口协议')}>
            <ProtocolSelect value={protocol} onChange={setProtocol} />
          </Field>
        </div>
        <Field label={t('接口地址')}>
          <input
            required
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </Field>
        <Field
          label="API Key"
          hint={initial?.hasKey ? t('留空保留已保存的凭据') : t('无需凭据的本地服务可留空')}
        >
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        {initial?.hasKey && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={clearKey}
              onChange={(e) => setClearKey(e.target.checked)}
            />
            {t('清除已保存的凭据')}
          </label>
        )}
        <details>
          <summary>{t('自定义请求头')}</summary>
          <Field label={t('JSON 对象')} hint={t('请求头的值与密钥一样加密保存。')}>
            <textarea rows={4} value={headers} onChange={(e) => setHeaders(e.target.value)} />
          </Field>
        </details>
        <div className="form-actions">
          <button type="button" onClick={done}>
            {t('取消')}
          </button>
          <button className="primary" disabled={busy}>
            {busy ? t('保存中…') : t('保存接口')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function ModelEditor({
  data,
  initial,
  done,
  attempt,
}: {
  data: Bootstrap;
  initial: Model | null;
  done: () => void;
  attempt: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [value, setValue] = useState({
    providerId: initial?.providerId ?? data.providers[0]?.id ?? '',
    name: initial?.name ?? '',
    model: initial?.model ?? '',
    contextWindow: initial?.contextWindow ?? 128000,
    maxOutput: initial?.maxOutput ?? 4096,
    reasoning: initial?.reasoning ?? [],
    reasoningMap: initial?.reasoningMap ?? {},
    defaultReasoning: initial?.defaultReasoning ?? 'off',
    supportsTools: initial?.supportsTools ?? true,
    supportsImages: initial?.supportsImages ?? false,
    inputPrice: initial?.inputPrice ?? null,
    outputPrice: initial?.outputPrice ?? null,
    cachedInputPrice: initial?.cachedInputPrice ?? null,
  });
  const [mapping, setMapping] = useState(JSON.stringify(value.reasoningMap)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [limits, setLimits] = useState<ModelLimits | null>(null),
    [checkingLimits, setCheckingLimits] = useState(false),
    [checkVersion, setCheckVersion] = useState(0);
  useEffect(() => {
    setLimits(null);
    const modelId = value.model.trim();
    if (!value.providerId || !modelId) {
      setCheckingLimits(false);
      return;
    }
    const controller = new AbortController();
    setCheckingLimits(true);
    const timer = setTimeout(() => {
      void api<ModelLimits>(
        '/providers/' + value.providerId + '/model-limits',
        'POST',
        { model: modelId },
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) setLimits(result);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setLimits({ contextWindow: null, maxOutput: null, source: null, sourceUrl: null });
        })
        .finally(() => {
          if (!controller.signal.aborted) setCheckingLimits(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value.providerId, value.model, checkVersion]);
  return (
    <Modal title={initial ? t('配置模型') : t('添加模型')} onClose={done}>
      <form
        className="editor-form"
        onChange={() => setError('')}
        onInvalid={(e) => {
          const control = e.target as HTMLInputElement;
          setError(
            t('请检查“{0}”：{1}', [
              control.getAttribute('aria-label') ?? '',
              control.validationMessage,
            ]),
          );
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          setError('');
          setBusy(true);
          void attempt(async () => {
            try {
              let reasoningMap: unknown;
              try {
                reasoningMap = JSON.parse(mapping);
              } catch {
                throw new Error(t('出站参数映射必须是有效的 JSON 对象'));
              }
              await api('/models' + (initial ? '/' + initial.id : ''), initial ? 'PUT' : 'POST', {
                ...value,
                reasoningMap,
                revision: initial?.revision,
              });
              done();
            } catch (e) {
              setError(e instanceof Error ? e.message : t('保存失败，请重试'));
              throw e;
            }
          }).finally(() => setBusy(false));
        }}
      >
        <Field label={t('所属接口')}>
          <select
            value={value.providerId}
            onChange={(e) => setValue({ ...value, providerId: e.target.value })}
          >
            {data.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="form-grid">
          <Field label={t('显示名称')}>
            <input
              required
              value={value.name}
              onChange={(e) => setValue({ ...value, name: e.target.value })}
            />
          </Field>
          <Field label={t('模型 ID')}>
            <input
              required
              value={value.model}
              onChange={(e) => setValue({ ...value, model: e.target.value })}
            />
          </Field>
        </div>
        <div className="model-limits-note">
          <p role="status" aria-live="polite">
            {checkingLimits
              ? t('正在检查模型上限…')
              : limits
                ? limits.source
                  ? t('上下文上限：{0} token；输出上限：{1} token', [
                      limits.contextWindow?.toLocaleString() ?? t('未知'),
                      limits.maxOutput?.toLocaleString() ?? t('未知'),
                    ])
                  : t('未查到模型上限，可手动填写；当前数值不会被自动修改。')
                : t('填写模型 ID 后自动检查上限。')}
          </p>
          {limits?.source && (
            <small>
              {limits.source === 'provider'
                ? t('来源：当前接口')
                : limits.source === 'mixed'
                  ? t('来源：当前接口与 DeepSeek 官方文档')
                  : t('来源：DeepSeek 官方文档')}
              {limits.sourceUrl && (
                <a href={limits.sourceUrl} target="_blank" rel="noreferrer">
                  {t('查看来源')}
                </a>
              )}
            </small>
          )}
          <div className="form-actions">
            <button
              type="button"
              disabled={checkingLimits || !value.model.trim()}
              onClick={() => setCheckVersion((version) => version + 1)}
            >
              {t('重新检查上限')}
            </button>
            <button
              type="button"
              disabled={checkingLimits || !limits?.source}
              onClick={() => {
                setError('');
                setValue((current) => ({
                  ...current,
                  contextWindow: limits?.contextWindow ?? current.contextWindow,
                  maxOutput: limits?.maxOutput ?? current.maxOutput,
                }));
              }}
            >
              {t('使用检测上限')}
            </button>
          </div>
        </div>
        <div className="form-grid">
          <Field label={t('上下文窗口')}>
            <input
              type="number"
              min={1}
              max={limits?.contextWindow ?? undefined}
              required
              value={value.contextWindow}
              onChange={(e) => setValue({ ...value, contextWindow: Number(e.target.value) })}
            />
          </Field>
          <Field label={t('最大输出 token')}>
            <input
              type="number"
              min={1}
              max={Math.min(limits?.maxOutput ?? Infinity, value.contextWindow - 1)}
              required
              value={value.maxOutput}
              onChange={(e) => setValue({ ...value, maxOutput: Number(e.target.value) })}
            />
          </Field>
        </div>
        <fieldset>
          <legend>{t('模型实际支持的推理档位')}</legend>
          <div className="checks">
            {(['low', 'medium', 'high', 'xhigh', 'max'] as const).map((level) => (
              <label key={level}>
                <input
                  type="checkbox"
                  checked={value.reasoning.includes(level)}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      reasoning: e.target.checked
                        ? [...value.reasoning, level]
                        : value.reasoning.filter((v) => v !== level),
                      defaultReasoning:
                        value.defaultReasoning === level ? 'off' : value.defaultReasoning,
                    })
                  }
                />
                {level}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label={t('默认推理档位')}>
          <select
            value={value.defaultReasoning}
            onChange={(e) => setValue({ ...value, defaultReasoning: e.target.value })}
          >
            {['off', ...value.reasoning].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </Field>
        <Field label={t('出站参数映射')} hint={t('例如 {"xhigh":"max"}；留 {} 表示原值发送。')}>
          <input value={mapping} onChange={(e) => setMapping(e.target.value)} />
        </Field>
        <label className="check-row">
          <input
            type="checkbox"
            checked={value.supportsTools}
            onChange={(e) => setValue({ ...value, supportsTools: e.target.checked })}
          />
          {t('允许工具调用')}
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={value.supportsImages}
            onChange={(e) => setValue({ ...value, supportsImages: e.target.checked })}
          />
          {t('此模型支持图片输入')}
        </label>
        <Field
          label={t('每百万缓存读取 token 价格')}
          hint={t('未知则留空；缺失用量、缓存计价或缓存写入费用时不会伪造总价。')}
        >
          <input
            type="number"
            min={0}
            step="any"
            value={value.cachedInputPrice ?? ''}
            onChange={(e) =>
              setValue({
                ...value,
                cachedInputPrice: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />
        </Field>
        <div className="form-grid">
          <Field label={t('每百万输入 token 价格')} hint={t('用于本机估算，留空表示未知。')}>
            <input
              type="number"
              min={0}
              step="any"
              value={value.inputPrice ?? ''}
              onChange={(e) =>
                setValue({
                  ...value,
                  inputPrice: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
          </Field>
          <Field label={t('每百万输出 token 价格')}>
            <input
              type="number"
              min={0}
              step="any"
              value={value.outputPrice ?? ''}
              onChange={(e) =>
                setValue({
                  ...value,
                  outputPrice: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
          </Field>
        </div>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" onClick={done}>
            {t('取消')}
          </button>
          <button className="primary" disabled={busy}>
            {busy ? t('保存中…') : t('保存模型')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Agents({
  data,
  attempt,
  refresh,
}: {
  data: Bootstrap;
  attempt: (fn: () => Promise<unknown>) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Agent | null | undefined>(undefined);
  const [profile, setProfile] = useState<Agent | null>(null);
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>{t('我的助手')}</h2>
          <p>{t('给不同工作选择各自的模型和说明。')}</p>
        </div>
        <button onClick={() => setEditing(null)}>
          <Icon name="plus" />
          {t('新建助手')}
        </button>
      </div>
      {data.agents.map((a) => (
        <div className="settings-card setting-row" key={a.id}>
          <Portrait
            name={a.name}
            size={36}
            src={portraitSource(a, data.preferences.primaryAgentId)}
          />
          <div className="grow">
            <b>{a.name}</b>
            <small>
              {data.models.find((m) => m.id === a.modelId)?.name ?? t('未选择默认模型')}
            </small>
          </div>
          <button onClick={() => setProfile(a)}>{t('资料与头像')}</button>
          <button onClick={() => setEditing(a)}>{t('编辑')}</button>
        </div>
      ))}
      {editing !== undefined && (
        <AgentEditor
          data={data}
          initial={editing}
          done={() => setEditing(undefined)}
          attempt={attempt}
        />
      )}
      {profile && (
        <Modal title={t('助手资料')} onClose={() => setProfile(null)}>
          <ProfileEditor data={data} agent={profile} refresh={refresh} />
        </Modal>
      )}
    </>
  );
}
function AgentEditor({
  data,
  initial,
  done,
  attempt,
}: {
  data: Bootstrap;
  initial: Agent | null;
  done: () => void;
  attempt: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? ''),
    [instructions, setInstructions] = useState(initial?.instructions ?? ''),
    [modelId, setModelId] = useState(initial?.modelId ?? ''),
    [memoryEnabled, setMemory] = useState(initial?.memoryEnabled ?? false);
  const [publicInstructions, setPublicInstructions] = useState(initial?.publicInstructions ?? ''),
    [disabledTools, setDisabledTools] = useState<string[]>(initial?.disabledTools ?? []);
  return (
    <Modal title={initial ? t('编辑助手') : t('新建助手')} onClose={done}>
      <form
        className="editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          void attempt(async () => {
            await api('/agents' + (initial ? '/' + initial.id : ''), initial ? 'PUT' : 'POST', {
              name,
              instructions,
              modelId: modelId || null,
              memoryEnabled,
              publicInstructions,
              disabledTools,
              description: initial?.description ?? '',
              revision: initial?.revision,
            });
            done();
          });
        }}
      >
        <Field label={t('名称')}>
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('默认模型')}>
          <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
            <option value="">{t('在会话中选择')}</option>
            {data.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('助手说明')}>
          <textarea
            rows={7}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </Field>
        <Field
          label={t('公开行为规则')}
          hint={t('本机对话同时使用两部分规则；公开渠道接入尚未开放。')}
        >
          <textarea
            rows={3}
            value={publicInstructions}
            onChange={(e) => setPublicInstructions(e.target.value)}
          />
        </Field>
        <fieldset>
          <legend>{t('允许的工具')}</legend>
          <div className="checks">
            {[
              'read_file',
              'list_files',
              'search_files',
              'write_file',
              'edit_file',
              'run_command',
              'memory_search',
              'memory_save',
            ].map((name) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={!disabledTools.includes(name)}
                  onChange={(e) =>
                    setDisabledTools(
                      e.target.checked
                        ? disabledTools.filter((t) => t !== name)
                        : [...disabledTools, name],
                    )
                  }
                />
                {name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="check-row">
          <input
            type="checkbox"
            checked={memoryEnabled}
            onChange={(e) => setMemory(e.target.checked)}
          />
          {t('使用为此助手保存的记忆')}
        </label>
        <div className="form-actions">
          {initial && (
            <button
              type="button"
              className="danger"
              disabled={data.agents.length <= 1}
              onClick={() => {
                if (window.confirm(t('删除此助手？历史会话仍可阅读，继续对话时需要指定新助手。')))
                  void attempt(async () => {
                    await api('/agents/' + initial.id, 'DELETE');
                    done();
                  });
              }}
            >
              {t('删除助手')}
            </button>
          )}
          <button type="button" onClick={done}>
            {t('取消')}
          </button>
          <button className="primary">{t('保存助手')}</button>
        </div>
      </form>
    </Modal>
  );
}
function Appearance({
  data,
  attempt,
}: {
  data: Bootstrap;
  attempt: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <>
      <h2>{t('界面外观')}</h2>
      <p className="muted">{t('安静的底色，适合长时间阅读。')}</p>
      <div className="settings-card">
        <div className="setting-row">
          <label htmlFor="theme-select">{t('主题')}</label>
          <select
            id="theme-select"
            value={data.preferences.theme}
            onChange={(e) =>
              void attempt(() =>
                api('/preferences', 'PUT', { ...data.preferences, theme: e.target.value }),
              )
            }
          >
            <option value="system">{t('跟随系统')}</option>
            <option value="light">{t('暖纸')}</option>
            <option value="dark">{t('青夜')}</option>
          </select>
        </div>
        <div className="setting-row">
          <label htmlFor="font-size">{t('正文字号')}</label>
          <input
            id="font-size"
            type="number"
            min={12}
            max={24}
            defaultValue={data.preferences.fontSize}
            onBlur={(e) => {
              if (Number(e.target.value) !== data.preferences.fontSize)
                void attempt(() =>
                  api('/preferences', 'PUT', {
                    ...data.preferences,
                    fontSize: Number(e.target.value),
                  }),
                );
            }}
          />
        </div>
        <div className="setting-row">
          <label htmlFor="reading-font">{t('正文字体')}</label>
          <select
            id="reading-font"
            value={data.preferences.fontFamily ?? 'serif'}
            onChange={(e) =>
              void attempt(() =>
                api('/preferences', 'PUT', { ...data.preferences, fontFamily: e.target.value }),
              )
            }
          >
            <option value="serif">{t('衬线')}</option>
            <option value="sans">{t('无衬线')}</option>
            <option value="mono">{t('等宽')}</option>
          </select>
        </div>
        <div className="setting-row">
          <label htmlFor="editor-size">{t('编辑器字号')}</label>
          <input
            id="editor-size"
            type="number"
            min={12}
            max={24}
            defaultValue={data.preferences.editorFontSize ?? 16}
            onBlur={(e) =>
              void attempt(() =>
                api('/preferences', 'PUT', {
                  ...data.preferences,
                  editorFontSize: Number(e.target.value),
                }),
              )
            }
          />
        </div>
        <div className="setting-row">
          <label htmlFor="editor-height">{t('编辑器行高')}</label>
          <input
            id="editor-height"
            type="number"
            min={1.2}
            max={2.5}
            step={0.1}
            defaultValue={data.preferences.editorLineHeight ?? 1.5}
            onBlur={(e) =>
              void attempt(() =>
                api('/preferences', 'PUT', {
                  ...data.preferences,
                  editorLineHeight: Number(e.target.value),
                }),
              )
            }
          />
        </div>
        <div className="setting-row">
          <label htmlFor="timezone">{t('显示时区')}</label>
          <input
            id="timezone"
            defaultValue={data.preferences.timezone}
            onBlur={(e) => {
              if (e.target.value !== data.preferences.timezone)
                void attempt(() =>
                  api('/preferences', 'PUT', { ...data.preferences, timezone: e.target.value }),
                );
            }}
          />
        </div>
        <div className="setting-row">
          <label htmlFor="auto-compact">
            {t('自动压缩上下文')}
            <small>{t('实验功能；接近上限时会额外调用当前模型，默认关闭。')}</small>
          </label>
          <input
            id="auto-compact"
            type="checkbox"
            checked={data.preferences.autoCompact ?? false}
            onChange={(e) =>
              void attempt(() =>
                api('/preferences', 'PUT', { ...data.preferences, autoCompact: e.target.checked }),
              )
            }
          />
        </div>
        <div className="setting-row">
          <label htmlFor="tool-rounds">{t('最大工具轮数')}</label>
          <input
            id="tool-rounds"
            type="number"
            min={1}
            max={32}
            defaultValue={data.preferences.maxToolRounds}
            onBlur={(e) =>
              void attempt(() =>
                api('/preferences', 'PUT', {
                  ...data.preferences,
                  maxToolRounds: Number(e.target.value),
                }),
              )
            }
          />
        </div>
        <div className="setting-row">
          <label htmlFor="network-retries">
            {t('网络自动重试次数')}
            <small>{t('仅在回复开始前重试；0 表示关闭，最多 3 次。')}</small>
          </label>
          <input
            id="network-retries"
            type="number"
            min={0}
            max={3}
            defaultValue={data.preferences.maxNetworkRetries}
            onBlur={(e) => {
              if (Number(e.target.value) !== data.preferences.maxNetworkRetries)
                void attempt(() =>
                  api('/preferences', 'PUT', {
                    ...data.preferences,
                    maxNetworkRetries: Number(e.target.value),
                  }),
                );
            }}
          />
        </div>
        <div className="setting-row">
          <label htmlFor="model-timeout">{t('模型超时（毫秒）')}</label>
          <input
            id="model-timeout"
            type="number"
            min={500}
            max={600000}
            defaultValue={data.preferences.requestTimeoutMs}
            onBlur={(e) =>
              void attempt(() =>
                api('/preferences', 'PUT', {
                  ...data.preferences,
                  requestTimeoutMs: Number(e.target.value),
                }),
              )
            }
          />
        </div>
        <div className="setting-row">
          <label htmlFor="interface-locale">{t('界面语言')}</label>
          <select
            id="interface-locale"
            value={data.preferences.locale}
            onChange={(e) =>
              void attempt(() =>
                api('/preferences', 'PUT', { ...data.preferences, locale: e.target.value }),
              )
            }
          >
            <option value="zh">简体中文</option>
            <option value="zh-TW">繁體中文</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
          </select>
        </div>
      </div>
    </>
  );
}
function DataSettings({
  attempt,
  report,
}: {
  attempt: (fn: () => Promise<unknown>) => Promise<void>;
  report: (e: unknown) => void;
}) {
  const [backup, setBackup] = useState<any>(null),
    [plan, setPlan] = useState<any>(null);
  return (
    <>
      <h2>{t('数据管理')}</h2>
      <p className="muted">{t('备份完整消息、附件字节、助手、模型配置和手工记忆。')}</p>
      <div className="settings-card">
        <div className="setting-row">
          <div>
            <b>{t('导出核心数据')}</b>
            <small>{t('含附件原文件；不含凭据、文件历史、用量账本；导入不授予工作区权限')}</small>
          </div>
          <button
            onClick={() =>
              void attempt(async () =>
                download('CAgent-backup.json', JSON.stringify(await api('/backup'), null, 2)),
              )
            }
          >
            {t('导出备份')}
          </button>
        </div>
        <div className="setting-row">
          <div>
            <b>{t('导入中立备份')}</b>
            <small>{t('先检查，再创建副本；不覆盖现有会话')}</small>
          </div>
          <label className="button-file">
            {t('选择文件')}
            <input
              type="file"
              accept=".json"
              onChange={async (e) => {
                try {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const parsed = JSON.parse(await file.text());
                  const result = await api('/backup/inspect', 'POST', parsed);
                  setBackup(parsed);
                  setPlan(result);
                } catch (error) {
                  report(error);
                }
              }}
            />
          </label>
        </div>
      </div>
      {plan && (
        <div className="import-plan">
          <h3>{t('导入预检')}</h3>
          <pre>{JSON.stringify(plan.counts, null, 2)}</pre>
          <p>{t('导入后需要重新设置凭据，并重新授权工作区。')}</p>
          <button
            className="primary"
            onClick={() =>
              void attempt(async () => {
                await api('/backup/import', 'POST', { backup, confirm: plan.sha256 });
                setPlan(null);
                setBackup(null);
                report(t('导入完成'));
              })
            }
          >
            {t('确认导入副本')}
          </button>
        </div>
      )}
      <p className="muted">{t('旧应用的数据不会自动迁入。旧格式迁移器尚未开放。')}</p>
    </>
  );
}
