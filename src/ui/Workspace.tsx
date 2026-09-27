import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Session, Preferences, Stored } from '../shared/contracts.ts';
import { api } from './api.ts';
import { Icon, Modal, Field } from './components.tsx';

interface FileTab {
  path: string;
  text: string;
  saved: string;
  sha256: string;
  scroll: number;
  changed: boolean;
}
interface Version extends Stored {
  path: string;
  sha256: string;
  bytes: number;
}
const drafts = new Map<string, { tabs: FileTab[]; active: string | null }>();
export const hasUnsavedFiles = () =>
  [...drafts.values()].some((value) => value.tabs.some((t) => t.text !== t.saved));
export const discardFileDrafts = () => drafts.clear();
export function Workspace({
  session,
  preferences,
  choose,
  report,
}: {
  session: Session;
  preferences: Preferences;
  choose: () => Promise<void>;
  report: (e: unknown) => void;
}) {
  const key = session.id + '|' + session.workspace,
    prefix = `/sessions/${session.id}`;
  const [folder, setFolder] = useState('.'),
    [entries, setEntries] = useState<{ name: string; kind: string }[]>([]),
    [truncated, setTruncated] = useState(false),
    [loading, setLoading] = useState(false),
    [filter, setFilter] = useState('');
  const [tabs, setTabs] = useState<FileTab[]>(() => drafts.get(key)?.tabs ?? []),
    [active, setActive] = useState<string | null>(() => drafts.get(key)?.active ?? null),
    [show, setShow] = useState(!!drafts.get(key)?.tabs.length),
    [watchState, setWatchState] = useState('正在连接文件变化通知…');
  const [operation, setOperation] = useState<
      'create-file' | 'create-directory' | 'rename' | 'copy' | null
    >(null),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [history, setHistory] = useState<Version[] | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null),
    tabRef = useRef(tabs),
    listRequest = useRef(0),
    file = tabs.find((t) => t.path === active);
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
  }, [key, tabs, active]);
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
  }, [active, show]);
  function updateTab(target: string, values: Partial<FileTab>) {
    setTabs((old) => old.map((t) => (t.path === target ? { ...t, ...values } : t)));
  }
  async function openFile(target: string, refresh = false) {
    const old = tabRef.current.find((t) => t.path === target);
    if (old && !refresh) {
      setActive(target);
      setShow(true);
      return;
    }
    if (!old && tabs.length >= 10) {
      report('最多打开 10 个文件，请先关闭一个标签');
      return;
    }
    const value = await api<{ path: string; text: string; sha256: string }>(
      `${prefix}/file?path=${encodeURIComponent(target)}`,
    );
    const tab: FileTab = { ...value, saved: value.text, scroll: old?.scroll ?? 0, changed: false };
    setTabs((t) => (old ? t.map((x) => (x.path === target ? tab : x)) : [...t, tab]));
    setActive(target);
    setShow(true);
  }
  function closeTab(target: string) {
    const tab = tabs.find((t) => t.path === target);
    if (tab && tab.text !== tab.saved && !window.confirm('放弃此文件未保存的修改？')) return;
    const next = tabs.filter((t) => t.path !== target);
    setTabs(next);
    if (active === target) setActive(next.at(-1)?.path ?? null);
    if (!next.length) setShow(false);
  }
  async function save() {
    if (!file) return;
    const target = file.path,
      text = file.text;
    setBusy(true);
    try {
      const r = await api<{ sha256: string }>(prefix + '/file', 'PUT', {
        path: target,
        text,
        expectedHash: file.sha256,
      });
      updateTab(target, { saved: text, sha256: r.sha256, changed: false });
      report('文件已保存');
      await load();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function applyOperation() {
    if (!operation) return;
    setBusy(true);
    try {
      const target = (folder === '.' ? '' : folder + '/') + name;
      await api(
        prefix + '/file-operation',
        'POST',
        operation === 'rename' || operation === 'copy'
          ? { operation, path: file?.path, destination: name, expectedHash: file?.sha256 }
          : { operation, path: target, text: '' },
      );
      if (operation === 'rename' && file) {
        updateTab(file.path, { path: name });
        setActive(name);
      }
      setOperation(null);
      await load();
      if (operation === 'create-file') await openFile(target);
      report('文件操作已完成');
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  const readonly = session.permission === 'read';
  return (
    <aside className="workspace-panel">
      <div className="section-heading">
        <h3>工作区</h3>
        <button className="icon-button" aria-label="更换工作区" onClick={() => void choose()}>
          <Icon name="folder" />
        </button>
      </div>
      {!session.workspace ? (
        <div className="panel-empty">
          <p>为这个会话选择一个文件夹</p>
          <button onClick={() => void choose()}>选择工作区</button>
        </div>
      ) : (
        <>
          <div className="workspace-path">{session.workspace}</div>
          <p className="watch-state" role="status">
            {watchState}
          </p>
          <div className="file-crumb">
            <button onClick={() => setFolder('.')}>根目录</button>
            <button
              disabled={folder === '.'}
              onClick={() =>
                setFolder(folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '.')
              }
            >
              上一级
            </button>
            <span>{folder}</span>
            <button onClick={() => void load().catch(report)}>刷新</button>
          </div>
          <input
            aria-label="筛选当前目录"
            placeholder="筛选文件名"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="file-operations">
            <button
              disabled={readonly}
              onClick={() => {
                setName('');
                setOperation('create-file');
              }}
            >
              新建文件
            </button>
            <button
              disabled={readonly}
              onClick={() => {
                setName('');
                setOperation('create-directory');
              }}
            >
              新建目录
            </button>
          </div>
          {loading ? (
            <p className="muted">正在读取…</p>
          ) : (
            <div className="file-list">
              {entries
                .filter((e) => e.name.toLowerCase().includes(filter.toLowerCase()))
                .map((e) => (
                  <button
                    key={e.name}
                    disabled={e.kind === 'link'}
                    onClick={() => {
                      const target = (folder === '.' ? '' : folder + '/') + e.name;
                      if (e.kind === 'directory') setFolder(target);
                      else void openFile(target).catch(report);
                    }}
                  >
                    <Icon name={e.kind === 'directory' ? 'folder' : 'memory'} size={15} />
                    <span>{e.name}</span>
                  </button>
                ))}
              {!entries.length && <p className="muted">此目录为空</p>}
              {truncated && <p className="inline-error">目录超过 500 项，只显示前 500 项。</p>}
            </div>
          )}
          {!!tabs.length && (
            <button className="reopen-files" onClick={() => setShow(true)}>
              已打开 {tabs.length} 个文件
              {tabs.some((t) => t.text !== t.saved) ? ' · 有未保存修改' : ''}
            </button>
          )}
        </>
      )}
      {show && file && (
        <Modal title="工作区文件" onClose={() => setShow(false)} wide>
          <div className="file-editor">
            <div className="file-tabs" role="tablist" aria-label="打开的文件">
              {tabs.map((tab) => (
                <div key={tab.path}>
                  <button
                    role="tab"
                    aria-selected={tab.path === active}
                    onClick={() => setActive(tab.path)}
                  >
                    {tab.path}
                    {tab.text !== tab.saved ? ' *' : ''}
                  </button>
                  <button aria-label={'关闭文件 ' + tab.path} onClick={() => closeTab(tab.path)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
            {file.changed && (
              <p role="alert" className="inline-error">
                磁盘文件已变化。编辑草稿保留；保存会校验原版本。
                <button
                  onClick={() => {
                    if (
                      file.text === file.saved ||
                      window.confirm('放弃编辑草稿并重新读取磁盘版本？')
                    )
                      void openFile(file.path, true).catch(report);
                  }}
                >
                  重新读取
                </button>
              </p>
            )}
            <textarea
              ref={editor}
              aria-label="文件内容"
              value={file.text}
              onChange={(e) => updateTab(file.path, { text: e.target.value })}
              onScroll={(e) => updateTab(file.path, { scroll: e.currentTarget.scrollTop })}
              style={{
                fontSize: preferences.editorFontSize ?? 13,
                lineHeight: preferences.editorLineHeight ?? 1.7,
              }}
              spellCheck={false}
            />
            <div className="file-operations">
              <button
                disabled={readonly || busy || file.text !== file.saved}
                onClick={() => {
                  setName(file.path);
                  setOperation('rename');
                }}
              >
                重命名 / 移动
              </button>
              <button
                disabled={readonly || busy || file.text !== file.saved}
                onClick={() => {
                  setName(file.path + '.copy');
                  setOperation('copy');
                }}
              >
                复制文件
              </button>
              <button
                onClick={() =>
                  void api<Version[]>(
                    `${prefix}/file-history?path=${encodeURIComponent(file.path)}`,
                  )
                    .then(setHistory)
                    .catch(report)
                }
              >
                文件历史
              </button>
            </div>
            {history && (
              <div className="file-history">
                <h3>已保存的旧版本</h3>
                {history.length ? (
                  history.map((v) => (
                    <div key={v.id}>
                      <span>
                        {new Date(v.createdAt).toLocaleString('zh-CN', {
                          timeZone: preferences.timezone,
                        })}
                        {' · '}
                        {v.bytes} 字节
                      </span>
                      <button
                        disabled={readonly || busy}
                        onClick={() => {
                          if (
                            file.text !== file.saved &&
                            !window.confirm('恢复将放弃未保存的编辑草稿，是否继续？')
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
                              report('已恢复；恢复前版本也已保留');
                            })
                            .catch(report)
                            .finally(() => setBusy(false));
                        }}
                      >
                        恢复到此版本
                      </button>
                    </div>
                  ))
                ) : (
                  <p>暂时没有旧版本；覆盖保存时会保留当前磁盘内容。</p>
                )}
              </div>
            )}
            <div className="form-actions">
              <span className="muted">
                {file.text === file.saved ? '已保存' : '有未保存的修改'} · 隐藏查看器后草稿仍保留
              </span>
              <button
                className="primary"
                disabled={readonly || busy || file.text === file.saved}
                onClick={() => void save()}
              >
                保存文件
              </button>
            </div>
          </div>
        </Modal>
      )}
      {operation && (
        <Modal
          title={
            {
              'create-file': '新建文件',
              'create-directory': '新建目录',
              rename: '重命名 / 移动文件',
              copy: '复制文件',
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
            <Field
              label="文件路径"
              hint={
                operation.startsWith('create')
                  ? '相对于当前目录，已有目标不会覆盖'
                  : '相对于工作区根目录，已有目标不会覆盖'
              }
            >
              <input required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="form-actions">
              <button type="button" onClick={() => setOperation(null)}>
                取消
              </button>
              <button className="primary" disabled={busy}>
                确认文件操作
              </button>
            </div>
          </form>
        </Modal>
      )}
    </aside>
  );
}
