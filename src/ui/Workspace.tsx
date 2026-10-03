import { t, currentLocaleTag } from './i18n.ts';
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session, Preferences, Stored, Resource } from '../shared/contracts.ts';
import { sessionDirectories } from '../shared/contracts.ts';
import { api } from './api.ts';
import { Icon, Modal, Field, Markdown } from './components.tsx';
import { Soon } from './Shell.tsx';
import { ResourceLinks } from './Attachments.tsx';
import type { DocumentMemory } from './DocumentEditor.tsx';
import { inspectDocument } from './document-markdown.ts';
import { WorkspaceActions, uploadWorkspaceFiles } from './WorkspaceActions.tsx';
import {
  loadFileDraftView,
  rememberFileDraftView,
  flushFileDrafts,
  forgetFileDrafts,
} from './file-draft-cache.ts';

const DocumentEditor = lazy(() =>
  import('./DocumentEditor.tsx').then((module) => ({ default: module.DocumentEditor })),
);
const futurePreview = (name: string) =>
  /\.(pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|bmp|svg|mp[34]|wav|mov|avi|zip|7z)$/i.test(name);

interface FileTab {
  path: string;
  text: string;
  saved: string;
  sha256: string;
  scroll: number;
  changed: boolean;
  mode: 'document' | 'source' | 'preview';
  editMode?: 'document' | 'source';
  document?: DocumentMemory;
  generation: number;
}
interface Version extends Stored {
  path: string;
  sha256: string;
  bytes: number;
}
const drafts = new Map<string, { tabs: FileTab[]; active: string | null }>();
export function forgetWorkspaceDrafts(sessionId: string) {
  for (const key of drafts.keys()) if (key.startsWith(sessionId + '|')) drafts.delete(key);
  forgetFileDrafts(sessionId);
}
export function Workspace({
  session,
  preferences,
  choose,
  authorize,
  switchDirectory,
  canSwitch,
  report,
  resources,
  modelName,
  hasMessages,
}: {
  resources: Resource[];
  modelName: string;
  hasMessages: boolean;
  session: Session;
  preferences: Preferences;
  choose: () => Promise<void>;
  authorize: () => void;
  switchDirectory: (path: string) => Promise<void>;
  canSwitch: boolean;
  report: (e: unknown) => void;
}) {
  const key = session.id + '|' + session.workspace,
    prefix = `/sessions/${session.id}`;
  const draftScope = JSON.stringify([session.directoryGrants, session.blockedDirectories]);
  const [area, setArea] = useState<'files' | 'resources'>('files');
  const [managed, setManaged] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [draftStatus, setDraftStatus] = useState('正在恢复文件草稿…');
  const [draftFailed, setDraftFailed] = useState(false);
  const [folder, setFolder] = useState('.'),
    [entries, setEntries] = useState<{ name: string; kind: string }[]>([]),
    [truncated, setTruncated] = useState(false),
    [loading, setLoading] = useState(false),
    [filter, setFilter] = useState('');
  const [tabs, setTabs] = useState<FileTab[]>(() => drafts.get(key)?.tabs ?? []),
    [active, setActive] = useState<string | null>(() => drafts.get(key)?.active ?? null),
    [show, setShow] = useState(!!drafts.get(key)?.tabs.length),
    [watchState, setWatchState] = useState('正在连接文件变化通知…');
  const [operation, setOperation] = useState<'create-file' | 'create-directory' | null>(null),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [history, setHistory] = useState<Version[] | null>(null),
    [fileMenu, setFileMenu] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null),
    fileActions = useRef<HTMLButtonElement>(null),
    operations = useRef<HTMLDivElement>(null),
    searchInput = useRef<HTMLInputElement>(null),
    tabRef = useRef(tabs),
    listRequest = useRef(0),
    file = tabs.find((t) => t.path === active);
  const savePending = useRef(false);
  const draftsLoaded = useRef(false);
  function containsFile(target: string, candidate: string) {
    const normalize = (value: string) => {
      const absolute = /^(?:[a-z]:[\\/]|\/)/i.test(value) ? value : session.workspace + '/' + value;
      return absolute.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    };
    const root = normalize(target),
      filePath = normalize(candidate);
    return root === filePath || filePath.startsWith(root + '/');
  }
  async function itemChanged(operation: string, target: string) {
    if (operation !== 'copy') {
      const retained = tabRef.current.filter((tab) => !containsFile(target, tab.path));
      setTabs(retained);
      if (active && containsFile(target, active)) setActive(retained.at(-1)?.path ?? null);
      if (!retained.length) setShow(false);
    }
    await load();
    report(
      operation === 'trash' ? t('已移入系统回收站，可在系统回收站中恢复') : t('文件操作已完成'),
    );
  }
  const markdownFile = /\.(md|markdown)$/i.test(file?.path ?? '');
  const document = useMemo(() => {
    if (!file || !markdownFile) return null;
    if (file.document?.text === file.text) return { source: file.document.source };
    return inspectDocument(file.text);
  }, [file?.text, file?.document, markdownFile]);
  tabRef.current = tabs;
  const load = useCallback(async () => {
    if (!session.workspace) return;
    const request = ++listRequest.current;
    const data = await api<{ entries: typeof entries; truncated: boolean }>(
      `${prefix}/files?path=${encodeURIComponent(folder)}`,
    );
    if (request !== listRequest.current) return;
    setEntries(data.entries);
    setTruncated(data.truncated);
  }, [session.workspace, prefix, folder]);
  useEffect(() => {
    let current = true;
    setLoading(true);
    void load()
      .catch(report)
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [load, report]);
  useEffect(() => {
    drafts.set(key, { tabs, active });
    if (draftReady && session.workspace) {
      rememberFileDraftView(session.id, session.workspace, { tabs, active }, (status, error) => {
        setDraftStatus(status);
        setDraftFailed(!!error);
        if (error) report(error);
      });
    }
  }, [key, tabs, active, draftReady, session.workspace, session.id, report]);
  useEffect(() => {
    if (!session.workspace) {
      setDraftReady(true);
      return;
    }
    let current = true;
    setDraftReady(false);
    void loadFileDraftView(session.id, session.workspace)
      .then((value) => {
        if (!current) return;
        const remembered = drafts.get(key);
        const restored = {
          tabs: value.tabs.map((tab) => {
            const old = remembered?.tabs.find(
              (item) =>
                item.path === tab.path && item.text === tab.text && item.saved === tab.saved,
            );
            return { ...old, ...tab, changed: !!tab.changed, generation: old?.generation ?? 0 };
          }),
          active: value.active,
        };
        setTabs(restored.tabs);
        setActive(restored.active);
        if (!draftsLoaded.current) setShow(!!restored.tabs.length);
        else if (!restored.tabs.length) setShow(false);
        draftsLoaded.current = true;
        setDraftReady(true);
        setDraftStatus('恢复草稿已保存');
        setDraftFailed(false);
      })
      .catch((error) => {
        if (current) {
          setDraftStatus('恢复草稿读取失败，请重新打开工作区');
          setDraftFailed(true);
          report(error);
        }
      });
    return () => {
      current = false;
    };
  }, [key, session.id, session.workspace, draftScope, report]);
  useEffect(() => {
    if (!session.workspace) return;
    let closed = false;
    const stream = new EventSource(`/api/v1${prefix}/workspace-events`);
    stream.onopen = () => setWatchState('正在同步文件变化');
    stream.onerror = () => setWatchState('变化通知断开，正在重连；可以手动刷新');
    stream.onmessage = (event) => {
      if (closed) return;
      const data = JSON.parse(event.data);
      if (data.kind === 'reset') {
        stream.close();
        setWatchState('工作区已失效，请重新选择');
        return;
      }
      void load().catch(report);
      for (const tab of tabRef.current)
        void api<{ sha256: string }>(`${prefix}/file?path=${encodeURIComponent(tab.path)}`)
          .then((r) => {
            if (!closed && r.sha256 !== tab.sha256)
              setTabs((t) => t.map((x) => (x.path === tab.path ? { ...x, changed: true } : x)));
          })
          .catch(() => {
            if (!closed)
              setTabs((t) => t.map((x) => (x.path === tab.path ? { ...x, changed: true } : x)));
          });
    };
    return () => {
      closed = true;
      stream.close();
    };
  }, [prefix, session.workspace, load, report]);
  useEffect(() => {
    if (editor.current && file) editor.current.scrollTop = file.scroll;
    setHistory(null);
    setFileMenu(false);
  }, [active, show, file?.mode]);
  useEffect(() => {
    if (!fileMenu) return;
    operations.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!operations.current?.contains(target) && !fileActions.current?.contains(target))
        setFileMenu(false);
    };
    window.document.addEventListener('pointerdown', outside);
    return () => window.document.removeEventListener('pointerdown', outside);
  }, [fileMenu]);
  function updateTab(target: string, values: Partial<FileTab>) {
    setTabs((old) => old.map((t) => (t.path === target ? { ...t, ...values } : t)));
  }
  function chooseFileMode(mode: 'document' | 'source') {
    if (!file) return;
    updateTab(file.path, { mode, editMode: mode });
    setFileMenu(false);
    fileActions.current?.focus();
  }
  function togglePreview() {
    if (!file) return;
    if (file.mode !== 'preview') {
      updateTab(file.path, { mode: 'preview', editMode: file.mode });
      return;
    }
    const previous = file.editMode ?? (document?.source ? 'document' : 'source');
    updateTab(file.path, {
      mode: previous === 'document' && !document?.source ? 'source' : previous,
    });
  }
  async function openFile(target: string, refresh = false) {
    if (!draftReady) return;
    const old = tabRef.current.find((t) => t.path === target);
    if (old && !refresh) {
      setActive(target);
      setShow(true);
      return;
    }
    if (!old && tabs.length >= 10) {
      report(t('最多打开 10 个文件，请先关闭一个标签'));
      return;
    }
    const value = await api<{ path: string; text: string; sha256: string }>(
      `${prefix}/file?path=${encodeURIComponent(target)}`,
    );
    const canEditDocument =
      /\.(md|markdown)$/i.test(target) && !!inspectDocument(value.text).source;
    const tab: FileTab = {
      ...value,
      saved: value.text,
      scroll: old?.scroll ?? 0,
      changed: false,
      mode:
        old?.mode === 'document' && !canEditDocument
          ? 'source'
          : (old?.mode ?? (canEditDocument ? 'document' : 'source')),
      generation: (old?.generation ?? -1) + 1,
    };
    setTabs((t) => (old ? t.map((x) => (x.path === target ? tab : x)) : [...t, tab]));
    setActive(target);
    setShow(true);
  }
  function closeTab(target: string) {
    const tab = tabs.find((t) => t.path === target);
    if (tab && tab.text !== tab.saved && !window.confirm(t('放弃此文件未保存的修改？'))) return;
    const next = tabs.filter((t) => t.path !== target);
    setTabs(next);
    if (active === target) setActive(next.at(-1)?.path ?? null);
    if (!next.length) setShow(false);
  }
  async function save() {
    if (!file || readonly || file.text === file.saved || savePending.current) return;
    const target = file.path,
      text = file.text;
    savePending.current = true;
    setBusy(true);
    try {
      const r = await api<{ sha256: string }>(prefix + '/file', 'PUT', {
        path: target,
        text,
        expectedHash: file.sha256,
      });
      updateTab(target, { saved: text, sha256: r.sha256, changed: false });
      report(t('文件已保存'));
      await load();
    } catch (e) {
      report(e);
    } finally {
      savePending.current = false;
      setBusy(false);
    }
  }
  async function applyOperation() {
    if (!operation) return;
    setBusy(true);
    try {
      const target = (folder === '.' ? '' : folder + '/') + name;
      await api(prefix + '/file-operation', 'POST', {
        operation,
        workspace: session.workspace,
        path: target,
        text: '',
      });
      setOperation(null);
      await load();
      if (operation === 'create-file') await openFile(target);
      report(t('文件操作已完成'));
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  const grants = sessionDirectories(session);
  const readonly =
    session.permission === 'read' ||
    grants.find((grant) => grant.path === session.workspace)?.access === 'read';
  return (
    <aside
      className={'workspace-panel' + (show && file ? ' editing' : '')}
      aria-label={t('书桌文件区')}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && show && file) {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) void save();
        }
        if (event.key === 'Escape' && fileMenu) {
          event.preventDefault();
          setFileMenu(false);
          fileActions.current?.focus();
        }
      }}
    >
      <div className="desk-card">
        <div className="desk-heading">
          <h3 title={session.workspace ?? t('工作台')}>
            {session.workspace?.split(/[\\/]/).at(-1) ?? t('工作台')}
          </h3>
          <Soon label={t('项目技能')} icon="sparkle" />
        </div>
        {(grants.length > 1 || (!session.workspace && grants.length > 0)) && (
          <select
            className="desk-directory"
            aria-label={t('当前工作台')}
            value={session.workspace ?? ''}
            disabled={!canSwitch || busy}
            onChange={(event) => void switchDirectory(event.target.value).catch(report)}
          >
            {!session.workspace && <option value="">{t('选择已授权目录')}</option>}
            {grants.map((grant) => (
              <option key={grant.path} value={grant.path}>
                {grant.path.split(/[\\/]/).at(-1)} ·{' '}
                {grant.access === 'read' ? t('只读') : t('读写')}
              </option>
            ))}
          </select>
        )}
        <div className="desk-tabs" role="tablist" aria-label={t('书桌内容')}>
          <button
            role="tab"
            aria-selected={area === 'resources'}
            onClick={() => setArea('resources')}
          >
            {t('对话文件')}
          </button>
          <button role="tab" aria-selected={area === 'files'} onClick={() => setArea('files')}>
            {t('工作台')}
          </button>
        </div>
        <input
          className="desk-search"
          ref={searchInput}
          aria-label={t('筛选当前目录')}
          placeholder={t('搜索工作台')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          disabled={area !== 'files' || !session.workspace}
        />
        <div className="desk-tools">
          <input
            type="file"
            multiple
            hidden
            ref={uploadInput}
            aria-label={t('上传工作区文件')}
            disabled={!session.workspace || readonly || busy || !draftReady}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              setBusy(true);
              void uploadWorkspaceFiles(session.id, session.workspace, folder, files, report)
                .then(async (count) => {
                  await load();
                  if (count) report(t('已上传 {0} 个文件', [count]));
                })
                .catch(report)
                .finally(() => setBusy(false));
            }}
          />
          <button
            aria-label={t('上传文件到工作区')}
            title={t('上传文件到工作区')}
            disabled={!session.workspace || readonly || busy || !draftReady}
            onClick={() => uploadInput.current?.click()}
          >
            {t('上传')}
          </button>
          <button
            aria-label={t('新建文件')}
            title={t('新建文件')}
            disabled={!session.workspace || readonly || !draftReady}
            onClick={() => {
              setName('');
              setOperation('create-file');
            }}
          >
            <Icon name="filePlus" size={14} />
          </button>
          <button
            aria-label={t('新建目录')}
            title={t('新建目录')}
            disabled={!session.workspace || readonly || !draftReady}
            onClick={() => {
              setName('');
              setOperation('create-directory');
            }}
          >
            <Icon name="folderPlus" size={14} />
          </button>
          <button
            aria-label={t('更换工作区')}
            title={t('选择工作台')}
            onClick={() => void choose()}
          >
            <Icon name="folder" size={14} />
          </button>
          <button aria-label={t('目录授权')} title={t('管理目录授权')} onClick={authorize}>
            <Icon name="shield" size={14} />
          </button>
          <button
            aria-label={t('刷新文件')}
            title={t('刷新文件')}
            disabled={!session.workspace}
            onClick={() => void load().catch(report)}
          >
            <Icon name="refresh" size={13} />
          </button>
          <button
            aria-label={t('过滤文件')}
            title={t('过滤文件')}
            onClick={() => searchInput.current?.focus()}
          >
            <Icon name="filter" size={13} />
            {t('过滤')}
          </button>
          <Soon label={t('时间')} icon="sort" />
        </div>
        <span className="sr-only" role="status">
          {t(watchState)}
        </span>
        <div className="desk-files" role="tabpanel">
          {area === 'resources' ? (
            resources.length ? (
              <ResourceLinks
                ids={resources.map((r) => r.id)}
                resources={resources}
                sessionId={session.id}
              />
            ) : (
              <div className="panel-empty">{t('暂无对话文件')}</div>
            )
          ) : !session.workspace ? (
            <div className="panel-empty">
              <p>{t('为这个会话选择一个文件夹')}</p>
              <button onClick={() => void choose()}>{t('选择工作区')}</button>
            </div>
          ) : (
            <>
              {folder !== '.' && (
                <div className="file-crumb">
                  <button onClick={() => setFolder('.')}>{t('根目录')}</button>
                  <button
                    onClick={() =>
                      setFolder(
                        folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '.',
                      )
                    }
                  >
                    {t('上一级')}
                  </button>
                  <span>{folder}</span>
                </div>
              )}
              {loading ? (
                <div className="panel-empty">{t('正在读取…')}</div>
              ) : entries.length ? (
                <div className="file-list">
                  {entries
                    .filter((e) => e.name.toLowerCase().includes(filter.toLowerCase()))
                    .map((entry) => (
                      <div className="file-list-row" key={entry.name}>
                        <button
                          key={entry.name}
                          aria-label={
                            entry.kind === 'link' ||
                            (entry.kind === 'file' && futurePreview(entry.name))
                              ? t('{0} · 即将提供', [entry.name])
                              : entry.name
                          }
                          disabled={
                            !draftReady ||
                            entry.kind === 'link' ||
                            (entry.kind === 'file' && futurePreview(entry.name))
                          }
                          title={
                            entry.kind === 'link' ||
                            (entry.kind === 'file' && futurePreview(entry.name))
                              ? entry.name + t(' · 即将提供')
                              : entry.name
                          }
                          onClick={() => {
                            const target = (folder === '.' ? '' : folder + '/') + entry.name;
                            if (entry.kind === 'directory') setFolder(target);
                            else void openFile(target).catch(report);
                          }}
                        >
                          <Icon name={entry.kind === 'directory' ? 'folder' : 'file'} size={14} />
                          <span>{entry.name}</span>
                          {(entry.kind === 'link' ||
                            (entry.kind === 'file' && futurePreview(entry.name))) && (
                            <small>{t('即将提供')}</small>
                          )}
                        </button>
                        <button
                          className="file-manage"
                          aria-label={t('管理 ') + entry.name}
                          title={t('管理 ') + entry.name}
                          disabled={entry.kind === 'link' || !draftReady || busy}
                          onClick={() =>
                            setManaged((folder === '.' ? '' : folder + '/') + entry.name)
                          }
                        >
                          ⋯
                        </button>
                      </div>
                    ))}
                  {!entries.some((e) => e.name.toLowerCase().includes(filter.toLowerCase())) && (
                    <p className="panel-empty">{t('没有匹配的文件')}</p>
                  )}
                  {truncated && (
                    <p className="inline-error">{t('目录超过 500 项，只显示前 500 项。')}</p>
                  )}
                </div>
              ) : (
                <div className="panel-empty">{t('暂无文件')}</div>
              )}
              {!!tabs.length && (
                <button className="reopen-files" onClick={() => setShow(true)}>
                  {t('已打开')}
                  {tabs.length} {t('个文件')}
                  {tabs.some((t) => t.text !== t.saved) ? t(' · 有未保存修改') : ''}
                </button>
              )}
            </>
          )}
        </div>
        <div className="desk-note">
          <span>
            {t('笺')}
            <small>{t('即将提供')}</small>
          </span>
          <Soon label={t('展开笺')} icon="up" compact />
        </div>
      </div>
      {hasMessages && (
        <details className="desk-session" open>
          <summary>{t('本次对话')}</summary>
          <dl>
            <dt>{t('工作目录')}</dt>
            <dd title={session.workspace ?? ''}>
              {session.workspace?.split(/[\\/]/).at(-1) ?? t('未选择')}
            </dd>
            <dt>{t('执行权限')}</dt>
            <dd>
              {session.permission === 'read'
                ? t('只读')
                : session.permission === 'ask'
                  ? t('操作前询问')
                  : t('工作区可写')}
            </dd>
            <dt>{t('模型')}</dt>
            <dd title={modelName}>{modelName}</dd>
            <dt>{t('文件')}</dt>
            <dd>{resources.length}</dd>
          </dl>
        </details>
      )}
      {show && file && (
        <section className="desk-editor" aria-label={t('文件预览与编辑')}>
          <div className="desk-editor-heading">
            <div className="file-tabs" role="tablist" aria-label={t('打开的文件')}>
              {tabs.map((tab) => (
                <div key={tab.path}>
                  <button
                    role="tab"
                    aria-selected={tab.path === active}
                    title={tab.path}
                    onClick={() => setActive(tab.path)}
                  >
                    <span className="file-tab-name">{tab.path}</span>
                    {tab.text !== tab.saved ? ' *' : ''}
                  </button>
                  <button aria-label={t('关闭文件 ') + tab.path} onClick={() => closeTab(tab.path)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              className="icon-button"
              aria-label={t('关闭文件预览')}
              title={t('收起文件面板，保留草稿')}
              onClick={() => setShow(false)}
            >
              <Icon name="arrow" size={15} />
            </button>
          </div>
          <div
            className="file-editor"
            style={{
              fontSize: preferences.editorFontSize ?? 16,
              lineHeight: preferences.editorLineHeight ?? 1.5,
            }}
          >
            <div className="file-toolbar" role="toolbar" aria-label={t('文件工具')}>
              <button
                aria-label={t('复制文件内容')}
                title={t('复制当前草稿')}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(file.text)
                    .then(() => report(t('文件内容已复制')))
                    .catch(report)
                }
              >
                <Icon name="copy" size={13} />
                {t('复制')}
              </button>
              <Soon label={t('添加封面')} icon="palette" compact />
              <button
                aria-label={t('文件历史')}
                title={t('文件历史')}
                onClick={() =>
                  void api<Version[]>(
                    `${prefix}/file-history?path=${encodeURIComponent(file.path)}`,
                  )
                    .then(setHistory)
                    .catch(report)
                }
              >
                <Icon name="clock" size={14} />
              </button>
              <button
                aria-label={t('预览')}
                aria-pressed={file.mode === 'preview'}
                title={file.mode === 'preview' ? t('返回编辑') : t('预览当前草稿')}
                onClick={togglePreview}
              >
                <Icon name="eye" size={15} />
              </button>
              <Soon label={t('文件截图')} icon="camera" compact />
              <button
                ref={fileActions}
                aria-label={t('文件操作')}
                aria-expanded={fileMenu}
                title={t('文件操作')}
                onClick={() => setFileMenu((open) => !open)}
              >
                <Icon name="more" size={14} />
              </button>
            </div>
            {document?.reason && (
              <p className="document-limit" role="status">
                {t(document.reason)}
              </p>
            )}
            {readonly && (
              <p className="document-limit" role="status">
                {session.permission === 'read' ? t('当前会话') : t('当前目录')}
                {t('为只读，文件内容不能修改。')}
              </p>
            )}
            {file.changed && (
              <p role="alert" className="inline-error">
                {t('磁盘文件已变化。编辑草稿保留；保存会校验原版本。')}
                <button
                  onClick={() => {
                    if (
                      file.text === file.saved ||
                      window.confirm(t('放弃编辑草稿并重新读取磁盘版本？'))
                    )
                      void openFile(file.path, true).catch(report);
                  }}
                >
                  {t('重新读取')}
                </button>
              </p>
            )}
            <textarea
              hidden={file.mode !== 'source' && !(file.mode === 'document' && !document?.source)}
              ref={editor}
              aria-label={t('文件内容')}
              readOnly={readonly}
              value={file.text}
              onChange={(e) =>
                updateTab(file.path, {
                  text: e.target.value,
                  document: undefined,
                  generation: file.generation + 1,
                })
              }
              onScroll={(e) => updateTab(file.path, { scroll: e.currentTarget.scrollTop })}
              style={{
                fontSize: preferences.editorFontSize ?? 16,
                lineHeight: preferences.editorLineHeight ?? 1.5,
              }}
              spellCheck={false}
            />
            {file.mode === 'document' && document?.source && (
              <Suspense fallback={<p className="document-limit">{t('正在打开文档编辑器…')}</p>}>
                <DocumentEditor
                  key={file.path + ':' + file.generation}
                  source={document.source}
                  text={file.text}
                  memory={file.document}
                  readonly={readonly}
                  onChange={(text, document) => updateTab(file.path, { text, document })}
                />
              </Suspense>
            )}
            {file.mode === 'preview' && (
              <div
                className="file-preview"
                role="region"
                aria-label={t('文件预览')}
                style={{
                  fontSize: preferences.editorFontSize ?? 16,
                  lineHeight: preferences.editorLineHeight ?? 1.5,
                }}
              >
                {markdownFile ? <Markdown text={file.text} /> : <pre>{file.text}</pre>}
              </div>
            )}
            {fileMenu && (
              <div
                ref={operations}
                className="file-operations"
                role="group"
                aria-label={t('文件显示与操作')}
              >
                <div className="file-view-modes" role="group" aria-label={t('文件显示方式')}>
                  {markdownFile && (
                    <button
                      aria-label={document?.source ? t('文档') : t('文档 · 即将提供')}
                      aria-pressed={file.mode === 'document'}
                      disabled={!document?.source}
                      title={document?.reason ?? t('直接编辑排版后的文档')}
                      onClick={() => chooseFileMode('document')}
                    >
                      {t('文档')}
                      {!document?.source && <small>{t('即将提供')}</small>}
                    </button>
                  )}
                  <button
                    aria-pressed={file.mode === 'source'}
                    onClick={() => chooseFileMode('source')}
                  >
                    {t('源码')}
                  </button>
                </div>
                <button
                  disabled={readonly || busy || file.text !== file.saved}
                  onClick={() => {
                    setManaged(file.path);
                    setFileMenu(false);
                  }}
                >
                  {t('移动 / 复制 / 回收')}
                </button>
                <button
                  onClick={() => {
                    setFileMenu(false);
                    fileActions.current?.focus();
                  }}
                >
                  {t('收起操作')}
                </button>
              </div>
            )}
            {history && (
              <div className="file-history">
                <button
                  className="history-close"
                  aria-label={t('关闭文件历史')}
                  onClick={() => setHistory(null)}
                >
                  <Icon name="close" size={13} />
                </button>
                <h3>{t('已保存的旧版本')}</h3>
                {history.length ? (
                  history.map((v) => (
                    <div key={v.id}>
                      <span>
                        {new Date(v.createdAt).toLocaleString(currentLocaleTag(), {
                          timeZone: preferences.timezone,
                        })}
                        {' · '}
                        {v.bytes} {t('字节')}
                      </span>
                      <button
                        disabled={readonly || busy}
                        onClick={() => {
                          if (
                            file.text !== file.saved &&
                            !window.confirm(t('恢复将放弃未保存的编辑草稿，是否继续？'))
                          )
                            return;
                          setBusy(true);
                          void api(prefix + '/file-restore', 'POST', {
                            path: file.path,
                            versionId: v.id,
                            expectedHash: file.sha256,
                          })
                            .then(async () => {
                              await openFile(file.path, true);
                              setHistory(null);
                              report(t('已恢复；恢复前版本也已保留'));
                            })
                            .catch(report)
                            .finally(() => setBusy(false));
                        }}
                      >
                        {t('恢复到此版本')}
                      </button>
                    </div>
                  ))
                ) : (
                  <p>{t('暂时没有旧版本；覆盖保存时会保留当前磁盘内容。')}</p>
                )}
              </div>
            )}
            <div className="form-actions">
              <span className="muted">
                {file.text === file.saved ? t('已保存') : t('有未保存的修改')}{' '}
                {t('· 隐藏查看器后草稿仍保留')}
              </span>
              <button
                className="primary"
                disabled={readonly || busy || file.text === file.saved}
                onClick={() => void save()}
                title={t('保存文件 · Ctrl+S')}
              >
                {t('保存文件')}
              </button>
            </div>
            <div className="file-draft-status" role="status">
              <span>
                {t(draftStatus)} {t('· 源文件仍需手动保存')}
              </span>
              {draftFailed && (
                <button onClick={() => void flushFileDrafts().catch(report)}>
                  {t('重试保存草稿')}
                </button>
              )}
            </div>
          </div>
        </section>
      )}
      {managed && (
        <WorkspaceActions
          session={session}
          target={managed}
          readonly={!!readonly}
          dirty={tabs.some((tab) => containsFile(managed, tab.path) && tab.text !== tab.saved)}
          onClose={() => setManaged(null)}
          onChanged={itemChanged}
        />
      )}
      {operation && (
        <Modal
          title={
            {
              'create-file': t('新建文件'),
              'create-directory': t('新建目录'),
            }[operation]
          }
          onClose={() => setOperation(null)}
        >
          <form
            className="editor-form"
            onSubmit={(e) => {
              e.preventDefault();
              void applyOperation();
            }}
          >
            <Field label={t('文件路径')} hint={t('相对于当前目录，已有目标不会覆盖')}>
              <input required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="form-actions">
              <button type="button" onClick={() => setOperation(null)}>
                {t('取消')}
              </button>
              <button className="primary" disabled={busy}>
                {t('确认文件操作')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </aside>
  );
}
