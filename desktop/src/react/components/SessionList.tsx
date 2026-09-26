import { copyTextToClipboard } from '../utils/clipboard';
/**
 * SessionList — 侧边栏 session 列表 React 组件
 *
 * Phase 6B: 替代 sidebar-shim.ts 中的 renderSessionList / createSessionItem。
 * 通过 portal 渲染到 #sessionList，从 Zustand sessions 状态驱动。
 */

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Collapse } from '@/ui';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { formatSessionDate } from '../utils/format';
import { switchSession, archiveSession, renameSession, pinSession, createNewSession, reorderPinnedSessions } from '../stores/session-actions';
import { locateSearchHit } from '../stores/chat-find-actions';
import { setBrowserStateForPath } from '../stores/browser-slice';
import { sessionScopedListIncludes } from '../stores/session-slice';
import type { Session, Agent } from '../types';
import { AgentAvatar, resolveAgentDisplayInfo } from '../utils/agent-display';
import {
  autoProjectIdForCwd,
  buildSessionProjectView,
  buildSessionSections,
  type SessionViewMode,
} from './session-sections';
import type { SessionProjectFolderGroup, SessionProjectGroup } from '../types/session-projects';
import {
  createSessionProjectInCatalog,
  deleteSessionProjectFolderFromCatalog,
  deleteSessionProjectFromCatalog,
  loadSessionProjectCatalog,
  patchSessionProjectFolderInCatalog,
  patchSessionProjectInCatalog,
  reorderSessionProjectFoldersInCatalog,
  reorderSessionProjectsInCatalog,
  setSessionProjectAssignmentForSession,
} from '../stores/session-project-actions';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { renderMarkdown } from '../utils/markdown';
import { cwdFromAutoProjectId } from '../../../../shared/session-projects.ts';
import type { SidebarSessionListRowMode } from '../../../../shared/sidebar-ui-state.ts';
import { FolderIcon } from './shared/FolderIcon';
import styles from './SessionList.module.css';

const SESSION_VIEW_MODE_KEY = 'hana-session-sidebar-view-mode';
const SESSION_DRAG_MIME = 'application/x-hana-session-path';
const PROJECT_DRAG_MIME = 'application/x-hana-project-id';
const FOLDER_DRAG_MIME = 'application/x-hana-project-folder-id';
const PROJECT_SESSION_PREVIEW_LIMIT = 5;

type SidebarDragState =
  | { kind: 'session'; sessionPath: string }
  | { kind: 'pinned-session'; sessionPath: string; sessionId: string | null }
  | { kind: 'project'; projectId: string }
  | { kind: 'folder'; folderId: string }
  | null;

// 置顶区拖拽重排时的插入指示线位置：落在目标行的上边还是下边
type PinnedDropTarget = { sessionPath: string; edge: 'before' | 'after' } | null;

type ProjectNameDialogState =
  | { kind: 'create-project'; value: string }
  | { kind: 'rename-project'; projectId: string; value: string }
  | { kind: 'rename-folder'; folderId: string; value: string }
  | null;

type ProjectActionMenuState = {
  position: { x: number; y: number };
  project: SessionProjectGroup;
} | null;

type FolderActionMenuState = {
  position: { x: number; y: number };
  folder: SessionProjectFolderGroup;
} | null;

interface BrowserSessionState {
  url: string | null;
  running: boolean;
  resumable: boolean;
  unavailableReason: string | null;
}

interface SessionSearchResult extends Session {
  matchKind: 'title' | 'content';
  snippet: string;
  score?: number;
}

function normalizeBrowserSessionStates(data: unknown): Record<string, BrowserSessionState> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const result: Record<string, BrowserSessionState> = {};
  for (const [sessionPath, rawState] of Object.entries(data as Record<string, unknown>)) {
    if (typeof rawState === 'string') {
      result[sessionPath] = {
        url: rawState,
        running: false,
        resumable: true,
        unavailableReason: null,
      };
      continue;
    }
    if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) continue;
    const state = rawState as Partial<BrowserSessionState>;
    result[sessionPath] = {
      url: typeof state.url === 'string' ? state.url : null,
      running: state.running === true,
      resumable: state.resumable !== false,
      unavailableReason: typeof state.unavailableReason === 'string' ? state.unavailableReason : null,
    };
  }
  return result;
}

function normalizeSessionSearchResults(data: unknown): SessionSearchResult[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((raw): SessionSearchResult[] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const item = raw as Partial<SessionSearchResult>;
    if (typeof item.path !== 'string' || !item.path) return [];
    return [{
      path: item.path,
      sessionId: typeof item.sessionId === 'string' ? item.sessionId : null,
      title: typeof item.title === 'string' ? item.title : null,
      firstMessage: typeof item.firstMessage === 'string' ? item.firstMessage : '',
      modified: typeof item.modified === 'string' ? item.modified : '',
      messageCount: typeof item.messageCount === 'number' ? item.messageCount : 0,
      agentId: typeof item.agentId === 'string' ? item.agentId : null,
      agentName: typeof item.agentName === 'string' ? item.agentName : null,
      cwd: typeof item.cwd === 'string' ? item.cwd : null,
      projectId: typeof item.projectId === 'string' ? item.projectId : null,
      pinnedAt: typeof item.pinnedAt === 'string' ? item.pinnedAt : null,
      pinOrder: typeof item.pinOrder === 'number' ? item.pinOrder : null,
      hasSummary: item.hasSummary === true,
      rcAttachment: null,
      agentDeleted: item.agentDeleted === true,
      readOnlyReason: typeof item.readOnlyReason === 'string' ? item.readOnlyReason : undefined,
      continuationAvailable: item.continuationAvailable === true,
      deletedAt: typeof item.deletedAt === 'string' ? item.deletedAt : undefined,
      matchKind: item.matchKind === 'content' ? 'content' : 'title',
      snippet: typeof item.snippet === 'string' ? item.snippet : '',
      score: typeof item.score === 'number' ? item.score : undefined,
    }];
  });
}

function readInitialSessionViewMode(): SessionViewMode {
  try {
    return window.localStorage?.getItem(SESSION_VIEW_MODE_KEY) === 'project' ? 'project' : 'time';
  } catch {
    return 'time';
  }
}

function dragSessionPath(event: React.DragEvent, state: SidebarDragState): string | null {
  const fromState = state?.kind === 'session' ? state.sessionPath : null;
  return event.dataTransfer.getData(SESSION_DRAG_MIME) || fromState;
}

function dragProjectId(event: React.DragEvent, state: SidebarDragState): string | null {
  const fromState = state?.kind === 'project' ? state.projectId : null;
  return event.dataTransfer.getData(PROJECT_DRAG_MIME) || fromState;
}

function dragFolderId(event: React.DragEvent, state: SidebarDragState): string | null {
  const fromState = state?.kind === 'folder' ? state.folderId : null;
  return event.dataTransfer.getData(FOLDER_DRAG_MIME) || fromState;
}

// ── 主组件 ──

export function SessionList() {
  return <SessionListInner />;
}

// ── 内部组件 ──

function SessionListInner() {
  const { t } = useI18n();
  const sessions = useStore(s => s.sessions);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const pendingSessionSwitchPath = useStore(s => s.pendingSessionSwitchPath);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const agents = useStore(s => s.agents);
  const streamingSessions = useStore(s => s.streamingSessions);
  const unreadOutputSessionPaths = useStore(s => s.unreadOutputSessionPaths);
  const browserBySession = useStore(s => s.browserBySession);
  const projectCatalog = useStore(s => s.sessionProjectCatalog);
  const projectCatalogLoaded = useStore(s => s.sessionProjectCatalogLoaded);
  const metaRecovery = useStore(s => s.metaRecovery);
  // 侧边栏 UI 偏好归 store：本组件有多个实例（主侧栏 / 悬浮侧栏），
  // 重挂载时直接读已加载的值，不再各自拉取、也就没有默认双行的首帧。
  const sidebarUiPrefs = useStore(s => s.sidebarUiPrefs);
  const setSidebarProjectViewPrefs = useStore(s => s.setSidebarProjectViewPrefs);
  const sessionListRowMode: SidebarSessionListRowMode = sidebarUiPrefs.sessionList.rowMode;
  const collapsedProjectIds = useMemo(
    () => new Set(sidebarUiPrefs.projectView.collapsedProjectIds),
    [sidebarUiPrefs],
  );
  const collapsedFolderIds = useMemo(
    () => new Set(sidebarUiPrefs.projectView.collapsedFolderIds),
    [sidebarUiPrefs],
  );
  const showAllProjectIds = useMemo(
    () => new Set(sidebarUiPrefs.projectView.showAllProjectIds),
    [sidebarUiPrefs],
  );

  const [browserSessions, setBrowserSessions] = useState<Record<string, BrowserSessionState>>({});
  const [viewMode, setViewModeState] = useState<SessionViewMode>(readInitialSessionViewMode);
  const [projectMenuPosition, setProjectMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [projectActionMenu, setProjectActionMenu] = useState<ProjectActionMenuState>(null);
  const [folderActionMenu, setFolderActionMenu] = useState<FolderActionMenuState>(null);
  const [projectNameDialog, setProjectNameDialog] = useState<ProjectNameDialogState>(null);
  const [dragState, setDragState] = useState<SidebarDragState>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [pinnedDropTarget, setPinnedDropTarget] = useState<PinnedDropTarget>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [titleResults, setTitleResults] = useState<SessionSearchResult[]>([]);
  const [contentResults, setContentResults] = useState<SessionSearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<'idle' | 'title' | 'content' | 'done' | 'error'>('idle');
  const closingBrowserSessionsRef = useRef(new Set<string>());
  const projectNameInputRef = useRef<HTMLInputElement>(null);
  const searchQueryTrimmed = searchQuery.trim();
  const sessionsSignature = useMemo(() => (
    sessions.map(s => `${s.path}:${s.title || ''}:${s.modified || ''}:${s.messageCount}:${s.projectId || ''}`).join('\n')
  ), [sessions]);

  const setVisibleBrowserSessions = useCallback((data: unknown) => {
    const states = normalizeBrowserSessionStates(data);
    for (const sessionPath of closingBrowserSessionsRef.current) {
      delete states[sessionPath];
    }
    setBrowserSessions(states);
  }, []);

  // Fetch browser sessions (re-fetch when browser state changes)
  useEffect(() => {
    let cancelled = false;
    if (sessions.length === 0) {
      setBrowserSessions({});
      return;
    }
    hanaFetch('/api/browser/session-states')
      .then(r => r.json())
      .then(data => {
        if (!cancelled) setVisibleBrowserSessions(data);
      })
      .catch(err => console.warn('[sessions] fetch browser sessions failed:', err));
    return () => {
      cancelled = true;
    };
  }, [sessions, browserBySession, setVisibleBrowserSessions]);

  useEffect(() => {
    if (!searchQueryTrimmed) {
      setTitleResults([]);
      setContentResults([]);
      setSearchStatus('idle');
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setTitleResults([]);
    setContentResults([]);
    setSearchStatus('title');

    const timer = window.setTimeout(async () => {
      const encodedQuery = encodeURIComponent(searchQueryTrimmed);
      try {
        const titleRes = await hanaFetch(`/api/sessions/search?q=${encodedQuery}&phase=title&limit=20`, {
          signal: controller.signal,
          timeout: 12_000,
        });
        const titleData = await titleRes.json();
        if (cancelled) return;
        setTitleResults(normalizeSessionSearchResults(titleData));
        setSearchStatus('content');

        const contentRes = await hanaFetch(`/api/sessions/search?q=${encodedQuery}&phase=content&limit=20`, {
          signal: controller.signal,
          timeout: 12_000,
        });
        const contentData = await contentRes.json();
        if (cancelled) return;
        setContentResults(normalizeSessionSearchResults(contentData));
        setSearchStatus('done');
      } catch (err) {
        if (controller.signal.aborted || cancelled) return;
        console.warn('[sessions] search failed:', err);
        setSearchStatus('error');
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchQueryTrimmed, sessionsSignature]);

  const setViewMode = useCallback((mode: SessionViewMode) => {
    setViewModeState(mode);
    try {
      window.localStorage?.setItem(SESSION_VIEW_MODE_KEY, mode);
    } catch {
      // localStorage can be unavailable in tests or privacy modes.
    }
  }, []);

  useEffect(() => {
    if (viewMode !== 'project') return;
    loadSessionProjectCatalog()
      .catch(err => console.warn('[sessions] fetch project catalog failed:', err));
  }, [viewMode]);

  useEffect(() => {
    if (!projectNameDialog) return;
    window.setTimeout(() => {
      projectNameInputRef.current?.focus();
      projectNameInputRef.current?.select();
    }, 0);
  }, [projectNameDialog]);

  const handleCloseBrowserSession = useCallback(async (sessionPath: string) => {
    closingBrowserSessionsRef.current.add(sessionPath);
    setBrowserSessions(prev => {
      const next = { ...prev };
      delete next[sessionPath];
      return next;
    });
    try {
      const res = await hanaFetch('/api/browser/close-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionPath }),
      });
      const data = await res.json();
      setBrowserStateForPath(sessionPath, { running: false, url: null, thumbnail: null });
      closingBrowserSessionsRef.current.delete(sessionPath);
      if (data?.sessions) {
        setBrowserSessions(normalizeBrowserSessionStates(data.sessions));
      }
    } catch (err) {
      closingBrowserSessionsRef.current.delete(sessionPath);
      console.warn('[sessions] close browser session failed:', err);
    }
  }, []);

  const updateSessionProjectAssignment = useCallback(async (sessionPath: string, projectId: string | null) => {
    await setSessionProjectAssignmentForSession(sessionPath, projectId);
  }, []);

  const patchProject = useCallback(async (projectId: string, patch: { folderId?: string | null; name?: string }) => {
    return patchSessionProjectInCatalog(projectId, patch);
  }, []);

  const patchFolder = useCallback(async (folderId: string, patch: { name?: string }) => {
    return patchSessionProjectFolderInCatalog(folderId, patch);
  }, []);

  const reorderProjects = useCallback(async (folderId: string | null, projectIds: string[]) => {
    await reorderSessionProjectsInCatalog(folderId, projectIds);
  }, []);

  const reorderFolders = useCallback(async (folderIds: string[]) => {
    await reorderSessionProjectFoldersInCatalog(folderIds);
  }, []);

  const createProject = useCallback(async (name: string) => {
    await createSessionProjectInCatalog({ name, folderId: null });
  }, []);

  const deleteProject = useCallback(async (project: SessionProjectGroup) => {
    const confirmed = window.confirm?.(t('sidebar.projects.deleteProjectConfirm', { name: project.name }));
    if (!confirmed) return;
    await deleteSessionProjectFromCatalog(project.id, project.items.map(item => item.path));
    if (!collapsedProjectIds.has(project.id) && !showAllProjectIds.has(project.id)) return;
    const nextCollapsed = new Set(collapsedProjectIds);
    nextCollapsed.delete(project.id);
    const nextShowAll = new Set(showAllProjectIds);
    nextShowAll.delete(project.id);
    setSidebarProjectViewPrefs({
      collapsedProjectIds: [...nextCollapsed],
      showAllProjectIds: [...nextShowAll],
    });
  }, [collapsedProjectIds, setSidebarProjectViewPrefs, showAllProjectIds, t]);

  const deleteFolder = useCallback(async (folder: SessionProjectFolderGroup) => {
    const confirmed = window.confirm?.(t('sidebar.projects.deleteFolderConfirm', { name: folder.name }));
    if (!confirmed) return;
    await deleteSessionProjectFolderFromCatalog(folder.id);
    if (!collapsedFolderIds.has(folder.id)) return;
    const next = new Set(collapsedFolderIds);
    next.delete(folder.id);
    setSidebarProjectViewPrefs({ collapsedFolderIds: [...next] });
  }, [collapsedFolderIds, setSidebarProjectViewPrefs, t]);

  const handleCreateProjectSession = useCallback((project: SessionProjectGroup) => {
    if (project.source === 'cwd') {
      const cwd = cwdFromAutoProjectId(project.id);
      void createNewSession({ cwd });
      return;
    }
    void createNewSession({ projectId: project.id, cwd: null });
  }, []);

  const handleProjectNameDialogSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectNameDialog) return;
    const name = projectNameDialog.value.trim();
    if (!name) return;
    if (projectNameDialog.kind === 'create-project') {
      await createProject(name);
    } else if (projectNameDialog.kind === 'rename-project') {
      await patchProject(projectNameDialog.projectId, { name });
    } else {
      await patchFolder(projectNameDialog.folderId, { name });
    }
    setProjectNameDialog(null);
  }, [createProject, patchFolder, patchProject, projectNameDialog]);

  const handleSessionDragStart = useCallback((event: React.DragEvent, session: Session) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(SESSION_DRAG_MIME, session.path);
    setDragState({ kind: 'session', sessionPath: session.path });
  }, []);

  const handleProjectDragStart = useCallback((event: React.DragEvent, projectId: string) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(PROJECT_DRAG_MIME, projectId);
    setDragState({ kind: 'project', projectId });
  }, []);

  const handleFolderDragStart = useCallback((event: React.DragEvent, folderId: string) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(FOLDER_DRAG_MIME, folderId);
    setDragState({ kind: 'folder', folderId });
  }, []);

  const clearDragState = useCallback(() => {
    setDragState(null);
    setDropTargetId(null);
    setPinnedDropTarget(null);
  }, []);

  // ── 置顶区内拖拽重排 ──

  const handlePinnedDragStart = useCallback((event: React.DragEvent, session: Session) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(SESSION_DRAG_MIME, session.path);
    setDragState({
      kind: 'pinned-session',
      sessionPath: session.path,
      sessionId: session.sessionId || null,
    });
  }, []);

  const handlePinnedDragOver = useCallback((event: React.DragEvent, session: Session) => {
    if (dragState?.kind !== 'pinned-session') return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const edge = event.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
    setPinnedDropTarget({ sessionPath: session.path, edge });
  }, [dragState]);

  const handlePinnedDragLeave = useCallback((event: React.DragEvent) => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setPinnedDropTarget(current => (
      current && current.sessionPath === (event.currentTarget as HTMLElement).dataset.pinnedSessionPath
        ? null
        : current
    ));
  }, []);

  const handlePinnedDrop = useCallback((
    event: React.DragEvent,
    target: Session,
    pinnedItems: Session[],
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const draggedPath = dragState?.kind === 'pinned-session' ? dragState.sessionPath : null;
    const edge = pinnedDropTarget?.sessionPath === target.path ? pinnedDropTarget.edge : 'before';
    clearDragState();
    if (!draggedPath || draggedPath === target.path) return;
    // 缺 sessionId 就没有可提交的身份，整区不重排（门控见 pinnedReorderEnabled）
    if (pinnedItems.some(session => !session.sessionId)) return;
    const dragged = pinnedItems.find(session => session.path === draggedPath);
    if (!dragged) return;
    const ordered = pinnedItems.filter(session => session.path !== draggedPath);
    const targetIndex = ordered.findIndex(session => session.path === target.path);
    if (targetIndex < 0) return;
    ordered.splice(edge === 'after' ? targetIndex + 1 : targetIndex, 0, dragged);
    void reorderPinnedSessions(ordered.map(session => session.sessionId as string));
  }, [clearDragState, dragState, pinnedDropTarget]);

  const ensureCatalogProject = useCallback(async (project: SessionProjectGroup, folderId: string | null = project.folderId) => {
    const existing = projectCatalog.projects.find(item => item.id === project.id);
    if (existing && existing.folderId === folderId) return;
    await patchProject(project.id, { name: project.name, folderId });
  }, [patchProject, projectCatalog.projects]);

  const handleDropOnProject = useCallback(async (event: React.DragEvent, project: SessionProjectGroup) => {
    event.preventDefault();
    event.stopPropagation();
    // 置顶区的行只在置顶区内重排，不接受落到项目/文件夹/根上
    if (dragState?.kind === 'pinned-session') { clearDragState(); return; }
    const sessionPath = dragSessionPath(event, dragState);
    const projectId = dragProjectId(event, dragState);
    clearDragState();
    if (sessionPath) {
      const session = sessions.find(item => item.path === sessionPath) || null;
      const ownCwdProject = session ? autoProjectIdForCwd(session.cwd) : null;
      const assignmentId = project.source === 'cwd' && ownCwdProject === project.id ? null : project.id;
      await updateSessionProjectAssignment(sessionPath, assignmentId);
      return;
    }
    if (projectId && projectId !== project.id) {
      const visibleView = buildSessionProjectView(sessions, projectCatalog);
      const visibleProjects = [
        ...visibleView.rootProjects,
        ...visibleView.folders.flatMap(folder => folder.projects),
      ];
      const draggedProject = visibleProjects.find(item => item.id === projectId) || null;
      if (!draggedProject) return;
      const targetFolderId = project.folderId || null;
      const levelProjects = visibleProjects.filter(item => (item.folderId || null) === targetFolderId);
      const nextProjectIds = levelProjects
        .map(item => item.id)
        .filter(id => id !== projectId);
      const insertIndex = nextProjectIds.indexOf(project.id);
      nextProjectIds.splice(insertIndex >= 0 ? insertIndex : nextProjectIds.length, 0, projectId);
      for (const id of nextProjectIds) {
        const visibleProject = visibleProjects.find(item => item.id === id);
        if (visibleProject) await ensureCatalogProject(visibleProject, targetFolderId);
      }
      await reorderProjects(targetFolderId, nextProjectIds);
    }
  }, [clearDragState, dragState, ensureCatalogProject, projectCatalog, reorderProjects, sessions, updateSessionProjectAssignment]);

  const handleDropOnProjectRoot = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    // 置顶区的行只在置顶区内重排，不接受落到项目/文件夹/根上
    if (dragState?.kind === 'pinned-session') { clearDragState(); return; }
    const projectId = dragProjectId(event, dragState);
    clearDragState();
    if (!projectId) return;
    const visibleView = buildSessionProjectView(sessions, projectCatalog);
    const visibleProjects = [
      ...visibleView.rootProjects,
      ...visibleView.folders.flatMap(folder => folder.projects),
    ];
    const draggedProject = visibleProjects.find(item => item.id === projectId) || null;
    if (!draggedProject) return;
    const nextProjectIds = visibleView.rootProjects
      .map(item => item.id)
      .filter(id => id !== projectId);
    nextProjectIds.push(projectId);
    await ensureCatalogProject(draggedProject, null);
    await reorderProjects(null, nextProjectIds);
  }, [clearDragState, dragState, ensureCatalogProject, projectCatalog, reorderProjects, sessions]);

  const handleDropOnFolder = useCallback(async (event: React.DragEvent, folder: SessionProjectFolderGroup) => {
    event.preventDefault();
    event.stopPropagation();
    // 置顶区的行只在置顶区内重排，不接受落到项目/文件夹/根上
    if (dragState?.kind === 'pinned-session') { clearDragState(); return; }
    const projectId = dragProjectId(event, dragState);
    const folderId = dragFolderId(event, dragState);
    clearDragState();
    const visibleView = buildSessionProjectView(sessions, projectCatalog);
    if (projectId) {
      const visibleProjects = [
        ...visibleView.rootProjects,
        ...visibleView.folders.flatMap(item => item.projects),
      ];
      const draggedProject = visibleProjects.find(item => item.id === projectId) || null;
      if (!draggedProject) return;
      const nextProjectIds = folder.projects
        .map(item => item.id)
        .filter(id => id !== projectId);
      nextProjectIds.push(projectId);
      await ensureCatalogProject(draggedProject, folder.id);
      await reorderProjects(folder.id, nextProjectIds);
      return;
    }
    if (folderId && folderId !== folder.id) {
      const nextFolderIds = visibleView.folders
        .map(item => item.id)
        .filter(id => id !== folderId);
      const insertIndex = nextFolderIds.indexOf(folder.id);
      nextFolderIds.splice(insertIndex >= 0 ? insertIndex : nextFolderIds.length, 0, folderId);
      await reorderFolders(nextFolderIds);
    }
  }, [clearDragState, dragState, ensureCatalogProject, projectCatalog, reorderFolders, reorderProjects, sessions]);

  const activeSessionPath = pendingSessionSwitchPath || currentSessionPath;
  const renderSessionItem = (
    s: Session,
    options: { draggable?: boolean; onDragStart?: (event: React.DragEvent, session: Session) => void } = {},
  ) => (
    <SessionItem
      key={s.path}
      session={s}
      isActive={!pendingNewSession && s.path === activeSessionPath}
      isPending={!pendingNewSession && pendingSessionSwitchPath === s.path}
      isStreaming={sessionScopedListIncludes(useStore.getState(), streamingSessions, s.path)}
      isPinned={!!s.pinnedAt}
      hasUnreadOutput={sessionScopedListIncludes(useStore.getState(), unreadOutputSessionPaths, s.path)}
      agents={agents}
      browserState={browserSessions[s.path] || null}
      rowMode={sessionListRowMode}
      onCloseBrowser={handleCloseBrowserSession}
      draggable={options.draggable === true && s.agentDeleted !== true}
      onDragStart={options.onDragStart || handleSessionDragStart}
      onDragEnd={clearDragState}
    />
  );

  // 置顶行：可拖拽重排，行内上/下半区决定插入位。整区任一行缺 sessionId 就整体禁用，
  // 因为提交的是完整有序 sessionId 列表，缺一个就无法表达完整顺序。
  const renderPinnedSessionItem = (s: Session, pinnedItems: Session[]) => {
    const reorderable = pinnedItems.length > 1 && pinnedItems.every(item => !!item.sessionId);
    const indicator = pinnedDropTarget?.sessionPath === s.path
      ? (pinnedDropTarget.edge === 'before'
        ? styles.pinnedDropIndicatorBefore
        : styles.pinnedDropIndicatorAfter)
      : '';
    return (
      <div
        key={s.path}
        className={`${styles.pinnedRow}${indicator ? ` ${indicator}` : ''}`}
        data-pinned-session-path={s.path}
        onDragOver={reorderable ? (event) => handlePinnedDragOver(event, s) : undefined}
        onDragLeave={reorderable ? handlePinnedDragLeave : undefined}
        onDrop={reorderable ? (event) => handlePinnedDrop(event, s, pinnedItems) : undefined}
      >
        {renderSessionItem(s, { draggable: reorderable, onDragStart: handlePinnedDragStart })}
      </div>
    );
  };

  const sections = buildSessionSections(sessions, { mode: 'time' });
  const projectView = buildSessionProjectView(sessions, projectCatalog, { catalogLoaded: projectCatalogLoaded });
  const titleResultPaths = new Set(titleResults.map(result => result.path));
  const visibleContentResults = contentResults.filter(result => !titleResultPaths.has(result.path));
  const hasSearchResults = titleResults.length > 0 || visibleContentResults.length > 0;
  const isSearching = !!searchQueryTrimmed;
  const showEmptyState = sessions.length === 0 && !isSearching;
  const renderSortMenuButton = () => (
    <button
      type="button"
      className={styles.sectionIconButton}
      aria-label={t('sidebar.view.sort')}
      title={t('sidebar.view.sort')}
      onClick={(event) => setProjectMenuPosition({ x: event.clientX, y: event.clientY })}
    >
      <ListFilterIcon />
    </button>
  );
  const handleToggleProjectCollapsed = useCallback((projectId: string) => {
    const next = new Set(collapsedProjectIds);
    if (next.has(projectId)) next.delete(projectId);
    else next.add(projectId);
    setSidebarProjectViewPrefs({ collapsedProjectIds: [...next] });
  }, [collapsedProjectIds, setSidebarProjectViewPrefs]);
  const handleToggleFolderCollapsed = useCallback((folderId: string) => {
    const next = new Set(collapsedFolderIds);
    if (next.has(folderId)) next.delete(folderId);
    else next.add(folderId);
    setSidebarProjectViewPrefs({ collapsedFolderIds: [...next] });
  }, [collapsedFolderIds, setSidebarProjectViewPrefs]);
  const handleShowAllProject = useCallback((projectId: string) => {
    const next = new Set(showAllProjectIds);
    next.add(projectId);
    setSidebarProjectViewPrefs({ showAllProjectIds: [...next] });
  }, [setSidebarProjectViewPrefs, showAllProjectIds]);
  const handleProjectNameChange = useCallback((value: string) => {
    setProjectNameDialog(dialog => dialog ? { ...dialog, value } : dialog);
  }, []);
  const hasTodaySection = sections.some(section => section.kind === 'date' && section.group === 'today');
  const timeContent = sections.map(section => {
    const items = section.kind === 'pinned'
      ? section.items.map(s => renderPinnedSessionItem(s, section.items))
      : section.items.map(s => renderSessionItem(s));

    if (section.kind === 'pinned') {
      return (
        <section key={section.id} className={styles.pinnedSection}>
          <SectionTitle className={styles.pinnedSectionTitle}>
            <span>{t(section.titleKey)}</span>
            <PinIcon />
          </SectionTitle>
          {items}
        </section>
      );
    }

    return (
      <Fragment key={section.id}>
        <SectionTitle
          actions={section.group === 'today' ? renderSortMenuButton() : null}
        >
          <span>{t(section.titleKey)}</span>
        </SectionTitle>
        {items}
      </Fragment>
    );
  });
  if (!hasTodaySection && !showEmptyState) {
    const pinnedIndex = sections.findIndex(section => section.kind === 'pinned');
    timeContent.splice(Math.max(0, pinnedIndex + 1), 0, (
      <SectionTitle key="date:today-empty" actions={renderSortMenuButton()}>
        <span>{t('time.today')}</span>
      </SectionTitle>
    ));
  }
  const content = showEmptyState ? (
    <div className={styles.sessionEmpty}>
      {metaRecovery?.degraded ? t('sidebar.metaRecoveryEmpty') : t('sidebar.empty')}
    </div>
  ) : isSearching ? (
    <SessionSearchResults
      titleResults={titleResults}
      contentResults={visibleContentResults}
      status={searchStatus}
      hasResults={hasSearchResults}
      agents={agents}
      activeSessionPath={activeSessionPath}
      pendingNewSession={pendingNewSession}
      query={searchQueryTrimmed}
    />
  ) : viewMode === 'project' ? (
    <ProjectSessionView
      view={projectView}
      renderSessionItem={(session) => renderSessionItem(session, { draggable: true })}
      renderPinnedSessionItem={renderPinnedSessionItem}
      collapsedProjectIds={collapsedProjectIds}
      collapsedFolderIds={collapsedFolderIds}
      showAllProjectIds={showAllProjectIds}
      dragState={dragState}
      dropTargetId={dropTargetId}
      setDropTargetId={setDropTargetId}
      onToggleProject={handleToggleProjectCollapsed}
      onToggleFolder={handleToggleFolderCollapsed}
      onShowAllProject={handleShowAllProject}
      onProjectDragStart={handleProjectDragStart}
      onFolderDragStart={handleFolderDragStart}
      onDragEnd={clearDragState}
      onDropProject={handleDropOnProject}
      onDropFolder={handleDropOnFolder}
      onDropRoot={handleDropOnProjectRoot}
      onOpenMenu={setProjectMenuPosition}
      onCreateProject={() => setProjectNameDialog({ kind: 'create-project', value: '' })}
      onCreateProjectSession={handleCreateProjectSession}
      onOpenProjectMenu={(position, project) => setProjectActionMenu({ position, project })}
      onOpenFolderMenu={(position, folder) => setFolderActionMenu({ position, folder })}
    />
  ) : timeContent;

  return (
    <>
      <SessionSearchBox
        value={searchQuery}
        onChange={setSearchQuery}
        onClear={() => setSearchQuery('')}
      />
      <div className={styles.sessionListScroller}>
        {content}
      </div>
      {projectMenuPosition && (
        <ContextMenu
          position={projectMenuPosition}
          onClose={() => setProjectMenuPosition(null)}
          items={[
            {
              label: t('sidebar.view.time'),
              checked: viewMode === 'time',
              action: () => setViewMode('time'),
            },
            {
              label: t('sidebar.view.project'),
              checked: viewMode === 'project',
              action: () => setViewMode('project'),
            },
          ]}
        />
      )}
      {projectActionMenu && (
        <ContextMenu
          position={projectActionMenu.position}
          onClose={() => setProjectActionMenu(null)}
          items={[
            {
              label: t('sidebar.projects.renameProject'),
              action: () => setProjectNameDialog({
                kind: 'rename-project',
                projectId: projectActionMenu.project.id,
                value: projectActionMenu.project.name,
              }),
            },
            {
              label: t('sidebar.projects.deleteProject'),
              action: () => { void deleteProject(projectActionMenu.project); },
            },
          ]}
        />
      )}
      {folderActionMenu && (
        <ContextMenu
          position={folderActionMenu.position}
          onClose={() => setFolderActionMenu(null)}
          items={[
            {
              label: t('sidebar.projects.renameFolder'),
              action: () => setProjectNameDialog({
                kind: 'rename-folder',
                folderId: folderActionMenu.folder.id,
                value: folderActionMenu.folder.name,
              }),
            },
            {
              label: t('sidebar.projects.deleteFolder'),
              action: () => { void deleteFolder(folderActionMenu.folder); },
            },
          ]}
        />
      )}
      {projectNameDialog && (
        <ProjectNameDialog
          dialog={projectNameDialog}
          inputRef={projectNameInputRef}
          onChange={handleProjectNameChange}
          onSubmit={handleProjectNameDialogSubmit}
          onClose={() => setProjectNameDialog(null)}
        />
      )}
    </>
  );
}

function SectionTitle({
  children,
  actions = null,
  className = '',
}: {
  children: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`${styles.sessionSectionTitle}${className ? ` ${className}` : ''}`}>
      <div className={styles.sessionSectionTitleMain}>{children}</div>
      {actions && <div className={styles.sectionTitleActions}>{actions}</div>}
    </div>
  );
}

function ProjectNameDialog({
  dialog,
  inputRef,
  onChange,
  onSubmit,
  onClose,
}: {
  dialog: NonNullable<ProjectNameDialogState>;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const titleKey = dialog.kind === 'create-project'
    ? 'sidebar.projects.newProject'
    : dialog.kind === 'rename-folder'
      ? 'sidebar.projects.renameFolder'
      : 'sidebar.projects.renameProject';
  const placeholderKey = dialog.kind === 'rename-folder'
    ? 'sidebar.projects.newFolderPrompt'
    : 'sidebar.projects.newProjectPrompt';
  const actionKey = dialog.kind === 'rename-project'
    ? 'sidebar.projects.save'
    : dialog.kind === 'rename-folder'
      ? 'sidebar.projects.save'
    : 'sidebar.projects.createAction';

  return createPortal(
    <div
      className={styles.projectNameDialogBackdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form className={styles.projectNameDialog} onSubmit={onSubmit}>
        <div className={styles.projectNameDialogTitle}>{t(titleKey)}</div>
        <input
          ref={inputRef}
          className={styles.projectNameInput}
          value={dialog.value}
          placeholder={t(placeholderKey)}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
          }}
        />
        <div className={styles.projectNameDialogActions}>
          <button type="button" onClick={onClose}>{t('sidebar.projects.cancel')}</button>
          <button type="submit" disabled={!dialog.value.trim()}>{t(actionKey)}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function ProjectSessionView({
  view,
  renderSessionItem,
  renderPinnedSessionItem,
  collapsedProjectIds,
  collapsedFolderIds,
  showAllProjectIds,
  dragState,
  dropTargetId,
  setDropTargetId,
  onToggleProject,
  onToggleFolder,
  onShowAllProject,
  onProjectDragStart,
  onFolderDragStart,
  onDragEnd,
  onDropProject,
  onDropFolder,
  onDropRoot,
  onOpenMenu,
  onCreateProject,
  onCreateProjectSession,
  onOpenProjectMenu,
  onOpenFolderMenu,
}: {
  view: ReturnType<typeof buildSessionProjectView>;
  renderSessionItem: (session: Session) => React.ReactNode;
  renderPinnedSessionItem: (session: Session, pinnedItems: Session[]) => React.ReactNode;
  collapsedProjectIds: Set<string>;
  collapsedFolderIds: Set<string>;
  showAllProjectIds: Set<string>;
  dragState: SidebarDragState;
  dropTargetId: string | null;
  setDropTargetId: (id: string | null) => void;
  onToggleProject: (projectId: string) => void;
  onToggleFolder: (folderId: string) => void;
  onShowAllProject: (projectId: string) => void;
  onProjectDragStart: (event: React.DragEvent, projectId: string) => void;
  onFolderDragStart: (event: React.DragEvent, folderId: string) => void;
  onDragEnd: () => void;
  onDropProject: (event: React.DragEvent, project: SessionProjectGroup) => void;
  onDropFolder: (event: React.DragEvent, folder: SessionProjectFolderGroup) => void;
  onDropRoot: (event: React.DragEvent) => void;
  onOpenMenu: (position: { x: number; y: number }) => void;
  onCreateProject: () => void;
  onCreateProjectSession: (project: SessionProjectGroup) => void;
  onOpenProjectMenu: (position: { x: number; y: number }, project: SessionProjectGroup) => void;
  onOpenFolderMenu: (position: { x: number; y: number }, folder: SessionProjectFolderGroup) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <section className={styles.pinnedSection}>
        <SectionTitle className={styles.pinnedSectionTitle}>
          <span>{t('sidebar.pinned')}</span>
          <PinIcon />
        </SectionTitle>
        {view.pinned.map(session => renderPinnedSessionItem(session, view.pinned))}
      </section>
      <SectionTitle
        actions={(
          <>
            <button
              type="button"
              className={styles.sectionIconButton}
              aria-label={t('sidebar.projects.create')}
              title={t('sidebar.projects.create')}
              onClick={onCreateProject}
            >
              <ProjectPlusIcon />
            </button>
            <button
              type="button"
              className={styles.sectionIconButton}
              aria-label={t('sidebar.view.sort')}
              title={t('sidebar.view.sort')}
              onClick={(event) => onOpenMenu({ x: event.clientX, y: event.clientY })}
            >
              <ListFilterIcon />
            </button>
          </>
        )}
      >
        <span>{t('sidebar.projects.title')}</span>
      </SectionTitle>
      <div
        className={`${styles.projectRootDrop}${dropTargetId === 'root' ? ` ${styles.dropTarget}` : ''}`}
        onDragOver={(event) => {
          if (dragState?.kind !== 'project') return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropTargetId('root');
        }}
        onDragLeave={() => setDropTargetId(null)}
        onDrop={onDropRoot}
      >
        {view.rootProjects.map(project => (
          <ProjectBlock
            key={project.id}
            project={project}
            collapsed={collapsedProjectIds.has(project.id)}
            showAll={showAllProjectIds.has(project.id)}
            onToggle={() => onToggleProject(project.id)}
            onShowAll={() => onShowAllProject(project.id)}
            renderSessionItem={renderSessionItem}
            dropTargetId={dropTargetId}
            setDropTargetId={setDropTargetId}
            onProjectDragStart={onProjectDragStart}
            onDragEnd={onDragEnd}
            onDropProject={onDropProject}
            onCreateProjectSession={onCreateProjectSession}
            onOpenProjectMenu={onOpenProjectMenu}
          />
        ))}
        {view.folders.map(folder => (
          <FolderBlock
            key={folder.id}
            folder={folder}
            collapsed={collapsedFolderIds.has(folder.id)}
            collapsedProjectIds={collapsedProjectIds}
            showAllProjectIds={showAllProjectIds}
            onToggle={() => onToggleFolder(folder.id)}
            onToggleProject={onToggleProject}
            onShowAllProject={onShowAllProject}
            renderSessionItem={renderSessionItem}
            dragState={dragState}
            dropTargetId={dropTargetId}
            setDropTargetId={setDropTargetId}
            onProjectDragStart={onProjectDragStart}
            onFolderDragStart={onFolderDragStart}
            onDragEnd={onDragEnd}
            onDropProject={onDropProject}
            onDropFolder={onDropFolder}
            onCreateProjectSession={onCreateProjectSession}
            onOpenProjectMenu={onOpenProjectMenu}
            onOpenFolderMenu={onOpenFolderMenu}
          />
        ))}
      </div>
      {view.pending ? (
        <div className={styles.sessionEmpty}>{t('sidebar.projects.loading')}</div>
      ) : view.rootProjects.length === 0 && view.folders.length === 0 ? (
        <div className={styles.sessionEmpty}>{t('sidebar.projects.empty')}</div>
      ) : null}
    </>
  );
}

function ProjectBlock({
  project,
  collapsed,
  showAll,
  onToggle,
  onShowAll,
  renderSessionItem,
  dropTargetId,
  setDropTargetId,
  onProjectDragStart,
  onDragEnd,
  onDropProject,
  onCreateProjectSession,
  onOpenProjectMenu,
}: {
  project: SessionProjectGroup;
  collapsed: boolean;
  showAll: boolean;
  onToggle: () => void;
  onShowAll: () => void;
  renderSessionItem: (session: Session) => React.ReactNode;
  dropTargetId: string | null;
  setDropTargetId: (id: string | null) => void;
  onProjectDragStart: (event: React.DragEvent, projectId: string) => void;
  onDragEnd: () => void;
  onDropProject: (event: React.DragEvent, project: SessionProjectGroup) => void;
  onCreateProjectSession: (project: SessionProjectGroup) => void;
  onOpenProjectMenu: (position: { x: number; y: number }, project: SessionProjectGroup) => void;
}) {
  const lastDragEndAtRef = useRef(0);
  const { t } = useI18n();
  return (
    <div className={styles.projectBlock}>
      <div
        className={`${styles.projectRow}${dropTargetId === project.id ? ` ${styles.dropTarget}` : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        draggable
        onClick={() => {
          if (Date.now() - lastDragEndAtRef.current < 250) return;
          onToggle();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onToggle();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenProjectMenu({ x: event.clientX, y: event.clientY }, project);
        }}
        onDragStart={(event) => onProjectDragStart(event, project.id)}
        onDragEnd={() => {
          lastDragEndAtRef.current = Date.now();
          onDragEnd();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropTargetId(project.id);
        }}
        onDragLeave={() => setDropTargetId(null)}
        onDrop={(event) => onDropProject(event, project)}
      >
        <FolderIcon className={styles.projectIcon} size={16} open={!collapsed} />
        <span className={styles.projectName}>{project.name}</span>
        <button
          type="button"
          className={styles.projectNewSessionButton}
          aria-label={t('sidebar.projects.newChatInProject', { name: project.name })}
          title={t('sidebar.projects.newChatInProject', { name: project.name })}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCreateProjectSession(project);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            onCreateProjectSession(project);
          }}
        >
          <NewChatIcon />
        </button>
      </div>
      <Collapse open={!collapsed}>
        <div className={styles.projectSessionList}>
          {(showAll ? project.items : project.items.slice(0, PROJECT_SESSION_PREVIEW_LIMIT)).map(session => renderSessionItem(session))}
          {!showAll && project.items.length > PROJECT_SESSION_PREVIEW_LIMIT && (
            <button type="button" className={styles.projectShowMoreButton} onClick={onShowAll}>
              {t('sidebar.projects.showMore')}
            </button>
          )}
        </div>
      </Collapse>
    </div>
  );
}

function FolderBlock({
  folder,
  collapsed,
  collapsedProjectIds,
  showAllProjectIds,
  onToggle,
  onToggleProject,
  onShowAllProject,
  renderSessionItem,
  dragState,
  dropTargetId,
  setDropTargetId,
  onProjectDragStart,
  onFolderDragStart,
  onDragEnd,
  onDropProject,
  onDropFolder,
  onCreateProjectSession,
  onOpenProjectMenu,
  onOpenFolderMenu,
}: {
  folder: SessionProjectFolderGroup;
  collapsed: boolean;
  collapsedProjectIds: Set<string>;
  showAllProjectIds: Set<string>;
  onToggle: () => void;
  onToggleProject: (projectId: string) => void;
  onShowAllProject: (projectId: string) => void;
  renderSessionItem: (session: Session) => React.ReactNode;
  dragState: SidebarDragState;
  dropTargetId: string | null;
  setDropTargetId: (id: string | null) => void;
  onProjectDragStart: (event: React.DragEvent, projectId: string) => void;
  onFolderDragStart: (event: React.DragEvent, folderId: string) => void;
  onDragEnd: () => void;
  onDropProject: (event: React.DragEvent, project: SessionProjectGroup) => void;
  onDropFolder: (event: React.DragEvent, folder: SessionProjectFolderGroup) => void;
  onCreateProjectSession: (project: SessionProjectGroup) => void;
  onOpenProjectMenu: (position: { x: number; y: number }, project: SessionProjectGroup) => void;
  onOpenFolderMenu: (position: { x: number; y: number }, folder: SessionProjectFolderGroup) => void;
}) {
  const lastDragEndAtRef = useRef(0);
  return (
    <div className={styles.folderBlock}>
      <div
        className={`${styles.projectRow}${dropTargetId === folder.id ? ` ${styles.dropTarget}` : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        draggable
        onClick={() => {
          if (Date.now() - lastDragEndAtRef.current < 250) return;
          onToggle();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onToggle();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenFolderMenu({ x: event.clientX, y: event.clientY }, folder);
        }}
        onDragStart={(event) => onFolderDragStart(event, folder.id)}
        onDragEnd={() => {
          lastDragEndAtRef.current = Date.now();
          onDragEnd();
        }}
        onDragOver={(event) => {
          if (dragState?.kind === 'session') return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropTargetId(folder.id);
        }}
        onDragLeave={() => setDropTargetId(null)}
        onDrop={(event) => onDropFolder(event, folder)}
      >
        <FolderIcon className={styles.projectIcon} size={16} open={!collapsed} />
        <span className={styles.projectName}>{folder.name}</span>
      </div>
      <Collapse open={!collapsed}>
        <div className={styles.folderProjectList}>
          {folder.projects.map(project => (
            <ProjectBlock
              key={project.id}
              project={project}
              collapsed={collapsedProjectIds.has(project.id)}
              showAll={showAllProjectIds.has(project.id)}
              onToggle={() => onToggleProject(project.id)}
              onShowAll={() => onShowAllProject(project.id)}
              renderSessionItem={renderSessionItem}
              dropTargetId={dropTargetId}
              setDropTargetId={setDropTargetId}
              onProjectDragStart={onProjectDragStart}
              onDragEnd={onDragEnd}
              onDropProject={onDropProject}
              onCreateProjectSession={onCreateProjectSession}
              onOpenProjectMenu={onOpenProjectMenu}
            />
          ))}
        </div>
      </Collapse>
    </div>
  );
}

function ListFilterIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M7 12h10" />
      <path d="M10 17h4" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg className={styles.pinnedTitleIcon} width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path fill="currentColor" d="M15.9894 4.9502L16.52 4.42014V4.42014L15.9894 4.9502ZM19.0716 8.03562L18.541 8.56568L19.0716 8.03562ZM8.73837 19.429L8.20777 19.9591L8.73837 19.429ZM4.62169 15.3081L5.15229 14.7781L4.62169 15.3081ZM17.5669 14.9943L17.3032 14.2922L17.5669 14.9943ZM15.6498 15.7146L15.9136 16.4167H15.9136L15.6498 15.7146ZM8.3322 8.38177L7.62798 8.12375L8.3322 8.38177ZM9.02665 6.48636L9.73087 6.74438V6.74438L9.02665 6.48636ZM5.84504 10.6735L6.04438 11.3965L5.84504 10.6735ZM7.30167 10.1351L6.86346 9.52646L6.86346 9.52646L7.30167 10.1351ZM7.67582 9.79038L8.24665 10.2768H8.24665L7.67582 9.79038ZM14.251 16.3805L14.742 16.9475L14.742 16.9475L14.251 16.3805ZM13.3806 18.2012L12.6574 18.0022V18.0022L13.3806 18.2012ZM13.9169 16.7466L13.3075 16.3094L13.3075 16.3094L13.9169 16.7466ZM2.71846 12.7552L1.96848 12.76L1.96848 12.76L2.71846 12.7552ZM2.93045 11.9521L2.28053 11.5778H2.28053L2.93045 11.9521ZM11.3052 21.3431L11.3064 20.5931H11.3064L11.3052 21.3431ZM12.0933 21.1347L11.7215 20.4833L11.7215 20.4833L12.0933 21.1347ZM11.6973 2.03606L11.8588 2.76845L11.6973 2.03606ZM1.4694 21.4699C1.17666 21.763 1.1769 22.2379 1.46994 22.5306C1.76298 22.8233 2.23786 22.8231 2.5306 22.5301L1.4694 21.4699ZM7.18383 17.8721C7.47657 17.5791 7.47633 17.1042 7.18329 16.8114C6.89024 16.5187 6.41537 16.5189 6.12263 16.812L7.18383 17.8721ZM15.4588 5.48026L18.541 8.56568L19.6022 7.50556L16.52 4.42014L15.4588 5.48026ZM9.26897 18.8989L5.15229 14.7781L4.09109 15.8382L8.20777 19.9591L9.26897 18.8989ZM17.3032 14.2922L15.386 15.0125L15.9136 16.4167L17.8307 15.6964L17.3032 14.2922ZM9.03642 8.63979L9.73087 6.74438L8.32243 6.22834L7.62798 8.12375L9.03642 8.63979ZM6.04438 11.3965C6.75583 11.2003 7.29719 11.0625 7.73987 10.7438L6.86346 9.52646C6.69053 9.65097 6.46601 9.72428 5.6457 9.95044L6.04438 11.3965ZM7.62798 8.12375C7.33502 8.92332 7.24338 9.14153 7.10499 9.30391L8.24665 10.2768C8.60041 9.86175 8.7823 9.33337 9.03642 8.63979L7.62798 8.12375ZM7.73987 10.7438C7.92696 10.6091 8.09712 10.4523 8.24665 10.2768L7.10499 9.30391C7.0337 9.38757 6.9526 9.46229 6.86346 9.52646L7.73987 10.7438ZM15.386 15.0125C14.697 15.2714 14.1716 15.4571 13.76 15.8135L14.742 16.9475C14.9028 16.8082 15.1192 16.7152 15.9136 16.4167L15.386 15.0125ZM14.1037 18.4001C14.329 17.5813 14.4021 17.3569 14.5263 17.1838L13.3075 16.3094C12.9902 16.7517 12.8529 17.2919 12.6574 18.0022L14.1037 18.4001ZM13.76 15.8135C13.5903 15.9605 13.4384 16.1269 13.3075 16.3094L14.5263 17.1838C14.5887 17.0968 14.6611 17.0175 14.742 16.9475L13.76 15.8135ZM5.15229 14.7781C4.50615 14.1313 4.06799 13.691 3.78366 13.3338C3.49835 12.9753 3.46889 12.8201 3.46845 12.7505L1.96848 12.76C1.97215 13.3422 2.26127 13.8297 2.61002 14.2679C2.95976 14.7073 3.47115 15.2176 4.09109 15.8382L5.15229 14.7781ZM5.6457 9.95044C4.80048 10.1835 4.10396 10.3743 3.58296 10.5835C3.06341 10.792 2.57116 11.0732 2.28053 11.5778L3.58038 12.3264C3.615 12.2663 3.71693 12.146 4.1418 11.9755C4.56523 11.8055 5.16337 11.6394 6.04438 11.3965L5.6457 9.95044ZM3.46845 12.7505C3.46751 12.6016 3.50616 12.4553 3.58038 12.3264L2.28053 11.5778C2.07354 11.9372 1.96586 12.3452 1.96848 12.76L3.46845 12.7505ZM8.20777 19.9591C8.83164 20.5836 9.34464 21.0987 9.78647 21.4506C10.227 21.8015 10.7179 22.0922 11.3041 22.0931L11.3064 20.5931C11.2369 20.593 11.0814 20.5644 10.721 20.2773C10.3618 19.9912 9.91923 19.5499 9.26897 18.8989L8.20777 19.9591ZM12.6574 18.0022C12.4133 18.8897 12.2462 19.4924 12.0751 19.9188C11.9033 20.3467 11.7821 20.4487 11.7215 20.4833L12.465 21.7861C12.974 21.4956 13.2573 21.0004 13.4671 20.4775C13.6776 19.9532 13.8694 19.2516 14.1037 18.4001L12.6574 18.0022ZM11.3041 22.0931C11.7112 22.0937 12.1114 21.9879 12.465 21.7861L11.7215 20.4833C11.595 20.5555 11.4519 20.5933 11.3064 20.5931L11.3041 22.0931ZM18.541 8.56568C19.6045 9.63022 20.3403 10.3695 20.7917 10.9788C21.2353 11.5774 21.2863 11.8959 21.2321 12.1464L22.6982 12.4634C22.8881 11.5854 22.5382 10.8162 21.9969 10.0857C21.4635 9.36592 20.6305 8.53486 19.6022 7.50556L18.541 8.56568ZM17.8307 15.6964C19.1921 15.1849 20.294 14.773 21.0771 14.3384C21.8718 13.8973 22.5083 13.3416 22.6982 12.4634L21.2321 12.1464C21.178 12.3968 21.0001 12.6655 20.3491 13.0268C19.6865 13.3946 18.7112 13.7632 17.3032 14.2922L17.8307 15.6964ZM16.52 4.42014C15.4841 3.3832 14.6481 2.54353 13.9246 2.00638C13.1908 1.46165 12.4175 1.10912 11.5357 1.30367L11.8588 2.76845C12.1086 2.71335 12.4277 2.7633 13.0304 3.21075C13.6433 3.66579 14.3876 4.40801 15.4588 5.48026L16.52 4.42014ZM9.73087 6.74438C10.2525 5.32075 10.6161 4.33403 10.9812 3.66315C11.3402 3.00338 11.609 2.82357 11.8588 2.76845L11.5357 1.30367C10.654 1.49819 10.1005 2.14332 9.66362 2.94618C9.23278 3.73793 8.82688 4.85154 8.32243 6.22834L9.73087 6.74438ZM2.5306 22.5301L7.18383 17.8721L6.12263 16.812L1.4694 21.4699L2.5306 22.5301Z" />
    </svg>
  );
}

function BrowserStatusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M4 9h16" />
      <path d="M8 7h.01M11 7h.01" />
    </svg>
  );
}

function ProjectPlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.8" y="4.8" width="14.4" height="14.4" rx="4.2" />
      <path d="M8.8 12h6.4" />
      <path d="M12 8.8v6.4" />
    </svg>
  );
}

function NewChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function SessionSearchBox({
  value,
  onChange,
  onClear,
}: {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.sessionSearchBox}>
      <svg className={styles.sessionSearchIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        className={styles.sessionSearchInput}
        value={value}
        placeholder={t('sidebar.searchPlaceholder')}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          className={styles.sessionSearchClear}
          aria-label={t('sidebar.searchClear')}
          onClick={onClear}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

function SessionSearchResults({
  titleResults,
  contentResults,
  status,
  hasResults,
  agents,
  activeSessionPath,
  pendingNewSession,
  query,
}: {
  titleResults: SessionSearchResult[];
  contentResults: SessionSearchResult[];
  status: 'idle' | 'title' | 'content' | 'done' | 'error';
  hasResults: boolean;
  agents: Agent[];
  activeSessionPath: string | null;
  pendingNewSession: boolean;
  query: string;
}) {
  const { t } = useI18n();

  if (status === 'error') {
    return <div className={styles.sessionSearchEmpty}>{t('sidebar.searchFailed')}</div>;
  }

  return (
    <>
      {titleResults.length > 0 && (
        <SessionSearchSection
          title={t('sidebar.searchTitleMatches')}
          results={titleResults}
          agents={agents}
          activeSessionPath={activeSessionPath}
          pendingNewSession={pendingNewSession}
          query={query}
        />
      )}
      {status === 'title' && (
        <div className={styles.sessionSearchStatus}>{t('sidebar.searchingTitles')}</div>
      )}
      {(contentResults.length > 0 || status === 'content') && (
        <SessionSearchSection
          title={t('sidebar.searchContentMatches')}
          results={contentResults}
          agents={agents}
          activeSessionPath={activeSessionPath}
          pendingNewSession={pendingNewSession}
          placeholder={status === 'content' && contentResults.length === 0 ? t('sidebar.searchingContent') : null}
          query={query}
        />
      )}
      {status === 'done' && !hasResults && (
        <div className={styles.sessionSearchEmpty}>{t('sidebar.searchNoResults')}</div>
      )}
    </>
  );
}

function SessionSearchSection({
  title,
  results,
  agents,
  activeSessionPath,
  pendingNewSession,
  placeholder = null,
  query,
}: {
  title: string;
  results: SessionSearchResult[];
  agents: Agent[];
  activeSessionPath: string | null;
  pendingNewSession: boolean;
  placeholder?: string | null;
  query: string;
}) {
  return (
    <section className={styles.sessionSearchSection}>
      <div className={styles.sessionSearchSectionTitle}>{title}</div>
      {placeholder ? (
        <div className={styles.sessionSearchStatus}>{placeholder}</div>
      ) : results.map(result => (
        <SessionSearchItem
          key={`${result.matchKind}:${result.path}`}
          result={result}
          isActive={!pendingNewSession && result.path === activeSessionPath}
          agents={agents}
          query={query}
        />
      ))}
    </section>
  );
}

export const SessionSearchItem = memo(function SessionSearchItem({
  result,
  isActive,
  agents,
  query,
}: {
  result: SessionSearchResult;
  isActive: boolean;
  agents: Agent[];
  query: string;
}) {
  const { t } = useI18n();
  const parts: string[] = [];
  if (result.agentDeleted === true) parts.push(t('session.deletedAgent.meta'));
  if (result.agentName || result.agentId) parts.push(result.agentName || result.agentId!);
  if (result.cwd) {
    const dirName = result.cwd.split(/[/\\]/).filter(Boolean).pop();
    if (dirName) parts.push(dirName);
  }
  if (result.modified) parts.push(formatSessionDate(result.modified));

  const handleClick = useCallback(() => {
    if (result.matchKind === 'content' && query.trim()) {
      void locateSearchHit(result.path, query);
      return;
    }
    switchSession(result.path);
  }, [result.matchKind, result.path, query]);

  return (
    <button
      className={`${styles.sessionSearchItem}${isActive ? ` ${styles.sessionSearchItemActive}` : ''}`}
      data-session-path={result.path}
      onClick={handleClick}
    >
      <div className={styles.sessionItemHeader}>
        {result.agentId && (
          <AgentBadge agentId={result.agentId} agentName={result.agentName} agents={agents} />
        )}
        <div className={styles.sessionItemTitle}>
          {result.title || result.firstMessage || t('session.untitled')}
        </div>
      </div>
      <div className={styles.sessionItemMeta}>{parts.join(' · ')}</div>
      {result.snippet && (
        <div className={styles.sessionSearchSnippet}>{result.snippet}</div>
      )}
    </button>
  );
});

// ── Session Item ──

const SessionItem = memo(function SessionItem({ session: s, isActive, isPending, isStreaming, isPinned, hasUnreadOutput, agents, browserState, rowMode, onCloseBrowser, draggable = false, onDragStart, onDragEnd }: {
  session: Session;
  isActive: boolean;
  isPending: boolean;
  isStreaming: boolean;
  isPinned: boolean;
  hasUnreadOutput: boolean;
  agents: Agent[];
  browserState: BrowserSessionState | null;
  rowMode: SidebarSessionListRowMode;
  onCloseBrowser: (sessionPath: string) => void;
  draggable?: boolean;
  onDragStart?: (event: React.DragEvent, session: Session) => void;
  onDragEnd?: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [summaryPreviewPosition, setSummaryPreviewPosition] = useState<{ x: number; y: number } | null>(null);
  const [browserMenuPosition, setBrowserMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isDeletedAgentSession = s.agentDeleted === true;

  const handleClick = useCallback(() => {
    if (editing) return;
    switchSession(s.path);
  }, [s.path, editing]);

  const handleArchive = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    archiveSession(s.path);
  }, [s.path]);

  const handlePin = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDeletedAgentSession && !isPinned) return;
    pinSession(s.path, !isPinned);
  }, [isDeletedAgentSession, s.path, isPinned]);

  const beginRename = useCallback(() => {
    if (isDeletedAgentSession) return;
    setEditValue(s.title || s.firstMessage || '');
    setEditing(true);
  }, [isDeletedAgentSession, s.title, s.firstMessage]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    setEditing(false);
    if (trimmed && trimmed !== (s.title || s.firstMessage || '')) {
      renameSession(s.path, trimmed);
    }
  }, [editValue, s.path, s.title, s.firstMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
    }
  }, [commitRename]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSummaryPreviewPosition(null);
    setMenuPosition({ x: e.clientX, y: e.clientY });
  }, []);

  // Auto-focus input when editing starts
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Meta line
  const parts: string[] = [];
  if (isDeletedAgentSession) parts.push(t('session.deletedAgent.meta'));
  if (s.agentName || s.agentId) parts.push(s.agentName || s.agentId!);
  if (s.cwd) {
    const dirName = s.cwd.split(/[/\\]/).filter(Boolean).pop();
    if (dirName) parts.push(dirName);
  }
  if (s.modified) parts.push(formatSessionDate(s.modified));
  const rcLabel = s.rcAttachment
    ? t('session.rcTakingOver', { platform: formatRcPlatform(s.rcAttachment.platform, t) })
    : null;
  const browserUrl = browserState?.url || null;
  const hasStatusSlot = !!browserUrl;
  // 状态点只表达「这个会话自己有动静」——正在输出，或后台跑完还没看。
  // 切换加载不属于会话状态，本地切换又快，画上去只会一闪而过。
  const showStatusDot = isStreaming || hasUnreadOutput;
  const statusDotState = isStreaming ? 'running' : 'unread';
  const isSingleLine = rowMode === 'single-line';
  const displayTitle = s.title || s.firstMessage || t('session.untitled');
  const metaText = parts.join(' · ');
  const itemTitle = [displayTitle, metaText, rcLabel].filter(Boolean).join('\n');
  const browserTitle = [
    browserUrl,
    browserState?.unavailableReason,
    t('browser.open'),
  ].filter(Boolean).join('\n');

  // 徽章左键 = 打开这个 session 的浏览器（冷状态先恢复，再让 viewer 切到它）。
  // 关闭是破坏性操作，收进右键菜单，避免误点中断 agent。
  const handleBrowserOpen = useCallback(async (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await hanaFetch('/api/browser/open-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionPath: s.path }),
      });
    } catch (err) {
      console.warn('[browser] open session failed:', err);
    }
    window.platform?.openBrowserViewer?.({ sessionPath: s.path });
  }, [s.path]);

  const handleBrowserKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    void handleBrowserOpen(e);
  }, [handleBrowserOpen]);

  const handleBrowserContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setBrowserMenuPosition({ x: e.clientX, y: e.clientY });
  }, []);

  const browserMenuItems = useMemo<ContextMenuItem[]>(() => ([{
    label: t('browser.closeForSession'),
    danger: true,
    action: () => onCloseBrowser(s.path),
  }]), [t, onCloseBrowser, s.path]);

  return (
    <>
      <button
        className={`${styles.sessionItem}${isSingleLine ? ` ${styles.sessionItemSingleLine}` : ''}${isActive ? ` ${styles.sessionItemActive}` : ''}${isDeletedAgentSession ? ` ${styles.sessionItemReadOnly}` : ''}`}
        data-session-path={s.path}
        data-row-mode={rowMode}
        data-unread-output={hasUnreadOutput ? 'true' : 'false'}
        data-switch-pending={isPending ? 'true' : 'false'}
        title={itemTitle}
        draggable={draggable && !editing && !isDeletedAgentSession}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onDragStart={draggable && !isDeletedAgentSession ? (event) => onDragStart?.(event, s) : undefined}
        onDragEnd={draggable && !isDeletedAgentSession ? onDragEnd : undefined}
      >
        <div className={styles.sessionItemHeader}>
          {s.agentId && (
            <AgentBadge agentId={s.agentId} agentName={s.agentName} agents={agents} />
          )}
          {showStatusDot && (
            <span
              className={styles.sessionStreamingDot}
              data-session-status-dot=""
              data-state={statusDotState}
              aria-hidden="true"
            />
          )}
          {editing ? (
            <input
              ref={inputRef}
              className={styles.sessionRenameInput}
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={commitRename}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <div className={styles.sessionItemTitle}>
              {displayTitle}
            </div>
          )}
          {hasStatusSlot && (
            <div className={styles.sessionStatusSlot}>
              {browserUrl && (
                <span
                  className={styles.sessionBrowserBadge}
                  title={browserTitle}
                  role="button"
                  tabIndex={0}
                  aria-label={t('browser.open')}
                  data-running={browserState?.running ? 'true' : 'false'}
                  data-resumable={browserState?.resumable ? 'true' : 'false'}
                  onClick={handleBrowserOpen}
                  onKeyDown={handleBrowserKeyDown}
                  onContextMenu={handleBrowserContextMenu}
                >
                  <BrowserStatusIcon />
                </span>
              )}
            </div>
          )}
          {isSingleLine && rcLabel && (
            <div className={styles.sessionRcBadgeInline}>
              {rcLabel}
            </div>
          )}
          <div className={styles.sessionItemActions} data-session-actions="">
            {!editing && (!isDeletedAgentSession || isPinned) && (
              <div className={styles.sessionPinBtn} title={t(isPinned ? 'session.unpin' : 'session.pin')} onClick={handlePin}>
                <PinIcon />
              </div>
            )}
            <div className={styles.sessionArchiveBtn} title={t('session.archive')} onClick={handleArchive}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="21 8 21 21 3 21 3 8" />
                <rect x="1" y="3" width="22" height="5" />
                <line x1="10" y1="12" x2="14" y2="12" />
              </svg>
            </div>
          </div>
        </div>

        {!isSingleLine && (
          <div className={styles.sessionItemMeta}>
            {metaText}
          </div>
        )}

        {!isSingleLine && rcLabel && (
          <div className={styles.sessionRcBadge}>
            {rcLabel}
          </div>
        )}

      </button>
      {menuPosition && (
        <SessionContextMenu
          session={s}
          isPinned={isPinned}
          position={menuPosition}
          onClose={() => setMenuPosition(null)}
          onRename={beginRename}
          onShowSummary={(position) => setSummaryPreviewPosition(position)}
        />
      )}
      {summaryPreviewPosition && (
        <SessionSummaryPreviewCard
          session={s}
          position={summaryPreviewPosition}
          onClose={() => setSummaryPreviewPosition(null)}
        />
      )}
      {browserMenuPosition && (
        <ContextMenu
          items={browserMenuItems}
          position={browserMenuPosition}
          onClose={() => setBrowserMenuPosition(null)}
        />
      )}
    </>
  );
});

interface SessionSummaryResponse {
  hasSummary?: boolean;
  summary?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

type SummaryState =
  | { status: 'loading'; text: null }
  | { status: 'ready'; text: string }
  | { status: 'empty'; text: null }
  | { status: 'error'; text: null };

const SessionContextMenu = memo(function SessionContextMenu({
  session,
  isPinned,
  position,
  onClose,
  onRename,
  onShowSummary,
}: {
  session: Session;
  isPinned: boolean;
  position: { x: number; y: number };
  onClose: () => void;
  onRename: () => void;
  onShowSummary: (position: { x: number; y: number }) => void;
}) {
  const { t } = useI18n();
  const items = useMemo<ContextMenuItem[]>(() => {
    const menuItems: ContextMenuItem[] = [{
      label: t('session.summary.open'),
      disabled: session.hasSummary !== true,
      action: () => onShowSummary(position),
    }, {
      label: t('session.copyId'),
      disabled: typeof session.sessionId !== 'string' || !session.sessionId.trim(),
      action: () => {
        const sessionId = session.sessionId?.trim();
        if (!sessionId) {
          useStore.getState().addToast(t('session.copyIdUnavailable'), 'error', 5000);
          return;
        }
        void copyTextToClipboard(sessionId)
          .then(() => useStore.getState().addToast(t('session.copyIdDone'), 'info', 2500))
          .catch(() => useStore.getState().addToast(t('session.copyIdFailed'), 'error', 5000));
      },
    }];
    if (session.agentDeleted === true) {
      if (isPinned) {
        menuItems.push({
          label: t('session.unpin'),
          action: () => pinSession(session.path, false),
        });
      }
      menuItems.push({
        label: t('session.archive'),
        danger: true,
        action: () => archiveSession(session.path),
      });
      return menuItems;
    }
    menuItems.push({
      label: t(isPinned ? 'session.unpin' : 'session.pin'),
      action: () => pinSession(session.path, !isPinned),
    });
    menuItems.push({
      label: t('session.rename'),
      action: onRename,
    });
    menuItems.push({
      label: t('session.archive'),
      danger: true,
      action: () => archiveSession(session.path),
    });
    return menuItems;
  }, [isPinned, onRename, onShowSummary, position, session.agentDeleted, session.hasSummary, session.path, session.sessionId, t]);

  return (
    <ContextMenu
      items={items}
      position={position}
      onClose={onClose}
    />
  );
});

const SessionSummaryPreviewCard = memo(function SessionSummaryPreviewCard({
  session,
  position,
  onClose,
}: {
  session: Session;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const cardRef = useRef<HTMLDivElement>(null);
  const [summaryState, setSummaryState] = useState<SummaryState>(
    session.hasSummary === true
      ? { status: 'loading', text: null }
      : { status: 'empty', text: null },
  );

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    let { x, y } = position;
    if (x + rect.width > window.innerWidth) x = Math.max(4, window.innerWidth - rect.width - 4);
    if (y + rect.height > window.innerHeight) y = Math.max(4, window.innerHeight - rect.height - 4);
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  }, [position, summaryState]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (cardRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const handleContextMenu = (e: MouseEvent) => {
      if (cardRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClick, true);
      document.addEventListener('contextmenu', handleContextMenu, true);
      document.addEventListener('keydown', handleKeyDown);
    });
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('contextmenu', handleContextMenu, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (session.hasSummary !== true) {
      setSummaryState({ status: 'empty', text: null });
      return;
    }

    let cancelled = false;
    setSummaryState({ status: 'loading', text: null });
    hanaFetch(`/api/sessions/summary?path=${encodeURIComponent(session.path)}`)
      .then(res => res.json())
      .then((data: SessionSummaryResponse) => {
        if (cancelled) return;
        const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
        if (data.hasSummary && summary) {
          setSummaryState({ status: 'ready', text: summary });
        } else {
          setSummaryState({ status: 'empty', text: null });
        }
      })
      .catch(() => {
        if (!cancelled) setSummaryState({ status: 'error', text: null });
      });

    return () => {
      cancelled = true;
    };
  }, [session.path, session.hasSummary]);

  const summaryHtml = useMemo(() => (
    summaryState.status === 'ready' ? renderMarkdown(summaryState.text) : ''
  ), [summaryState]);

  return createPortal(
    <div
      ref={cardRef}
      className={styles.sessionSummaryCard}
      style={{ left: position.x, top: position.y }}
      data-testid="session-summary-card"
      data-scrollable="true"
    >
      <div className={styles.sessionSummaryTitle}>{t('session.summary.title')}</div>
      <div className={styles.sessionSummaryBody}>
        {summaryState.status === 'ready' ? (
          <div dangerouslySetInnerHTML={{ __html: summaryHtml }} />
        ) : (
          <span className={styles.sessionSummaryPlaceholder}>
            {summaryState.status === 'loading'
              ? t('session.summary.loading')
              : summaryState.status === 'error'
                ? t('session.summary.loadFailed')
                : t('session.summary.empty')}
          </span>
        )}
      </div>
    </div>,
    document.body,
  );
});

function formatRcPlatform(platform: string, t: (key: string) => string) {
  const lower = (platform || '').toLowerCase();
  if (lower === 'tg' || lower === 'telegram') return t('bridge.platform.telegram');
  if (lower === 'feishu' || lower === 'fs') return t('bridge.platform.feishu');
  if (lower === 'wechat' || lower === 'wx') return t('bridge.platform.wechat');
  if (lower === 'qq') return t('bridge.platform.qq');
  return platform || t('bridge.platform.bridge');
}

// ── Agent Avatar Badge ──

const AgentBadge = memo(function AgentBadge({ agentId, agentName, agents }: {
  agentId: string;
  agentName: string | null;
  agents: Agent[];
}) {
  const info = resolveAgentDisplayInfo({
    id: agentId,
    agents,
    fallbackAgentName: agentName || agentId,
  });

  return (
    <AgentAvatar
      info={info}
      className={styles.sessionAgentBadge}
      title={agentName || agentId}
    />
  );
});
