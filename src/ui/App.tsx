import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Bootstrap, SessionDetail } from './api.ts';
import { api, ApiError, events } from './api.ts';
import type {
  Session,
  RunEvent,
  Run,
  Approval,
  Memory,
  Message,
  MessagePage,
  SearchHit,
  SessionOrder,
} from '../shared/contracts.ts';
import {
  Icon,
  Portrait,
  assistantPortrait,
  Modal,
  Field,
  Markdown,
  download,
} from './components.tsx';
import { Settings } from './Settings.tsx';
import { Setup } from './Setup.tsx';
import { AttachmentPicker, ResourceLinks } from './Attachments.tsx';
import { TopStrip, SessionRail, Soon } from './Shell.tsx';
import { Workspace, forgetWorkspaceDrafts } from './Workspace.tsx';
import { flushFileDrafts, hasPendingFileDrafts } from './file-draft-cache.ts';
import { ChoiceMenu } from './ChoiceMenu.tsx';
import { SearchResults } from './SearchResults.tsx';
import { DirectoryPermissions } from './DirectoryPermissions.tsx';

const reasoningNames: Record<string, string> = {
  off: '关闭',
  low: '较低',
  medium: '中等',
  high: '深度',
  xhigh: '更高',
  max: '最高',
};
const reasoningHints: Record<string, string> = {
  off: '使用模型默认',
  low: '简要思考',
  medium: '均衡处理',
  high: '更多思考',
  xhigh: '深入检查',
  max: '最高档位',
};

function activityText(activity: SessionDetail['activity']) {
  if (activity?.kind === 'model.retry') return '网络暂时不可用，将自动重试';
  if (activity?.kind === 'compact.progress')
    return `正在压缩（第 ${(activity.payload as { batch: number }).batch} 批）`;
  return '';
}

export function App() {
  const [data, setData] = useState<Bootstrap | null>(null),
    [auth, setAuth] = useState(false),
    [loading, setLoading] = useState(true),
    [token, setToken] = useState('');
  const [detail, setDetail] = useState<SessionDetail | null>(null),
    [sessionId, setSessionId] = useState<string | null>(null),
    [draft, setDraft] = useState('');
  const [settings, setSettings] = useState(false),
    [view, setView] = useState<'chat' | 'memory'>('chat'),
    [toast, setToast] = useState('');
  const [search, setSearch] = useState(''),
    [archived, setArchived] = useState(false),
    [sessions, setSessions] = useState<Session[]>([]),
    [right, setRight] = useState(true),
    [rail, setRail] = useState(true);
  const [workspace, setWorkspace] = useState(false),
    [workspaceValue, setWorkspaceValue] = useState(''),
    [confirm, setConfirm] = useState<{ title: string; action: () => Promise<void> } | null>(null);
  const [renaming, setRenaming] = useState(false),
    [newTitle, setNewTitle] = useState('');
  const [live, setLive] = useState({ text: '', reasoning: '' }),
    [active, setActive] = useState<Run | null>(null),
    [activity, setActivity] = useState(''),
    [connection, setConnection] = useState(''),
    [sending, setSending] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const [finding, setFinding] = useState(false),
    [findText, setFindText] = useState(''),
    [located, setLocated] = useState<string | null>(null);
  const searchJump = useRef(0);
  const orderQueue = useRef<Promise<void>>(Promise.resolve());
  const findEditor = useRef<HTMLInputElement>(null);
  const [directoryPermissions, setDirectoryPermissions] = useState(false);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]),
    [uploading, setUploading] = useState(false),
    [historyBusy, setHistoryBusy] = useState(false),
    [editing, setEditing] = useState<Message | null>(null),
    [editText, setEditText] = useState('');
  const currentAttachments = useRef<string[]>([]),
    transcript = useRef<HTMLDivElement>(null);
  const selected = useRef<string | null>(null),
    currentDetail = useRef<SessionDetail | null>(null),
    currentDraft = useRef(''),
    cursor = useRef(new Map<string, number>()),
    saving = useRef<Promise<void>>(Promise.resolve());
  const composeEditor = useRef<HTMLTextAreaElement>(null);
  const messagesEnd = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    initial = useRef(false);
  currentDetail.current = detail;
  currentDraft.current = draft;
  currentAttachments.current = attachmentIds;
  function attachmentsChanged(ids: string[]) {
    currentAttachments.current = ids;
    setAttachmentIds(ids);
  }
  const report = useCallback((error: unknown) => {
    setToast(
      typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : '操作失败，请重试',
    );
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 7000);
    return () => clearTimeout(t);
  }, [toast]);
  const refresh = useCallback(async () => {
    const next = await api<Bootstrap>('/bootstrap');
    setData(next);
    return next;
  }, []);
  const refreshList = useCallback(async () => {
    const result = await api<Session[]>(
      `/sessions?archived=${archived}&q=${encodeURIComponent(search)}`,
    );
    setSessions(result);
  }, [archived, search]);
  useEffect(() => {
    if (!data) return;
    const id = setTimeout(() => void refreshList().catch(report), 150);
    return () => clearTimeout(id);
  }, [data, refreshList, report]);
  const loadSession = useCallback(async (id: string, restoreDraft = false) => {
    const value = await api<SessionDetail>('/sessions/' + id);
    if (selected.current !== id) return;
    if (value.eventCursor < (cursor.current.get(id) ?? 0) && !restoreDraft) return;
    const previous = currentDetail.current;
    if (!restoreDraft && previous?.session.id === id) {
      value.messages = [
        ...new Map(
          [
            ...previous.messages,
            ...(previous.pagination.hasNewer
              ? value.messages.filter((m) => previous.messages.some((old) => old.id === m.id))
              : value.messages),
          ].map((m) => [m.id, m]),
        ).values(),
      ].sort((a, b) => a.position - b.position);
      value.pagination = {
        ...previous.pagination,
        total: value.pagination.total,
        corruptPositions: [
          ...new Set([
            ...previous.pagination.corruptPositions,
            ...value.pagination.corruptPositions,
          ]),
        ],
      };
    }
    currentDetail.current = value;
    setDetail(value);
    cursor.current.set(id, value.eventCursor);
    setLive(value.live);
    setActivity(activityText(value.activity));
    setActive(
      value.runs.find(
        (r) => !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(r.status),
      ) ?? null,
    );
    if (restoreDraft) {
      setDraft(value.session.draft);
      currentDraft.current = value.session.draft;
      attachmentsChanged(value.session.draftAttachmentIds ?? []);
    }
    return value;
  }, []);
  async function persistDraft() {
    const owner = currentDetail.current?.session,
      text = currentDraft.current,
      ids = currentAttachments.current;
    if (
      !owner ||
      (owner.draft === text &&
        JSON.stringify(owner.draftAttachmentIds ?? []) === JSON.stringify(ids))
    )
      return;
    const id = owner.id;
    saving.current = saving.current
      .catch(() => {})
      .then(async () => {
        const latest = currentDetail.current?.session;
        if (
          latest?.id !== id ||
          (latest.draft === text &&
            JSON.stringify(latest.draftAttachmentIds ?? []) === JSON.stringify(ids))
        )
          return;
        const saved = await api<Session>('/sessions/' + id, 'PATCH', {
          draft: text,
          draftAttachmentIds: ids,
          revision: latest.revision,
        });
        if (selected.current === id) {
          if (currentDetail.current)
            currentDetail.current = { ...currentDetail.current, session: saved };
          setDetail((previous) => (previous ? { ...previous, session: saved } : previous));
        }
      });
    await saving.current;
  }
  useEffect(() => {
    if (!detail || sending) return;
    const id = setTimeout(() => void persistDraft().catch(report), 450);
    return () => clearTimeout(id);
  }, [draft, attachmentIds, detail?.session.id, detail?.session.revision, sending]);
  useEffect(
    () =>
      window.cagent?.onFlush(async () => {
        await persistDraft();
        await flushFileDrafts();
      }),
    [],
  );
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (hasPendingFileDrafts()) {
        e.preventDefault();
        e.returnValue = '存在未保存的文件修改';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  async function selectSession(id: string) {
    if (uploading) return;
    setNavigating(true);
    try {
      await persistDraft();
      await flushFileDrafts();
      selected.current = id;
      setDirectoryPermissions(false);
      searchJump.current++;
      setFinding(false);
      setFindText('');
      setLocated(null);
      setDetail(null);
      setSessionId(id);
      setLive({ text: '', reasoning: '' });
      setActive(null);
      setView('chat');
      follow.current = true;
      await loadSession(id, true);
    } catch (e) {
      report(e);
    } finally {
      setNavigating(false);
    }
  }
  async function createSession(agentId?: string) {
    if (!data || navigating || uploading) return;
    setNavigating(true);
    try {
      await persistDraft();
      const agent =
        data.agents.find((a) => a.id === (agentId ?? data.preferences.primaryAgentId)) ??
        data.agents[0];
      const model = data.models.find((m) => m.id === agent.modelId) ?? data.models[0];
      const created = await api<Session>('/sessions', 'POST', {
        agentId: agent.id,
        modelId: model?.id ?? null,
        reasoning: model?.defaultReasoning ?? 'off',
      });
      await refresh();
      await selectSession(created.id);
    } catch (e) {
      report(e);
    } finally {
      setNavigating(false);
    }
  }
  async function authenticate(value: string) {
    await api('/auth', 'POST', { token: value });
    setToken('');
    setAuth(false);
    return refresh();
  }
  useEffect(() => {
    if (initial.current) return;
    initial.current = true;
    void (async () => {
      try {
        if (window.cagent) {
          const connection = await window.cagent.connection();
          await authenticate(connection.token);
        } else if (location.hash.startsWith('#token=')) {
          const value = decodeURIComponent(location.hash.slice(7));
          history.replaceState(null, '', location.pathname);
          await authenticate(value);
        }
        const next = await refresh();
        let first = next.sessions.find((s) => !s.archived);
        if (!first && next.preferences.setupComplete) {
          const owner =
            next.agents.find((a) => a.id === next.preferences.primaryAgentId) ?? next.agents[0];
          first = await api<Session>('/sessions', 'POST', {
            agentId: owner.id,
            modelId: owner.modelId,
          });
          await refresh();
        }
        if (first) {
          selected.current = first.id;
          setSessionId(first.id);
          await loadSession(first.id, true);
        }
      } catch (e) {
        if (e instanceof ApiError && e.code === 'UNAUTHORIZED') setAuth(true);
        else report(e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  useEffect(() => {
    if (!data) return;
    const root = document.documentElement;
    if (data.preferences.setupComplete) root.lang = 'zh-CN';
    const systemPalette = matchMedia('(prefers-color-scheme: dark)');
    const updatePalette = () => {
      const night =
        data.preferences.theme === 'dark' ||
        (data.preferences.theme === 'system' && systemPalette.matches);
      root.dataset.theme = night ? 'dark' : 'light';
      root.dataset.themeMode = data.preferences.theme;
    };
    updatePalette();
    root.style.setProperty('--text-base-size', data.preferences.fontSize + 'px');
    root.dataset.font = data.preferences.fontFamily ?? 'serif';
    systemPalette.addEventListener('change', updatePalette);
    return () => systemPalette.removeEventListener('change', updatePalette);
  }, [data?.preferences]);
  useEffect(() => {
    if (!sessionId || !detail || detail.session.id !== sessionId) return;
    const controller = new AbortController();
    const id = sessionId;
    let retry: ReturnType<typeof setTimeout> | undefined;
    function onEvent(event: RunEvent) {
      if (selected.current !== id || event.id <= (cursor.current.get(id) ?? 0)) return;
      cursor.current.set(id, event.id);
      const p = event.payload as any;
      if (event.kind === 'model.retry' || event.kind === 'compact.progress')
        setActivity(activityText(event));
      if (event.kind === 'text' || event.kind === 'reasoning' || event.kind === 'message')
        setActivity('');
      if (event.kind === 'run.running') {
        setActivity('');
        setActive((run) => (run?.id === event.runId ? { ...run, status: 'running' } : run));
      }
      if (event.kind === 'text') setLive((x) => ({ ...x, text: x.text + (p.text ?? '') }));
      if (event.kind === 'reasoning')
        setLive((x) => ({ ...x, reasoning: x.reasoning + (p.text ?? '') }));
      if (event.kind === 'message') {
        setDetail((x) =>
          x && x.session.id === id
            ? {
                ...x,
                messages: x.pagination.hasNewer
                  ? x.messages
                  : [...x.messages.filter((m) => m.id !== p.message.id), p.message],
              }
            : x,
        );
        setLive({ text: '', reasoning: '' });
      }
      if (event.kind === 'run.start') void loadSession(id).catch(report);
      if (event.kind === 'approval')
        setDetail((x) => (x ? { ...x, approvals: [...x.approvals, p.approval] } : x));
      if (event.kind === 'approval.resolved')
        setDetail((x) => (x ? { ...x, approvals: x.approvals.filter((a) => a.id !== p.id) } : x));
      if (event.kind === 'compact.end') void loadSession(id).catch(report);
      if (event.kind === 'tool.end') void loadSession(id).catch(report);
      if (event.kind === 'run.end') {
        setActivity('');
        setLive({ text: '', reasoning: '' });
        setActive(null);
        void loadSession(id).catch(report);
        void refresh().catch(report);
        if (p.error) report(p.error.message);
      }
    }
    async function connect() {
      try {
        setConnection('');
        await events(id, cursor.current.get(id) ?? 0, controller.signal, onEvent);
        if (!controller.signal.aborted) throw new Error('连接已断开');
      } catch (e) {
        if (controller.signal.aborted) return;
        setConnection('连接中断，正在重新连接…');
        retry = setTimeout(() => void connect(), 1500);
      }
    }
    void connect();
    return () => {
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, [sessionId, detail?.session.id]);
  useEffect(() => {
    if (follow.current) messagesEnd.current?.scrollIntoView({ block: 'end', behavior: 'instant' });
  }, [detail?.messages.length, live.text, active?.id]);
  async function patch(values: Record<string, unknown>) {
    if (!detail) return;
    if ('workspace' in values || 'directoryGrants' in values || 'permission' in values)
      await flushFileDrafts();
    const saved = await api<Session>('/sessions/' + detail.session.id, 'PATCH', {
      ...values,
      revision: detail.session.revision,
    });
    setDetail((d) => (d ? { ...d, session: saved } : d));
    await refresh();
  }
  async function send(retry = false) {
    if (!detail || (!draft.trim() && !attachmentIds.length && !retry) || sending || uploading)
      return;
    setSending(true);
    try {
      await persistDraft();
      const text = retry
        ? (detail.messages.filter((m) => m.role === 'user').at(-1)?.text ?? '')
        : draft;
      const run = await api<Run>(`/sessions/${detail.session.id}/runs`, 'POST', {
        text,
        attachmentIds,
        requestId: crypto.randomUUID(),
        retry,
      });
      if (run.sessionId !== detail.session.id) {
        await refresh();
        await selectSession(run.sessionId);
        return;
      }
      setActive(run);
      setDraft('');
      currentDraft.current = '';
      attachmentsChanged([]);
      setLive({ text: '', reasoning: '' });
      await loadSession(detail.session.id);
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      setSending(false);
    }
  }
  async function revise(message: Message, mode: 'edit' | 'retry', text?: string) {
    if (active || sending || uploading) return;
    setSending(true);
    try {
      await persistDraft();
      const run = await api<Run>(`/sessions/${message.sessionId}/revisions`, 'POST', {
        messageId: message.id,
        mode,
        text,
        requestId: crypto.randomUUID(),
      });
      setEditing(null);
      await refresh();
      await selectSession(run.sessionId);
    } catch (e) {
      report(e);
    } finally {
      setSending(false);
    }
  }
  async function moreHistory() {
    if (!detail || !detail.pagination.hasMore || historyBusy) return;
    const id = detail.session.id,
      el = transcript.current,
      height = el?.scrollHeight ?? 0,
      top = el?.scrollTop ?? 0;
    setHistoryBusy(true);
    follow.current = false;
    try {
      const page = await api<MessagePage>(
        `/sessions/${id}/messages?before=${detail.pagination.before}&limit=80`,
      );
      if (selected.current !== id) return;
      setDetail((previous) =>
        previous?.session.id === id
          ? {
              ...previous,
              messages: [
                ...new Map([...page.messages, ...previous.messages].map((m) => [m.id, m])).values(),
              ].sort((a, b) => a.position - b.position),
              pagination: {
                ...page,
                after: previous.pagination.after,
                hasNewer: previous.pagination.hasNewer,
                corruptPositions: [
                  ...new Set([...page.corruptPositions, ...previous.pagination.corruptPositions]),
                ],
              },
            }
          : previous,
      );
      requestAnimationFrame(() => {
        if (el) el.scrollTop = top + el.scrollHeight - height;
      });
    } catch (e) {
      report(e);
    } finally {
      setHistoryBusy(false);
    }
  }
  async function locateMessage(hit: SearchHit) {
    if (uploading) return;
    if (selected.current !== hit.sessionId) await selectSession(hit.sessionId);
    if (selected.current !== hit.sessionId) return;
    setView('chat');
    if (!hit.messageId) return;
    const version = ++searchJump.current;
    try {
      const page = await api<MessagePage>(
        `/sessions/${hit.sessionId}/messages?around=${encodeURIComponent(hit.messageId)}`,
      );
      if (selected.current !== hit.sessionId || version !== searchJump.current) return;
      if (!page.messages.some((m) => m.id === hit.messageId))
        throw new Error('此消息损坏，无法定位');
      follow.current = false;
      setAwayFromEnd(true);
      setLocated(hit.messageId);
      const previous = currentDetail.current;
      if (!previous || previous.session.id !== hit.sessionId) return;
      const next = { ...previous, messages: page.messages, pagination: page };
      currentDetail.current = next;
      setDetail(next);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const element = document.getElementById('message-' + hit.messageId);
          element?.scrollIntoView({ block: 'center' });
          element?.focus({ preventScroll: true });
        }),
      );
    } catch (e) {
      report(e);
    }
  }
  async function latestMessages() {
    const id = selected.current;
    if (!id) return;
    searchJump.current++;
    await persistDraft();
    follow.current = true;
    setAwayFromEnd(false);
    setLocated(null);
    await loadSession(id, true);
  }
  async function sortSessions(mode: 'updated' | 'manual') {
    if (!data) return;
    try {
      await api('/preferences', 'PUT', { ...data.preferences, sessionSort: mode });
      await refresh();
    } catch (e) {
      report(e);
    }
  }
  async function reorderSessions(bucket: 'pinned' | 'active' | 'archived', ids: string[]) {
    if (!data) return;
    orderQueue.current = orderQueue.current
      .catch(() => {})
      .then(async () => {
        const latest = await api<SessionOrder>('/sessions/order');
        await api('/sessions/order', 'PUT', { bucket, ids, revision: latest.revision });
        await refresh();
        await refreshList();
      });
    await orderQueue.current.catch(async (e) => {
      report(e);
      await refresh().catch(report);
    });
  }
  async function workspaceChoose() {
    if (window.cagent) {
      const folder = await window.cagent.chooseFolder();
      if (folder) await patch({ workspace: folder }).catch(report);
    } else {
      setWorkspaceValue(detail?.session.workspace ?? '');
      setWorkspace(true);
    }
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'f' &&
        detail &&
        !document.querySelector('dialog[open]')
      ) {
        event.preventDefault();
        setFinding(true);
        requestAnimationFrame(() => findEditor.current?.focus());
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'n' &&
        !document.querySelector('dialog[open]')
      ) {
        event.preventDefault();
        void createSession();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  });
  useEffect(() => {
    const editor = composeEditor.current;
    if (!editor) return;
    editor.style.height = 'auto';
    editor.style.height = Math.min(180, editor.scrollHeight) + 'px';
  }, [draft, sessionId, detail?.messages.length]);
  const notify = (
    <div role="status" aria-live="polite" className={toast ? 'toast visible' : 'toast'}>
      {toast}
      <button aria-label="关闭提示" onClick={() => setToast('')}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
  if (loading)
    return (
      <div className="loading">
        <div className="brand-mark">C</div>
        <p>正在打开工作空间…</p>
        {notify}
      </div>
    );
  if (auth)
    return (
      <main className="setup-shell">
        <form
          className="setup-card"
          onSubmit={(e) => {
            e.preventDefault();
            void authenticate(token).catch(report);
          }}
        >
          <div className="brand-mark">C</div>
          <h1>连接 CAgent</h1>
          <p>输入本机服务的连接凭据。</p>
          <Field label="连接凭据">
            <input
              type="password"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <button className="primary full">连接</button>
          {notify}
        </form>
      </main>
    );
  if (!data)
    return (
      <main className="fatal">
        <h1>暂时无法连接</h1>
        <p>{toast}</p>
        <button onClick={() => location.reload()}>重试</button>
      </main>
    );
  if (!data.preferences.setupComplete)
    return (
      <>
        <Setup
          data={data}
          onDone={async () => {
            const next = await refresh();
            window.cagent?.finishSetup();
            const agent =
              next.agents.find((a) => a.id === next.preferences.primaryAgentId) ?? next.agents[0];
            const s =
              next.sessions.find((s) => !s.archived) ??
              (await api<Session>('/sessions', 'POST', {
                agentId: agent.id,
                modelId: agent.modelId,
              }));
            selected.current = s.id;
            setSessionId(s.id);
            await loadSession(s.id, true);
            await refresh();
          }}
          report={report}
        />
        {notify}
      </>
    );
  const current = detail?.session,
    model = data.models.find((m) => m.id === current?.modelId),
    agent = data.agents.find((a) => a.id === current?.agentId);
  return (
    <div className="app-shell">
      <TopStrip
        rail={rail}
        desk={right}
        toggleRail={() => setRail(!rail)}
        toggleDesk={() => setRight(!right)}
        chat={() => setView('chat')}
      />
      <div className="work-area">
        {rail && (
          <SessionRail
            data={data}
            sessions={sessions}
            selected={sessionId}
            search={search}
            archived={archived}
            busy={navigating || uploading}
            onSearch={setSearch}
            onArchive={() => setArchived(!archived)}
            create={() => void createSession()}
            settings={() => setSettings(true)}
            collapse={() => setRail(false)}
            choose={(id) => void selectSession(id)}
            locate={(hit) => void locateMessage(hit)}
            sort={(mode) => void sortSessions(mode)}
            reorder={(bucket, ids) => void reorderSessions(bucket, ids)}
            report={report}
          />
        )}
        <main className="main-pane">
          {view === 'memory' ? (
            <MemoryPage data={data} report={report} />
          ) : (
            <div className="content-columns">
              <section className={`conversation${!detail?.messages.length ? ' resting' : ''}`}>
                {finding && current && (
                  <div className="conversation-search">
                    <div className="search-box">
                      <input
                        ref={findEditor}
                        aria-label="查找本会话"
                        placeholder="查找本会话"
                        value={findText}
                        onChange={(event) => setFindText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setFinding(false);
                        }}
                      />
                      <button
                        className="icon-button"
                        aria-label="关闭会话查找"
                        onClick={() => setFinding(false)}
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                    {findText.trim() && (
                      <SearchResults
                        query={findText}
                        sessionId={current.id}
                        choose={(hit) => void locateMessage(hit)}
                        report={report}
                      />
                    )}
                  </div>
                )}
                {connection && (
                  <div className="connection-note" role="status">
                    {connection}
                  </div>
                )}
                <div
                  className="transcript"
                  ref={transcript}
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    follow.current =
                      !currentDetail.current?.pagination.hasNewer &&
                      el.scrollHeight - el.scrollTop - el.clientHeight < 130;
                    setAwayFromEnd(!follow.current);
                  }}
                >
                  <div className="transcript-inner">
                    {current?.parentId && (
                      <div className="branch-origin">
                        <span>此会话是独立分支</span>
                        <button
                          disabled={!data.sessions.some((s) => s.id === current.parentId)}
                          onClick={() => void selectSession(current.parentId!)}
                        >
                          查看来源会话
                        </button>
                        {detail?.runs[0]?.preventWrites && (
                          <small>
                            重试复用已有工具结果；本轮禁止重复写入。需要新操作时请发送新消息。
                          </small>
                        )}
                      </div>
                    )}
                    {current && !agent && (
                      <div className="run-error">
                        <p>
                          原助手“{current.agentName ?? current.agentId}
                          ”已删除。历史仍可阅读；选择接管助手后才能继续。
                        </p>
                        <select
                          aria-label="接管会话的助手"
                          value=""
                          onChange={(e) => void patch({ agentId: e.target.value }).catch(report)}
                        >
                          <option value="">选择新助手</option>
                          {data.agents.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {detail?.pagination.hasMore && (
                      <button
                        className="history-more"
                        disabled={historyBusy}
                        onClick={() => void moreHistory()}
                      >
                        {historyBusy ? '正在读取…' : '加载更早消息'}
                      </button>
                    )}
                    {detail?.pagination.hasNewer && (
                      <button
                        className="history-more"
                        onClick={() => void latestMessages().catch(report)}
                      >
                        返回最新消息
                      </button>
                    )}
                    {!!detail?.pagination.corruptPositions.length && (
                      <p role="alert" className="inline-error">
                        以下历史记录损坏，已单独隔离：
                        {detail.pagination.corruptPositions.join(', ')}
                        。其他消息仍可阅读。
                      </p>
                    )}
                    {detail?.compaction && (
                      <details className="compaction-card">
                        <summary>上下文摘要 · 原始历史完整保留</summary>
                        <Markdown text={detail.compaction.text} />
                      </details>
                    )}
                    {!detail || detail.messages.length === 0 ? (
                      <div className="welcome">
                        <Portrait
                          name={agent?.name ?? 'CAgent'}
                          size={100}
                          src={
                            agent?.id === data.preferences.primaryAgentId
                              ? assistantPortrait
                              : undefined
                          }
                        />
                        <h1>今天，想一起做些什么？</h1>
                        <button
                          className="welcome-workspace"
                          title={current?.workspace ?? '选择工作台'}
                          onClick={() => (current ? void workspaceChoose() : void createSession())}
                        >
                          <Icon name="folder" size={15} />
                          {current?.workspace
                            ? '工作台：' + current.workspace.split(/[\\/]/).at(-1)
                            : '选择一个工作台'}
                          <Icon name="refresh" size={13} />
                        </button>
                        <button className="welcome-memory" onClick={() => setView('memory')}>
                          <Icon name="memory" size={14} />
                          记忆
                        </button>
                        {!current && (
                          <button className="text-button" onClick={() => void createSession()}>
                            开启新对话
                          </button>
                        )}
                      </div>
                    ) : (
                      detail.messages.map((m) => (
                        <MessageView
                          key={m.id}
                          message={m}
                          located={located === m.id}
                          resources={detail.resources}
                          timeZone={data.preferences.timezone}
                          disabled={!!active || sending}
                          onEdit={() => {
                            setEditing(m);
                            setEditText(m.text);
                          }}
                          onRetry={() => void revise(m, 'retry')}
                          agentName={agent?.name ?? 'CAgent'}
                          agentPortrait={
                            agent?.id === data.preferences.primaryAgentId
                              ? assistantPortrait
                              : undefined
                          }
                          onCopy={() =>
                            void navigator.clipboard
                              .writeText(m.text)
                              .then(() => report('已复制'))
                              .catch(report)
                          }
                          onFork={() =>
                            void api<Session>(`/sessions/${m.sessionId}/fork`, 'POST', {
                              messageId: m.id,
                            })
                              .then(async (s) => {
                                await refresh();
                                await selectSession(s.id);
                              })
                              .catch(report)
                          }
                        />
                      ))
                    )}
                    {(active || live.text) && (
                      <article className="message assistant live">
                        <div className="message-heading">
                          <Portrait
                            name={agent?.name ?? 'CAgent'}
                            src={
                              agent?.id === data.preferences.primaryAgentId
                                ? assistantPortrait
                                : undefined
                            }
                          />
                          <b>{agent?.name ?? 'CAgent'}</b>
                          <span className="muted">
                            {active?.status === 'queued'
                              ? '排队中'
                              : detail?.approvals.length
                                ? '等待确认'
                                : activity ||
                                  (active?.purpose === 'compact' ? '正在压缩' : '正在处理')}
                          </span>
                        </div>
                        {live.reasoning && (
                          <details className="thinking">
                            <summary>思考过程</summary>
                            <p>{live.reasoning}</p>
                          </details>
                        )}
                        {live.text ? (
                          <Markdown text={live.text} />
                        ) : (
                          <span className="thinking-dots">● ● ●</span>
                        )}
                      </article>
                    )}
                    {detail?.approvals.map((a) => (
                      <div className="approval-card" key={a.id}>
                        <span className="eyebrow">需要你的确认</span>
                        <h3>
                          {a.tool === 'run_command'
                            ? '运行本机命令'
                            : ['write_file', 'edit_file'].includes(a.tool)
                              ? '写入工作区文件'
                              : '保存记忆'}
                        </h3>
                        {a.tool === 'run_command' && (
                          <p>此命令在本机执行，没有操作系统沙盒隔离。</p>
                        )}
                        <pre>{JSON.stringify(a.arguments, null, 2)}</pre>
                        <div>
                          <button
                            onClick={() =>
                              void api(`/approvals/${a.id}`, 'POST', {
                                runId: a.runId,
                                approved: false,
                              }).catch(report)
                            }
                          >
                            拒绝
                          </button>
                          <button
                            className="primary"
                            onClick={() =>
                              void api(`/approvals/${a.id}`, 'POST', {
                                runId: a.runId,
                                approved: true,
                              }).catch(report)
                            }
                          >
                            允许这一次
                          </button>
                        </div>
                      </div>
                    ))}
                    {detail &&
                      !active &&
                      ['failed', 'interrupted'].includes(detail.runs[0]?.status) && (
                        <div className="run-error">
                          <p>{detail.runs[0].error?.message}</p>
                          <button onClick={() => void send(true)}>重试最近请求</button>
                        </div>
                      )}
                    <div ref={messagesEnd} />
                  </div>
                </div>
                {current && (
                  <div className="composer-wrap">
                    {awayFromEnd && !!detail.messages.length && (
                      <button
                        className="jump-latest"
                        aria-label="回到最新消息"
                        onClick={() => {
                          if (detail.pagination.hasNewer) {
                            void latestMessages().catch(report);
                            return;
                          }
                          follow.current = true;
                          messagesEnd.current?.scrollIntoView({
                            block: 'end',
                            behavior: 'instant',
                          });
                          setAwayFromEnd(false);
                        }}
                      >
                        <Icon name="down" size={16} />
                      </button>
                    )}
                    <div className="composer">
                      <AttachmentPicker
                        key={current.id}
                        sessionId={current.id}
                        ids={attachmentIds}
                        resources={detail.resources}
                        disabled={current.archived || sending || navigating}
                        onChange={attachmentsChanged}
                        onBusy={setUploading}
                        onUploaded={(resource) =>
                          setDetail((d) =>
                            d && d.session.id === resource.sessionId
                              ? { ...d, resources: [...d.resources, resource] }
                              : d,
                          )
                        }
                      >
                        <textarea
                          ref={composeEditor}
                          rows={1}
                          aria-label="消息"
                          placeholder={
                            current.archived ? '此会话已归档，恢复后可继续' : '写下你的问题…'
                          }
                          value={draft}
                          disabled={current.archived || navigating}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                              e.preventDefault();
                              if (!active) void send();
                            }
                          }}
                        />
                        <div className="composer-toolbar">
                          <div className="composer-options">
                            <Soon label="命令菜单" icon="sparkle" compact />
                            <ChoiceMenu
                              key={current.id + '-permission'}
                              label="执行权限"
                              value={current.permission}
                              icon="shield"
                              compact
                              align="start"
                              items={[
                                {
                                  id: 'automatic',
                                  label: '自动审核',
                                  icon: 'shield',
                                  disabled: true,
                                },
                                { id: 'full', label: '完整权限', icon: 'activity', disabled: true },
                                { id: 'ask', label: '操作前询问', icon: 'shield' },
                                { id: 'read', label: '只读模式', icon: 'panel' },
                                {
                                  id: 'operate',
                                  label: '允许工作区写入',
                                  icon: 'folder',
                                  hint: '命令仍需确认',
                                },
                              ]}
                              onChange={(permission) => void patch({ permission }).catch(report)}
                            />
                            <details className="session-menu">
                              <summary aria-label="会话操作" title="上下文与会话操作">
                                <Icon name="more" size={17} />
                              </summary>
                              <div
                                onClick={(event) => {
                                  if ((event.target as HTMLElement).closest('button'))
                                    event.currentTarget.closest('details')?.removeAttribute('open');
                                }}
                              >
                                <button
                                  onClick={() => {
                                    setFinding(true);
                                    requestAnimationFrame(() => findEditor.current?.focus());
                                  }}
                                >
                                  会话内查找
                                </button>
                                <button onClick={() => setDirectoryPermissions(true)}>
                                  管理目录授权
                                </button>
                                <button
                                  onClick={() => {
                                    setNewTitle(current.title);
                                    setRenaming(true);
                                  }}
                                >
                                  重命名
                                </button>
                                <button
                                  onClick={() =>
                                    void patch({ pinned: !current.pinned }).catch(report)
                                  }
                                >
                                  {current.pinned ? '取消置顶' : '置顶'}
                                </button>
                                <button
                                  disabled={!!active}
                                  onClick={() =>
                                    void patch({ archived: !current.archived }).catch(report)
                                  }
                                >
                                  {current.archived ? '恢复会话' : '归档会话'}
                                </button>
                                <button
                                  disabled={!!active || sending}
                                  onClick={() =>
                                    void api<Run>(`/sessions/${current.id}/compact`, 'POST', {
                                      requestId: crypto.randomUUID(),
                                    })
                                      .then((run) => {
                                        setActive(run);
                                        report('正在压缩上下文，保留最后两轮和完整历史');
                                      })
                                      .catch(report)
                                  }
                                >
                                  压缩上下文
                                </button>
                                <button
                                  onClick={() =>
                                    void api<any>(`/sessions/${current.id}/export`)
                                      .then((v) =>
                                        download(
                                          current.title + '.md',
                                          v.markdown,
                                          'text/markdown',
                                        ),
                                      )
                                      .catch(report)
                                  }
                                >
                                  导出 Markdown
                                </button>
                                {current.archived && (
                                  <button
                                    className="danger"
                                    onClick={() =>
                                      setConfirm({
                                        title: '永久删除此会话？',
                                        action: async () => {
                                          await api('/sessions/' + current.id, 'DELETE');
                                          forgetWorkspaceDrafts(current.id);
                                          setDetail(null);
                                          selected.current = null;
                                          setSessionId(null);
                                          await refresh();
                                        },
                                      })
                                    }
                                  >
                                    永久删除
                                  </button>
                                )}
                              </div>
                            </details>
                            <span className="grow" />
                            <ChoiceMenu
                              key={current.id + '-reasoning'}
                              label="推理档位"
                              value={current.reasoning}
                              icon="bulb"
                              compact
                              disabled={!!active || sending}
                              items={[...new Set(['off', ...(model?.reasoning ?? [])])].map(
                                (level) => ({
                                  id: level,
                                  label: reasoningNames[level] ?? level,
                                  hint: reasoningHints[level],
                                }),
                              )}
                              onChange={(reasoning) => void patch({ reasoning }).catch(report)}
                            />
                            <ChoiceMenu
                              key={current.id + '-model'}
                              label="聊天模型"
                              value={current.modelId ?? ''}
                              icon="model"
                              disabled={!!active || sending}
                              items={data.providers.flatMap((provider) =>
                                data.models
                                  .filter((m) => m.providerId === provider.id)
                                  .map((m) => ({
                                    id: m.id,
                                    label: m.name,
                                    group: provider.name,
                                  })),
                              )}
                              onChange={(id) => {
                                const next = data.models.find((m) => m.id === id);
                                void patch({
                                  modelId: next?.id ?? null,
                                  reasoning: next?.defaultReasoning ?? 'off',
                                }).catch(report);
                              }}
                            />
                          </div>
                          {active ? (
                            <button
                              className="send-button stop"
                              aria-label="停止生成"
                              onClick={() =>
                                void api(`/sessions/${current.id}/cancel`, 'POST', {
                                  runId: active.id,
                                }).catch(report)
                              }
                            >
                              <Icon name="stop" size={17} />
                            </button>
                          ) : (
                            <button
                              className="send-button"
                              aria-label="发送消息"
                              disabled={
                                (!draft.trim() && !attachmentIds.length) ||
                                sending ||
                                uploading ||
                                navigating ||
                                current.archived ||
                                !agent
                              }
                              onClick={() => void send()}
                            >
                              <Icon name="send" size={14} />
                              发送
                            </button>
                          )}
                        </div>
                      </AttachmentPicker>
                    </div>
                  </div>
                )}
              </section>
              {right && current && (
                <Workspace
                  key={current.id + current.workspace}
                  session={current}
                  preferences={data.preferences}
                  choose={workspaceChoose}
                  authorize={() => setDirectoryPermissions(true)}
                  switchDirectory={(path) => patch({ workspace: path })}
                  canSwitch={!active}
                  report={report}
                  resources={detail.resources}
                  modelName={model?.model ?? '未选择模型'}
                  hasMessages={!!detail.messages.length}
                />
              )}
            </div>
          )}
        </main>
      </div>
      {settings && (
        <Settings
          data={data}
          refresh={async () => {
            await refresh();
          }}
          close={() => setSettings(false)}
          report={report}
        />
      )}
      {editing && (
        <Modal title="编辑消息并创建分支" onClose={() => setEditing(null)}>
          <form
            className="editor-form"
            onSubmit={(e) => {
              e.preventDefault();
              void revise(editing, 'edit', editText);
            }}
          >
            <Field label="修改后的消息" hint="原会话保持完整；新分支只继承这条消息之前的历史。">
              <textarea
                autoFocus
                required
                rows={6}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
              />
            </Field>
            <div className="form-actions">
              <button type="button" onClick={() => setEditing(null)}>
                取消
              </button>
              <button className="primary" disabled={sending}>
                创建分支并发送
              </button>
            </div>
          </form>
        </Modal>
      )}
      {renaming && (
        <Modal title="重命名会话" onClose={() => setRenaming(false)}>
          <form
            className="editor-form"
            onSubmit={(e) => {
              e.preventDefault();
              void patch({ title: newTitle })
                .then(() => setRenaming(false))
                .catch(report);
            }}
          >
            <Field label="会话名称">
              <input
                required
                autoFocus
                maxLength={120}
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
              />
            </Field>
            <div className="form-actions">
              <button type="button" onClick={() => setRenaming(false)}>
                取消
              </button>
              <button className="primary">保存名称</button>
            </div>
          </form>
        </Modal>
      )}
      {directoryPermissions && current && (
        <DirectoryPermissions
          session={current}
          close={() => setDirectoryPermissions(false)}
          report={report}
          save={async (directoryGrants, first) => {
            await patch({ directoryGrants, ...(first && !active ? { workspace: first } : {}) });
          }}
        />
      )}
      {workspace && (
        <Modal title="授权工作区" onClose={() => setWorkspace(false)}>
          <form
            className="editor-form"
            onSubmit={(e) => {
              e.preventDefault();
              void patch({ workspace: workspaceValue || null })
                .then(() => setWorkspace(false))
                .catch(report);
            }}
          >
            <Field label="本机文件夹路径" hint="文件工具只在此目录内工作。命令执行仍会逐次询问。">
              <input
                autoFocus
                value={workspaceValue}
                onChange={(e) => setWorkspaceValue(e.target.value)}
                placeholder="F:\我的工作"
              />
            </Field>
            <div className="form-actions">
              <button type="button" onClick={() => setWorkspace(false)}>
                取消
              </button>
              <button className="primary">使用此目录</button>
            </div>
          </form>
        </Modal>
      )}
      {confirm && (
        <Modal title={confirm.title} onClose={() => setConfirm(null)}>
          <div className="editor-form">
            <p>删除后无法从归档列表恢复。已有导出文件不受影响。</p>
            <div className="form-actions">
              <button onClick={() => setConfirm(null)}>取消</button>
              <button
                className="danger"
                onClick={() =>
                  void confirm
                    .action()
                    .then(() => setConfirm(null))
                    .catch(report)
                }
              >
                确认删除
              </button>
            </div>
          </div>
        </Modal>
      )}
      {notify}
    </div>
  );
}

function MessageView({
  message: m,
  agentName,
  agentPortrait,
  onCopy,
  onFork,
  onEdit,
  onRetry,
  resources,
  disabled,
  timeZone,
  located = false,
}: {
  message: Message;
  agentName: string;
  agentPortrait?: string;
  onCopy: () => void;
  onFork: () => void;
  onEdit: () => void;
  onRetry: () => void;
  resources: SessionDetail['resources'];
  disabled: boolean;
  timeZone: string;
  located?: boolean;
}) {
  if (m.role === 'tool') {
    let unknown = false;
    try {
      unknown = JSON.parse(m.text)?.error?.code === 'TOOL_OUTCOME_UNKNOWN';
    } catch {}
    return (
      <details
        className="tool-result"
        id={'message-' + m.id}
        data-message-id={m.id}
        data-located={located}
        tabIndex={-1}
        open={located || undefined}
      >
        <summary>
          {!unknown && <Icon name="check" size={14} />}
          {unknown ? '工具结果未知' : '工具结果'} · {m.callId}
        </summary>
        <pre>{m.text}</pre>
      </details>
    );
  }
  return (
    <article
      className={'message ' + m.role}
      id={'message-' + m.id}
      data-message-id={m.id}
      data-located={located}
      tabIndex={-1}
    >
      <div className="message-heading">
        <Portrait
          name={m.role === 'user' ? '我' : agentName}
          src={m.role === 'assistant' ? agentPortrait : undefined}
        />
        <b>{m.role === 'user' ? '你' : agentName}</b>
      </div>
      <div className="message-content">
        {m.reasoning && (
          <details className="thinking">
            <summary>思考完成</summary>
            <p>{m.reasoning}</p>
          </details>
        )}
        <Markdown text={m.text} />
        {!!m.attachmentIds?.length && (
          <ResourceLinks ids={m.attachmentIds} resources={resources} sessionId={m.sessionId} />
        )}{' '}
        {m.calls?.map((c) => (
          <details className="tool-call" key={c.id}>
            <summary>{c.name}</summary>
            <pre>{c.arguments}</pre>
          </details>
        ))}
      </div>
      <div className="message-actions">
        <time>
          {new Date(m.at).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone,
          })}
        </time>

        {!m.calls?.length && (
          <button aria-label="从这里分叉" title="从这里分叉" onClick={onFork}>
            <Icon name="branch" size={14} />
          </button>
        )}
        {m.role === 'user' ? (
          <button aria-label="编辑并重发" title="编辑并重发" disabled={disabled} onClick={onEdit}>
            <Icon name="edit" size={14} />
          </button>
        ) : (
          !m.calls?.length && (
            <button
              aria-label="重试为分支"
              title="重试为分支"
              disabled={disabled}
              onClick={onRetry}
            >
              <Icon name="refresh" size={14} />
            </button>
          )
        )}
        <button aria-label="复制消息" onClick={onCopy}>
          <Icon name="copy" size={14} />
        </button>
        <Soon label="对话截图" icon="camera" compact />
        <Soon label="全选消息" icon="selectAll" compact />
        <Soon label="选择消息" icon="selection" compact />
      </div>
    </article>
  );
}
function MemoryPage({ data, report }: { data: Bootstrap; report: (e: unknown) => void }) {
  const [agentId, setAgentId] = useState(data.preferences.primaryAgentId ?? data.agents[0].id),
    [items, setItems] = useState<Memory[]>([]),
    [text, setText] = useState(''),
    [pinned, setPinned] = useState(false);
  const load = useCallback(
    async () => setItems(await api('/memory?agentId=' + agentId)),
    [agentId],
  );
  useEffect(() => {
    void load().catch(report);
  }, [load, report]);
  return (
    <section className="memory-page">
      <div className="section-heading">
        <div>
          <p className="eyebrow">保存在本机</p>
          <h1>值得记住的事</h1>
          <p>为每个助手保留独立的背景与偏好。</p>
        </div>
        <select
          aria-label="记忆所属助手"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
        >
          {data.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <form
        className="memory-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void api('/memory', 'POST', { agentId, text, pinned })
            .then(async () => {
              setText('');
              await load();
            })
            .catch(report);
        }}
      >
        <textarea
          aria-label="新的记忆"
          placeholder="例如：偏好简洁的中文说明，先给结论，再解释原因。"
          required
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div>
          <label className="check-row">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            固定记忆
          </label>
          <button className="primary">保存记忆</button>
        </div>
      </form>
      <p className="muted">在助手设置中开启“使用记忆”后，保存的内容才会用于对话。</p>
      <div className="memory-list">
        {items.map((m) => (
          <article className="memory-card" key={m.id}>
            {m.pinned && <Icon name="pin" size={15} />}
            <Markdown text={m.text} />
            <button
              className="text-button"
              onClick={() => {
                if (window.confirm('删除这条记忆？'))
                  void api('/memory/' + m.id, 'DELETE')
                    .then(load)
                    .catch(report);
              }}
            >
              删除
            </button>
          </article>
        ))}
        {!items.length && (
          <div className="panel-empty">
            <Icon name="memory" size={30} />
            <p>还没有保存的记忆</p>
          </div>
        )}
      </div>
    </section>
  );
}
