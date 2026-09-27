import React, { useState } from 'react';
import type { Bootstrap } from './api.ts';
import { api } from './api.ts';
import type { Agent, Model, Provider, Protocol, Preferences } from '../shared/contracts.ts';
import { Field, Icon, Modal, ProtocolSelect, protocolLabels, download } from './components.tsx';

export function Setup({
  data,
  onDone,
  report,
}: {
  data: Bootstrap;
  onDone: () => Promise<void>;
  report: (e: unknown) => void;
}) {
  const [name, setName] = useState('我的接口'),
    [url, setUrl] = useState(''),
    [key, setKey] = useState(''),
    [model, setModel] = useState(''),
    [protocol, setProtocol] = useState<Protocol>('openai-responses'),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const p = await api<Provider>('/providers', 'POST', {
        name,
        baseUrl: url,
        protocol,
        apiKey: key,
      });
      const m = await api<Model>('/models', 'POST', { providerId: p.id, name: model, model });
      const agent = data.agents[0];
      await api('/agents/' + agent.id, 'PUT', { ...agent, modelId: m.id });
      await api('/preferences', 'PUT', { ...data.preferences, setupComplete: true });
      await onDone();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="setup-shell">
      <div className="setup-card">
        <div className="brand-mark">C</div>
        <span className="eyebrow">CAgent · 初次见面</span>
        <h1>让工作，从这里开始。</h1>
        <p>连接你选择的模型，为自己建立一个安静的工作空间。</p>
        <form onSubmit={submit}>
          <div className="form-grid">
            <Field label="接口名称">
              <input required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="接口协议">
              <ProtocolSelect value={protocol} onChange={setProtocol} />
            </Field>
          </div>
          <Field
            label="接口地址"
            hint="填写供应商的 API 基础地址。本机模型可使用 http://127.0.0.1。"
          >
            <input
              type="url"
              required
              placeholder="https://api.example.com/v1"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
          <Field label="API Key" hint="凭据在本机加密保存。无需凭据的本地接口可留空。">
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
          <Field label="模型 ID">
            <input
              required
              placeholder="供应商提供的模型名称"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </Field>
          <button className="primary full" disabled={busy}>
            {busy ? '正在保存…' : '进入工作空间'}
            <Icon name="arrow" />
          </button>
        </form>
        <small className="setup-foot">会话与配置保存在你的设备上。</small>
      </div>
    </main>
  );
}

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
    ['models', '模型与接口'],
    ['agents', '我的助手'],
    ['appearance', '界面外观'],
    ['data', '数据管理'],
    ['about', '关于 CAgent'],
  ];
  async function attempt(fn: () => Promise<unknown>) {
    try {
      await fn();
      await refresh();
    } catch (e) {
      report(e);
    }
  }
  return (
    <Modal title="设置" onClose={close} wide>
      <div className="settings-layout">
        <nav aria-label="设置分类">
          {tabs.map(([id, label]) => (
            <button key={id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <section className="settings-body">
          {tab === 'models' && <ModelSettings data={data} attempt={attempt} report={report} />}
          {tab === 'agents' && <Agents data={data} attempt={attempt} />}
          {tab === 'appearance' && <Appearance data={data} attempt={attempt} />}
          {tab === 'data' && <DataSettings attempt={attempt} report={report} />}
          {tab === 'about' && (
            <div className="about">
              <div className="brand-mark">C</div>
              <h1>CAgent</h1>
              <p>你的个人 AI 工作空间</p>
              <span className="version">0.1.0 · 开发预览</span>
              <div className="settings-card">
                <div className="setting-row">
                  <span>维护者</span>
                  <span>呈平安</span>
                </div>
                <div className="setting-row">
                  <span>运行方式</span>
                  <span>独立本机应用</span>
                </div>
                <div className="setting-row">
                  <span>更新状态</span>
                  <span>尚无独立版发布</span>
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
    [showProvider, setShowProvider] = useState(false),
    [model, setModel] = useState<Model | null>(null),
    [showModel, setShowModel] = useState(false),
    [probe, setProbe] = useState(''),
    [discovered, setDiscovered] = useState<{
      providerId: string;
      models: { name: string; model: string }[];
    } | null>(null);
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>模型与接口</h2>
          <p>选择你信任的服务，自由配置模型。</p>
        </div>
        <button
          onClick={() => {
            setEditing(null);
            setShowProvider(true);
          }}
        >
          <Icon name="plus" />
          添加接口
        </button>
      </div>
      {data.providers.length === 0 && <p className="muted">还没有连接的接口。</p>}
      {data.providers.map((p) => (
        <div className="settings-card" key={p.id}>
          <div className="setting-row">
            <div className="grow">
              <b>{p.name}</b>
              <small>
                {protocolLabels[p.protocol]} · {p.hasKey ? '已保存凭据' : '未设置凭据'}
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
              获取模型
            </button>
            <button
              className="text-button"
              onClick={() => {
                setEditing(p);
                setShowProvider(true);
              }}
            >
              编辑
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
                    {m.model} · {Math.round(m.contextWindow / 1000)}k 上下文
                  </small>
                </div>
                <button
                  className="text-button"
                  onClick={() => {
                    setModel(m);
                    setShowModel(true);
                  }}
                >
                  配置
                </button>
                <button
                  disabled={!!probe}
                  onClick={() => {
                    setProbe(m.id);
                    void api<any>(`/models/${m.id}/test`, 'POST', {})
                      .then((r) => report('连接成功：' + r.text))
                      .catch(report)
                      .finally(() => setProbe(''));
                  }}
                >
                  {probe === m.id ? '测试中…' : '测试连接'}
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
        添加模型
      </button>
      {showProvider && (
        <ProviderEditor initial={editing} done={() => setShowProvider(false)} attempt={attempt} />
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
        <Modal title="发现的模型" onClose={() => setDiscovered(null)}>
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
                        report('模型已添加，可在配置中设置能力');
                      })
                    }
                  >
                    添加
                  </button>
                </div>
              ))
            ) : (
              <p>供应商返回了空的模型列表，可以手动添加。</p>
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
    <Modal title={initial ? '编辑接口' : '添加接口'} onClose={done}>
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
          <Field label="接口名称">
            <input required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="接口协议">
            <ProtocolSelect value={protocol} onChange={setProtocol} />
          </Field>
        </div>
        <Field label="接口地址">
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
          hint={initial?.hasKey ? '留空保留已保存的凭据' : '无需凭据的本地服务可留空'}
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
            清除已保存的凭据
          </label>
        )}
        <details>
          <summary>自定义请求头</summary>
          <Field label="JSON 对象" hint="请求头的值与密钥一样加密保存。">
            <textarea rows={4} value={headers} onChange={(e) => setHeaders(e.target.value)} />
          </Field>
        </details>
        <div className="form-actions">
          <button type="button" onClick={done}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '保存中…' : '保存接口'}
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
    [busy, setBusy] = useState(false);
  return (
    <Modal title={initial ? '配置模型' : '添加模型'} onClose={done}>
      <form
        className="editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void attempt(async () => {
            await api('/models' + (initial ? '/' + initial.id : ''), initial ? 'PUT' : 'POST', {
              ...value,
              reasoningMap: JSON.parse(mapping),
              revision: initial?.revision,
            });
            done();
          }).finally(() => setBusy(false));
        }}
      >
        <Field label="所属接口">
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
          <Field label="显示名称">
            <input
              required
              value={value.name}
              onChange={(e) => setValue({ ...value, name: e.target.value })}
            />
          </Field>
          <Field label="模型 ID">
            <input
              required
              value={value.model}
              onChange={(e) => setValue({ ...value, model: e.target.value })}
            />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="上下文窗口">
            <input
              type="number"
              min={1024}
              value={value.contextWindow}
              onChange={(e) => setValue({ ...value, contextWindow: Number(e.target.value) })}
            />
          </Field>
          <Field label="最大输出 token">
            <input
              type="number"
              min={16}
              value={value.maxOutput}
              onChange={(e) => setValue({ ...value, maxOutput: Number(e.target.value) })}
            />
          </Field>
        </div>
        <fieldset>
          <legend>模型实际支持的推理档位</legend>
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
        <Field label="默认推理档位">
          <select
            value={value.defaultReasoning}
            onChange={(e) => setValue({ ...value, defaultReasoning: e.target.value })}
          >
            {['off', ...value.reasoning].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </Field>
        <Field label="出站参数映射" hint={'例如 {"xhigh":"max"}；留 {} 表示原值发送。'}>
          <input value={mapping} onChange={(e) => setMapping(e.target.value)} />
        </Field>
        <label className="check-row">
          <input
            type="checkbox"
            checked={value.supportsTools}
            onChange={(e) => setValue({ ...value, supportsTools: e.target.checked })}
          />
          允许工具调用
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={value.supportsImages}
            onChange={(e) => setValue({ ...value, supportsImages: e.target.checked })}
          />
          此模型支持图片输入
        </label>
        <Field
          label="每百万缓存读取 token 价格"
          hint="未知则留空；缺失用量、缓存计价或缓存写入费用时不会伪造总价。"
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
          <Field label="每百万输入 token 价格" hint="用于本机估算，留空表示未知。">
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
          <Field label="每百万输出 token 价格">
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
        <div className="form-actions">
          <button type="button" onClick={done}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            保存模型
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Agents({
  data,
  attempt,
}: {
  data: Bootstrap;
  attempt: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = useState<Agent | null | undefined>(undefined);
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>我的助手</h2>
          <p>给不同工作选择各自的模型和说明。</p>
        </div>
        <button onClick={() => setEditing(null)}>
          <Icon name="plus" />
          新建助手
        </button>
      </div>
      {data.agents.map((a) => (
        <div className="settings-card setting-row" key={a.id}>
          <div className="avatar-small">{a.name.slice(0, 1)}</div>
          <div className="grow">
            <b>{a.name}</b>
            <small>{data.models.find((m) => m.id === a.modelId)?.name ?? '未选择默认模型'}</small>
          </div>
          <button onClick={() => setEditing(a)}>编辑</button>
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
    <Modal title={initial ? '编辑助手' : '新建助手'} onClose={done}>
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
              revision: initial?.revision,
            });
            done();
          });
        }}
      >
        <Field label="名称">
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="默认模型">
          <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
            <option value="">在会话中选择</option>
            {data.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="助手说明">
          <textarea
            rows={7}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </Field>
        <Field label="公开行为规则" hint="本机对话同时使用两部分规则；公开渠道接入尚未开放。">
          <textarea
            rows={3}
            value={publicInstructions}
            onChange={(e) => setPublicInstructions(e.target.value)}
          />
        </Field>
        <fieldset>
          <legend>允许的工具</legend>
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
          使用为此助手保存的记忆
        </label>
        <div className="form-actions">
          {initial && (
            <button
              type="button"
              className="danger"
              disabled={data.agents.length <= 1}
              onClick={() => {
                if (window.confirm('删除此助手？历史会话仍可阅读，继续对话时需要指定新助手。'))
                  void attempt(async () => {
                    await api('/agents/' + initial.id, 'DELETE');
                    done();
                  });
              }}
            >
              删除助手
            </button>
          )}
          <button type="button" onClick={done}>
            取消
          </button>
          <button className="primary">保存助手</button>
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
      <h2>界面外观</h2>
      <p className="muted">安静的底色，适合长时间阅读。</p>
      <div className="settings-card">
        <div className="setting-row">
          <label htmlFor="theme-select">主题</label>
          <select
            id="theme-select"
            value={data.preferences.theme}
            onChange={(e) =>
              void attempt(() =>
                api('/preferences', 'PUT', { ...data.preferences, theme: e.target.value }),
              )
            }
          >
            <option value="system">跟随系统</option>
            <option value="light">暖纸</option>
            <option value="dark">青夜</option>
          </select>
        </div>
        <div className="setting-row">
          <label htmlFor="font-size">正文字号</label>
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
          <label htmlFor="reading-font">正文字体</label>
          <select
            id="reading-font"
            value={data.preferences.fontFamily ?? 'serif'}
            onChange={(e) =>
              void attempt(() =>
                api('/preferences', 'PUT', { ...data.preferences, fontFamily: e.target.value }),
              )
            }
          >
            <option value="serif">衬线</option>
            <option value="sans">无衬线</option>
            <option value="mono">等宽</option>
          </select>
        </div>
        <div className="setting-row">
          <label htmlFor="editor-size">编辑器字号</label>
          <input
            id="editor-size"
            type="number"
            min={12}
            max={24}
            defaultValue={data.preferences.editorFontSize ?? 13}
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
          <label htmlFor="editor-height">编辑器行高</label>
          <input
            id="editor-height"
            type="number"
            min={1.2}
            max={2.5}
            step={0.1}
            defaultValue={data.preferences.editorLineHeight ?? 1.7}
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
          <label htmlFor="timezone">显示时区</label>
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
            自动压缩上下文<small>实验功能；接近上限时会额外调用当前模型，默认关闭。</small>
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
          <label htmlFor="tool-rounds">最大工具轮数</label>
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
          <label htmlFor="model-timeout">模型超时（毫秒）</label>
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
          <span>界面语言</span>
          <span>简体中文</span>
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
      <h2>数据管理</h2>
      <p className="muted">备份完整消息、附件字节、助手、模型配置和手工记忆。</p>
      <div className="settings-card">
        <div className="setting-row">
          <div>
            <b>导出核心数据</b>
            <small>含附件原文件；不含凭据、文件历史、用量账本；导入不授予工作区权限</small>
          </div>
          <button
            onClick={() =>
              void attempt(async () =>
                download('CAgent-backup.json', JSON.stringify(await api('/backup'), null, 2)),
              )
            }
          >
            导出备份
          </button>
        </div>
        <div className="setting-row">
          <div>
            <b>导入中立备份</b>
            <small>先检查，再创建副本；不覆盖现有会话</small>
          </div>
          <label className="button-file">
            选择文件
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
          <h3>导入预检</h3>
          <pre>{JSON.stringify(plan.counts, null, 2)}</pre>
          <p>导入后需要重新设置凭据，并重新授权工作区。</p>
          <button
            className="primary"
            onClick={() =>
              void attempt(async () => {
                await api('/backup/import', 'POST', { backup, confirm: plan.sha256 });
                setPlan(null);
                setBackup(null);
                report('导入完成');
              })
            }
          >
            确认导入副本
          </button>
        </div>
      )}
      <p className="muted">旧应用的数据不会自动迁入。旧格式迁移器尚未开放。</p>
    </>
  );
}
