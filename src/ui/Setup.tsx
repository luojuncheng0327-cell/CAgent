import React, { useEffect, useRef, useState } from 'react';
import type { Bootstrap } from './api.ts';
import { api } from './api.ts';
import type { Agent, Model, Preferences, Protocol, Provider } from '../shared/contracts.ts';
import { protocols } from '../shared/contracts.ts';
import { Field, Icon, Portrait, assistantPortrait, protocolLabels } from './components.tsx';
import { setupCopy, setupLanguages, setupProviders } from './setup-copy.ts';
import './setup.css';
import { SetupMenu } from './SetupMenu.tsx';
import { setLanguage } from './i18n.ts';

export function Setup({
  data,
  onDone,
  report,
}: {
  data: Bootstrap;
  onDone: () => Promise<void>;
  report: (error: unknown) => void;
}) {
  const [snapshot, setSnapshot] = useState(data);
  const current = useRef(data);
  const owner = data.agents.find((a) => a.id === data.preferences.primaryAgentId) ?? data.agents[0];
  const [step, setStep] = useState(data.preferences.setupStep);
  const [locale, setLocale] = useState(data.preferences.locale);
  const [userName, setUserName] = useState(data.preferences.userName);
  const [agentName, setAgentName] = useState(owner.name);
  const [memory, setMemory] = useState(owner.memoryEnabled);
  const initialProvider = data.providers[0];
  const [providerId, setProviderId] = useState<string | null>(initialProvider?.id ?? null);
  const [preset, setPreset] = useState('custom');
  const [providerName, setProviderName] = useState(initialProvider?.name ?? '');
  const [url, setUrl] = useState(initialProvider?.baseUrl ?? '');
  const [protocol, setProtocol] = useState<Protocol>(
    initialProvider?.protocol ?? 'openai-responses',
  );
  const [key, setKey] = useState(''),
    [showKey, setShowKey] = useState(false);
  const [discovered, setDiscovered] = useState<{ model: string; name: string }[]>([]);
  const [connection, setConnection] = useState('');
  const [mainId, setMainId] = useState(owner.modelId ?? data.models[0]?.id ?? '');
  const [smallId, setSmallId] = useState(data.preferences.smallToolModelId ?? '');
  const [largeId, setLargeId] = useState(data.preferences.largeToolModelId ?? '');
  const [adding, setAdding] = useState(false),
    [modelId, setModelId] = useState(''),
    [modelName, setModelName] = useState('');
  const [workspace, setWorkspace] = useState(
    data.preferences.defaultWorkspace ?? data.suggestedWorkspace,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null),
    body = useRef<HTMLDivElement>(null);
  const lock = useRef(false);
  const text = setupCopy(locale);
  const titles = ['welcome', 'identity', 'provider', 'models', 'workspace', 'ready'] as const;
  const hints = [
    'intro',
    'identityHint',
    'providerHint',
    'modelsHint',
    'workspaceHint',
    'readyHint',
  ] as const;
  useEffect(() => {
    setLanguage(locale);
  }, [locale]);
  useEffect(() => {
    body.current?.scrollTo(0, 0);
    heading.current?.focus();
  }, [step]);
  async function reload() {
    const fresh = await api<Bootstrap>('/bootstrap');
    current.current = fresh;
    setSnapshot(fresh);
    return fresh;
  }
  async function attempt(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : text('failed'));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function checkpoint(next: number, changes: Partial<Preferences> = {}) {
    const fresh = await reload();
    await api('/preferences', 'PUT', { ...fresh.preferences, ...changes, locale, setupStep: next });
    await reload();
    setStep(next);
  }
  async function saveProvider() {
    const fresh = await reload();
    const previous = fresh.providers.find((p) => p.id === providerId);
    const saved = await api<Provider>(
      '/providers' + (previous ? '/' + previous.id : ''),
      previous ? 'PUT' : 'POST',
      {
        ...(previous ?? {}),
        name: providerName,
        baseUrl: url,
        protocol,
        apiKey: key,
      },
    );
    setProviderId(saved.id);
    setKey('');
    setShowKey(false);
    await reload();
    return saved;
  }
  async function next() {
    for (const field of body.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      'input,select',
    ) ?? []) {
      if (!field.checkValidity()) {
        field.reportValidity();
        return;
      }
    }
    await attempt(async () => {
      if (step === 1) {
        const fresh = await reload();
        const agent = fresh.agents.find((a) => a.id === owner.id)!;
        await api('/agents/' + agent.id, 'PUT', {
          ...agent,
          name: agentName,
          memoryEnabled: memory,
        });
      }
      if (step === 2) await saveProvider();
      if (step === 3) {
        if (!mainId) throw new Error(text('noModels'));
        const fresh = await reload();
        const agent = fresh.agents.find((a) => a.id === owner.id)!;
        await api('/agents/' + agent.id, 'PUT', { ...agent, modelId: mainId });
      }
      let chosen = workspace;
      if (step === 4) {
        const result = await api<{ path: string }>('/setup/workspace', 'POST', {
          path: workspace,
          create: workspace === data.suggestedWorkspace,
        });
        chosen = result.path;
        setWorkspace(chosen);
      }
      if (step === 5) {
        const fresh = await reload();
        await api('/setup/complete', 'POST', { revision: fresh.preferences.revision });
        try {
          await onDone();
        } catch (error) {
          report(error);
          throw error;
        }
        return;
      }
      await checkpoint(step + 1, {
        userName,
        ...(step === 3
          ? { smallToolModelId: smallId || null, largeToolModelId: largeId || null }
          : {}),
        ...(step === 4 ? { defaultWorkspace: chosen } : {}),
      });
    });
  }
  function switchProvider(value: string) {
    setPreset(value);
    setKey('');
    setShowKey(false);
    setConnection('');
    setDiscovered([]);
    const saved = snapshot.providers.find((p) => p.id === value);
    const selected = setupProviders.find((p) => p.name === value);
    setProviderId(saved?.id ?? null);
    setProviderName(saved?.name ?? selected?.name ?? '');
    setUrl(saved?.baseUrl ?? selected?.url ?? '');
    setProtocol(saved?.protocol ?? selected?.protocol ?? 'openai-responses');
  }
  async function addModel(e: React.FormEvent) {
    e.preventDefault();
    await attempt(async () => {
      const fresh = await reload();
      const id = providerId ?? fresh.providers[0]?.id;
      if (fresh.models.some((m) => m.providerId === id && m.model === modelId.trim()))
        throw new Error(text('duplicate'));
      const saved = await api<Model>('/models', 'POST', {
        providerId: id,
        model: modelId,
        name: modelName.trim() || modelId,
      });
      if (!mainId) setMainId(saved.id);
      setAdding(false);
      setModelId('');
      setModelName('');
      await reload();
    });
  }
  function modelOptions() {
    return [
      { id: '', label: text('sameModel') },
      ...snapshot.models.map((m) => ({
        id: m.id,
        label: m.name + ' · ' + snapshot.providers.find((p) => p.id === m.providerId)?.name,
      })),
    ];
  }
  async function removeModel(model: Model) {
    await attempt(async () => {
      // Clear saved selections first. Unsaved selections are cleared only after
      // the server accepted the deletion; a failed delete keeps the draft.
      const fresh = await reload();
      const agent = fresh.agents.find((a) => a.id === owner.id)!;
      if (agent.modelId === model.id)
        await api('/agents/' + agent.id, 'PUT', { ...agent, modelId: null });
      await api('/preferences', 'PUT', {
        ...fresh.preferences,
        smallToolModelId:
          fresh.preferences.smallToolModelId === model.id
            ? null
            : fresh.preferences.smallToolModelId,
        largeToolModelId:
          fresh.preferences.largeToolModelId === model.id
            ? null
            : fresh.preferences.largeToolModelId,
      });
      await api('/models/' + model.id, 'DELETE');
      if (mainId === model.id) setMainId('');
      if (smallId === model.id) setSmallId('');
      if (largeId === model.id) setLargeId('');
      await reload();
    });
  }
  return (
    <main className="first-run" data-stage={step} aria-label="CAgent setup">
      <ol className="first-run-progress" aria-label={text('start')}>
        {titles.map((title, n) => (
          <li
            key={title}
            className={n < step ? 'done' : n === step ? 'current' : ''}
            aria-current={n === step ? 'step' : undefined}
          >
            <span className="sr-only">
              {n + 1}. {text(title)}
            </span>
          </li>
        ))}
      </ol>
      <div ref={body} className="first-run-content">
        {step === 0 && (
          <div className="first-run-portrait">
            <Portrait name="CAgent" src={assistantPortrait} size={86} />
          </div>
        )}
        <h1 ref={heading} tabIndex={-1}>
          {text(titles[step])}
        </h1>
        <p className="first-run-hint">{text(hints[step])}</p>
        <fieldset disabled={busy} className="first-run-fields">
          {step === 0 && (
            <>
              <div className="first-run-languages">
                {setupLanguages.map(([id, label]) => (
                  <button
                    type="button"
                    key={id}
                    lang={id}
                    aria-pressed={locale === id}
                    onClick={() => setLocale(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="first-run-scope">{text('languageScope')}</p>
            </>
          )}
          {step === 1 && (
            <div className="first-run-identity">
              <Field label={text('userName')}>
                <input
                  value={userName}
                  maxLength={120}
                  autoComplete="nickname"
                  onChange={(e) => setUserName(e.target.value)}
                />
              </Field>
              <Field label={text('agentName')}>
                <input
                  required
                  maxLength={120}
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                />
              </Field>
              <div className="first-run-memory">
                <div>
                  <h2>{text('memory')}</h2>
                  <p>{text('memoryHint')}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label={text('memory')}
                  aria-checked={memory}
                  onClick={() => setMemory(!memory)}
                  className="first-run-switch"
                >
                  <span />
                </button>
              </div>
            </div>
          )}
          {step === 2 && (
            <>
              <SetupMenu
                label={text('provider')}
                value={
                  snapshot.providers.some((p) => p.id === providerId) && preset === 'custom'
                    ? providerId!
                    : preset
                }
                onChange={switchProvider}
                disabled={busy}
                searchLabel={text('search')}
                emptyLabel={text('empty')}
                items={[
                  ...snapshot.providers.map((p) => ({ id: p.id, label: p.name })),
                  ...setupProviders.map((p) => ({ id: p.name, label: p.name })),
                  { id: 'custom', label: text('custom') },
                ]}
              />
              <div className="first-run-provider-row">
                <Field label={text('providerName')}>
                  <input
                    required
                    maxLength={120}
                    value={providerName}
                    onChange={(e) => {
                      setProviderName(e.target.value);
                      setConnection('');
                    }}
                  />
                </Field>
                <Field label={text('baseUrl')}>
                  <input
                    type="url"
                    required
                    value={url}
                    placeholder="https://api.example.com/v1"
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setConnection('');
                    }}
                  />
                </Field>
                <Field label={text('protocol')}>
                  <SetupMenu
                    label={text('protocol')}
                    value={protocol}
                    disabled={busy}
                    items={protocols.map((p) => ({ id: p, label: protocolLabels[p] }))}
                    onChange={(id) => {
                      setProtocol(id as Protocol);
                      setConnection('');
                    }}
                  />
                </Field>
              </div>
              <div className="field">
                <label htmlFor="setup-api-key">API Key</label>
                <div className="first-run-key">
                  <input
                    id="setup-api-key"
                    type={showKey ? 'text' : 'password'}
                    autoComplete="off"
                    placeholder={
                      snapshot.providers.find((p) => p.id === providerId)?.hasKey
                        ? text('storedKey')
                        : ''
                    }
                    value={key}
                    onChange={(e) => {
                      setKey(e.target.value);
                      setConnection('');
                    }}
                  />
                  <button
                    type="button"
                    aria-label={text(showKey ? 'hideKey' : 'showKey')}
                    aria-pressed={showKey}
                    onClick={() => setShowKey(!showKey)}
                  >
                    <Icon name="eye" />
                  </button>
                </div>
              </div>
              <p className="first-run-scope">{text('keyHint')}</p>
              <button
                type="button"
                disabled={!url.trim() || !providerName.trim()}
                onClick={() =>
                  void attempt(async () => {
                    const saved = await saveProvider();
                    const result = await api<{ models: typeof discovered }>(
                      '/providers/' + saved.id + '/discover',
                      'POST',
                    );
                    setDiscovered(result.models);
                    setConnection(text('connected') + ' · ' + result.models.length);
                  })
                }
              >
                {text('test')}
              </button>
              <small className="first-run-test-hint">{text('testHint')}</small>
              {connection && (
                <p role="status" className="first-run-success">
                  {connection}
                </p>
              )}
            </>
          )}
          {step === 3 && (
            <>
              <p className="first-run-model-count">
                {text('added')} <span>{snapshot.models.length}</span>
              </p>
              {!snapshot.models.length && <p className="first-run-scope">{text('noModels')}</p>}
              <div className="first-run-models">
                {snapshot.models.map((m) => (
                  <div key={m.id}>
                    <label>
                      <input
                        type="radio"
                        name="main-model"
                        value={m.id}
                        checked={mainId === m.id}
                        onChange={() => setMainId(m.id)}
                      />
                      <span>
                        {m.name}
                        <small>{m.model}</small>
                      </span>
                    </label>
                    {mainId === m.id && <small>{text('main')}</small>}
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={text('remove') + ' ' + m.name}
                      onClick={() => void removeModel(m)}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="first-run-add"
                aria-expanded={adding}
                onClick={() => setAdding(!adding)}
              >
                {text('addModel')}
                <Icon name="down" size={14} />
              </button>
              {adding && (
                <form className="first-run-model-form" onSubmit={(e) => void addModel(e)}>
                  <Field label={text('provider')}>
                    <select
                      value={providerId ?? snapshot.providers[0]?.id ?? ''}
                      onChange={(e) => setProviderId(e.target.value)}
                    >
                      {snapshot.providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={text('modelId')}>
                    <input
                      required
                      maxLength={120}
                      list="setup-model-suggestions"
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                    />
                  </Field>
                  <datalist id="setup-model-suggestions">
                    {discovered.map((m) => (
                      <option key={m.model} value={m.model}>
                        {m.name}
                      </option>
                    ))}
                  </datalist>
                  <Field label={text('displayName')}>
                    <input
                      maxLength={120}
                      value={modelName}
                      onChange={(e) => setModelName(e.target.value)}
                    />
                  </Field>
                  <div className="first-run-inline-actions">
                    <button type="button" onClick={() => setAdding(false)}>
                      {text('cancel')}
                    </button>
                    <button className="primary" disabled={!modelId.trim()}>
                      {text('add')}
                    </button>
                  </div>
                </form>
              )}
              <div className="first-run-roles">
                <Field label={text('small')}>
                  <SetupMenu
                    label={text('small')}
                    value={smallId}
                    items={modelOptions()}
                    disabled={busy || !snapshot.models.length}
                    onChange={setSmallId}
                  />
                </Field>
                <Field label={text('large')}>
                  <SetupMenu
                    label={text('large')}
                    value={largeId}
                    items={modelOptions()}
                    disabled={busy || !snapshot.models.length}
                    onChange={setLargeId}
                  />
                </Field>
                <p className="first-run-scope">{text('rolesHint')}</p>
              </div>
            </>
          )}
          {step === 4 && (
            <>
              <div className="first-run-workspace">
                <Icon name="folder" size={24} />
                <div>
                  <h2>
                    {text(
                      workspace === data.suggestedWorkspace
                        ? 'defaultWorkspace'
                        : 'chosenWorkspace',
                    )}
                  </h2>
                  <code>{workspace}</code>
                  <p>{text('workspaceNote')}</p>
                </div>
              </div>
              <div className="first-run-folder-actions">
                <button
                  type="button"
                  onClick={() =>
                    void attempt(async () => {
                      const chosen = await window.cagent?.chooseFolder();
                      if (chosen) setWorkspace(chosen);
                    })
                  }
                >
                  {text('chooseFolder')}
                </button>
                {workspace !== data.suggestedWorkspace && (
                  <button type="button" onClick={() => setWorkspace(data.suggestedWorkspace)}>
                    {text('resetFolder')}
                  </button>
                )}
              </div>
              {!window.cagent && (
                <Field label={text('path')}>
                  <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
                </Field>
              )}
            </>
          )}
          {step === 5 && (
            <>
              <div className="first-run-summary">
                <span>
                  {agentName}
                  {userName && ' · ' + userName}
                </span>
                <span>{snapshot.models.find((m) => m.id === mainId)?.name}</span>
                <code>{workspace}</code>
              </div>
              <div className="first-run-ready-cards">
                {[
                  ['memory', 'memory', 'memoryCard'],
                  ['tools', 'tools', 'toolsCard'],
                  ['folder', 'workspace', 'workspaceCard'],
                  ['note', 'notes', 'future'],
                  ['branch', 'collaboration', 'future'],
                ].map(([icon, title, hint]) => (
                  <article key={title} className={hint === 'future' ? 'upcoming' : ''}>
                    <h2>
                      <Icon name={icon} size={20} />
                      {text(title as Parameters<typeof text>[0])}
                    </h2>
                    <p>{text(hint as Parameters<typeof text>[0])}</p>
                  </article>
                ))}
              </div>
            </>
          )}
        </fieldset>
        {error && (
          <div className="first-run-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <footer className="first-run-actions">
        {step > 0 && (
          <button
            type="button"
            className="first-run-back"
            disabled={busy}
            onClick={() => void attempt(() => checkpoint(step - 1))}
          >
            {text('back')}
          </button>
        )}
        <button
          type="button"
          className="primary"
          disabled={
            busy ||
            (step === 1 && !agentName.trim()) ||
            (step === 2 && (!providerName.trim() || !url.trim())) ||
            (step === 3 && (!mainId || adding))
          }
          onClick={() => void next()}
        >
          {text(busy ? 'saving' : step === 0 ? 'start' : step === 5 ? 'finish' : 'next')}
        </button>
      </footer>
      {step === 0 && (
        <button type="button" disabled className="first-run-remote">
          {text('remote')}
        </button>
      )}
    </main>
  );
}
