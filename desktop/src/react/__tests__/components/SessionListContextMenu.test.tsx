/**
 * @vitest-environment jsdom
 */
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const hanaFetchMock = vi.fn();
const switchSessionMock = vi.fn();
const archiveSessionMock = vi.fn();
const renameSessionMock = vi.fn();
const pinSessionMock = vi.fn();
const createNewSessionMock = vi.fn();
const reorderPinnedSessionsMock = vi.fn();
const openBrowserViewerMock = vi.fn();

const localServerConnection = {
  connectionId: 'local',
  kind: 'local' as const,
  serverId: 'local',
  studioId: 'local',
  label: 'Local Hana',
  baseUrl: 'http://127.0.0.1:3210',
  wsUrl: 'ws://127.0.0.1:3210',
  token: 'test-token',
  authState: 'paired' as const,
  trustState: 'local' as const,
  credentialKind: 'loopback_token' as const,
  capabilities: ['chat', 'resources', 'files', 'tools'],
};

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: (...args: unknown[]) => hanaFetchMock(...args),
  hanaUrl: (p: string) => p,
}));

vi.mock('../../stores/session-actions', () => ({
  switchSession: (...args: unknown[]) => switchSessionMock(...args),
  archiveSession: (...args: unknown[]) => archiveSessionMock(...args),
  renameSession: (...args: unknown[]) => renameSessionMock(...args),
  pinSession: (...args: unknown[]) => pinSessionMock(...args),
  createNewSession: (...args: unknown[]) => createNewSessionMock(...args),
  reorderPinnedSessions: (...args: unknown[]) => reorderPinnedSessionsMock(...args),
}));

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key === 'session.summary.open' ? '摘要' : key,
  }),
}));

import { SessionList } from '../../components/SessionList';
import { useStore } from '../../stores';

function jsonResponse(data: unknown) {
  return {
    json: async () => data,
  };
}

function seedSessions() {
  useStore.setState({
    sessions: [
      {
        path: '/tmp/agents/hana/sessions/with-summary.jsonl',
        sessionId: 'sess_with_summary',
        title: 'Has summary',
        firstMessage: 'hello',
        modified: '2026-04-29T08:00:00.000Z',
        messageCount: 2,
        agentId: 'hana',
        agentName: 'Hana',
        cwd: '/tmp/project',
        pinnedAt: null,
        hasSummary: true,
      },
      {
        path: '/tmp/agents/hana/sessions/no-summary.jsonl',
        title: 'No summary',
        firstMessage: 'hello',
        modified: '2026-04-29T07:00:00.000Z',
        messageCount: 1,
        agentId: 'hana',
        agentName: 'Hana',
        cwd: '/tmp/project',
        pinnedAt: null,
        hasSummary: false,
      },
    ],
    currentSessionPath: null,
    pendingSessionSwitchPath: null,
    pendingNewSession: false,
    agents: [],
    streamingSessions: [],
    unreadOutputSessionPaths: [],
    browserBySession: {},
    locale: 'zh',
    activeServerConnectionId: localServerConnection.connectionId,
    activeServerConnection: localServerConnection,
  });
}

function makeSessionsToday() {
  useStore.setState({
    sessions: useStore.getState().sessions.map((session) => ({
      ...session,
      modified: new Date().toISOString(),
    })),
  });
}

function sessionButton(title: string) {
  const button = screen.getByText(title).closest('button');
  if (!button) throw new Error(`Missing session button: ${title}`);
  return button;
}

function dragData() {
  const data = new Map<string, string>();
  return {
    dropEffect: '',
    effectAllowed: '',
    setData: vi.fn((type: string, value: string) => data.set(type, value)),
    getData: vi.fn((type: string) => data.get(type) || ''),
    clearData: vi.fn(() => data.clear()),
  };
}

async function openSortMenu() {
  fireEvent.click(await screen.findByRole('button', { name: 'sidebar.view.sort' }));
}

async function switchToProjectView() {
  await openSortMenu();
  expect(await screen.findByText('sidebar.view.time')).toBeInTheDocument();
  expect(await screen.findByText('sidebar.view.project')).toBeInTheDocument();
  fireEvent.click(screen.getByText('sidebar.view.project'));
}

describe('SessionList context menu', () => {
  beforeEach(() => {
    window.localStorage.removeItem('hana-session-sidebar-view-mode');
    window.localStorage.removeItem('hana-sidebar-ui-prefs');
    useStore.getState().applySidebarUiPrefs({});
    useStore.setState({ sidebarUiPrefsLoaded: false });
    globalThis.t = ((key: string) => {
      if (key === 'yuan.types') return {};
      return key;
    }) as typeof globalThis.t;
    hanaFetchMock.mockReset();
    hanaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/browser/session-states') return jsonResponse({});
      if (url === '/api/browser/sessions') return jsonResponse({});
      if (url.startsWith('/api/sessions/summary')) {
        return jsonResponse({
          hasSummary: true,
          summary: '### 重要事实\n- 用户在做记忆系统。\n\n### 事情经过\n- 10:00 用户讨论 session 摘要。',
          createdAt: '2026-04-29T07:00:00.000Z',
          updatedAt: '2026-04-29T08:00:00.000Z',
        });
      }
      return jsonResponse({});
    });
    switchSessionMock.mockReset();
    archiveSessionMock.mockReset();
    renameSessionMock.mockReset();
    pinSessionMock.mockReset();
    createNewSessionMock.mockReset();
    reorderPinnedSessionsMock.mockReset();
    openBrowserViewerMock.mockReset();
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: { openBrowserViewer: openBrowserViewerMock },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    seedSessions();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('keeps summaryless session rows readable and disables only the summary menu item', () => {
    render(<SessionList />);

    expect(sessionButton('No summary').className).not.toContain('sessionItemSummaryEmpty');

    fireEvent.contextMenu(sessionButton('No summary'), { clientX: 24, clientY: 32 });
    const summaryItem = screen.getByText('摘要').closest('.context-menu-item');
    expect(summaryItem).toHaveClass('disabled');

    fireEvent.click(screen.getByText('摘要'));
    expect(screen.queryByTestId('session-summary-card')).not.toBeInTheDocument();
    expect(hanaFetchMock).not.toHaveBeenCalledWith(
      '/api/sessions/summary?path=%2Ftmp%2Fagents%2Fhana%2Fsessions%2Fno-summary.jsonl',
    );
  });

  it('keeps the right-click menu as a shared narrow menu and opens summary as a click-through preview card', async () => {
    render(<SessionList />);

    fireEvent.contextMenu(sessionButton('Has summary'), { clientX: 24, clientY: 32 });

    const menu = document.querySelector('.context-menu');
    expect(menu).toBeInTheDocument();
    expect(menu).toHaveClass('context-menu');
    expect(menu?.className).toBe('context-menu');
    expect(screen.getByText('摘要')).toBeInTheDocument();
    expect(menu?.querySelector('.context-menu-divider')).toBeNull();
    expect(screen.queryByTestId('session-summary-card')).not.toBeInTheDocument();
    expect(hanaFetchMock).not.toHaveBeenCalledWith(
      '/api/sessions/summary?path=%2Ftmp%2Fagents%2Fhana%2Fsessions%2Fwith-summary.jsonl',
    );

    fireEvent.click(screen.getByText('摘要'));

    expect(await screen.findByTestId('session-summary-card')).toHaveAttribute('data-scrollable', 'true');
    expect(await screen.findByText(/用户在做记忆系统/)).toBeInTheDocument();
    expect(hanaFetchMock).toHaveBeenCalledWith(
      '/api/sessions/summary?path=%2Ftmp%2Fagents%2Fhana%2Fsessions%2Fwith-summary.jsonl',
    );
  });

  it('routes context menu actions through the existing session operations', async () => {
    render(<SessionList />);

    fireEvent.contextMenu(sessionButton('Has summary'), { clientX: 24, clientY: 32 });
    fireEvent.click(await screen.findByText('session.pin'));
    expect(pinSessionMock).toHaveBeenCalledWith('/tmp/agents/hana/sessions/with-summary.jsonl', true);

    fireEvent.contextMenu(sessionButton('No summary'), { clientX: 24, clientY: 32 });
    fireEvent.click(await screen.findByText('session.rename'));
    const input = screen.getByDisplayValue('No summary');
    fireEvent.change(input, { target: { value: 'Renamed summaryless session' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(renameSessionMock).toHaveBeenCalledWith(
      '/tmp/agents/hana/sessions/no-summary.jsonl',
      'Renamed summaryless session',
    );

    fireEvent.contextMenu(sessionButton('Has summary'), { clientX: 24, clientY: 32 });
    fireEvent.click(await screen.findByText('session.archive'));
    expect(archiveSessionMock).toHaveBeenCalledWith('/tmp/agents/hana/sessions/with-summary.jsonl');
  });

  it('copies only the stable Session ID and disables the action when it is unavailable', async () => {
    render(<SessionList />);

    fireEvent.contextMenu(sessionButton('Has summary'), { clientX: 24, clientY: 32 });
    fireEvent.click(screen.getByText('session.copyId'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('sess_with_summary');

    fireEvent.contextMenu(sessionButton('No summary'), { clientX: 24, clientY: 32 });
    expect(screen.getByText('session.copyId').closest('.context-menu-item')).toHaveClass('disabled');
  });

  it('copies a Session ID through the native bridge without requiring document focus', async () => {
    const writeClipboardText = vi.fn(async () => undefined);
    Object.defineProperty(window, 'platform', { configurable: true, value: { writeClipboardText } });
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new DOMException('Document is not focused.', 'NotAllowedError'));
    render(<SessionList />);

    fireEvent.contextMenu(sessionButton('Has summary'), { clientX: 24, clientY: 32 });
    fireEvent.click(screen.getByText('session.copyId'));

    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith('sess_with_summary'));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('allows deleted-agent sessions to unpin and archive without exposing rename or pin', async () => {
    useStore.setState({
      sessions: [{
        path: '/tmp/agents/deleted/sessions/pinned.jsonl',
        title: 'Deleted pinned',
        firstMessage: 'old',
        modified: '2026-04-29T08:00:00.000Z',
        messageCount: 2,
        agentId: 'deleted',
        agentName: 'Deleted',
        cwd: '/tmp/project',
        pinnedAt: '2026-04-29T08:10:00.000Z',
        hasSummary: false,
        agentDeleted: true,
      }],
      currentSessionPath: null,
      pendingSessionSwitchPath: null,
      pendingNewSession: false,
      agents: [],
      streamingSessions: [],
      unreadOutputSessionPaths: [],
      browserBySession: {},
      locale: 'zh',
    });

    render(<SessionList />);

    fireEvent.contextMenu(sessionButton('Deleted pinned'), { clientX: 24, clientY: 32 });
    expect(screen.queryByText('session.rename')).not.toBeInTheDocument();
    expect(screen.queryByText('session.pin')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByText('session.unpin'));
    expect(pinSessionMock).toHaveBeenCalledWith('/tmp/agents/deleted/sessions/pinned.jsonl', false);

    fireEvent.contextMenu(sessionButton('Deleted pinned'), { clientX: 24, clientY: 32 });
    fireEvent.click(await screen.findByText('session.archive'));
    expect(archiveSessionMock).toHaveBeenCalledWith('/tmp/agents/deleted/sessions/pinned.jsonl');
  });

  it('opens the session browser from a left click on the sidebar badge', async () => {
    const browserStates = {
      '/tmp/agents/hana/sessions/with-summary.jsonl': {
        url: 'https://example.com',
        running: false,
        resumable: true,
        unavailableReason: null,
      },
    };
    hanaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/browser/session-states') return jsonResponse(browserStates);
      if (url === '/api/browser/open-session') return jsonResponse({ ok: true });
      return jsonResponse({});
    });

    render(<SessionList />);

    fireEvent.click(await screen.findByRole('button', { name: 'browser.open' }));

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith('/api/browser/open-session', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sessionPath: '/tmp/agents/hana/sessions/with-summary.jsonl' }),
      }));
      expect(openBrowserViewerMock).toHaveBeenCalledWith({
        sessionPath: '/tmp/agents/hana/sessions/with-summary.jsonl',
      });
    });
    expect(hanaFetchMock).not.toHaveBeenCalledWith('/api/browser/close-session', expect.anything());
    expect(switchSessionMock).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'browser.open' })).toBeInTheDocument();
  });

  it('closes the session browser from the badge context menu', async () => {
    const browserStates = {
      '/tmp/agents/hana/sessions/with-summary.jsonl': {
        url: 'https://example.com',
        running: true,
        resumable: true,
        unavailableReason: null,
      },
    };
    let closed = false;
    hanaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/browser/session-states') return jsonResponse(closed ? {} : browserStates);
      if (url === '/api/browser/close-session') {
        closed = true;
        return jsonResponse({ ok: true, sessions: {} });
      }
      return jsonResponse({});
    });

    render(<SessionList />);

    fireEvent.contextMenu(await screen.findByRole('button', { name: 'browser.open' }), {
      clientX: 40,
      clientY: 60,
    });
    fireEvent.click(await screen.findByText('browser.closeForSession'));

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith('/api/browser/close-session', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sessionPath: '/tmp/agents/hana/sessions/with-summary.jsonl' }),
      }));
    });
    expect(switchSessionMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'browser.open' })).not.toBeInTheDocument();
    });
  });

  it('applies the persisted single-line row mode from the store to regular session rows', () => {
    act(() => {
      useStore.getState().applySidebarUiPrefs({
        sidebarUi: {
          projectView: { collapsedProjectIds: [], collapsedFolderIds: [], showAllProjectIds: [] },
          sessionList: { rowMode: 'single-line' },
        },
      });
    });

    render(<SessionList />);

    const row = sessionButton('Has summary');
    expect(row).toHaveAttribute('data-row-mode', 'single-line');
    expect(row.querySelector('[data-session-actions]')).toBeInTheDocument();
    expect(row).toHaveAttribute('title', expect.stringContaining('Hana'));
  });

  it('never fetches sidebar UI preferences itself', async () => {
    render(<SessionList />);

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith('/api/browser/session-states');
    });
    expect(hanaFetchMock).not.toHaveBeenCalledWith('/api/preferences/sidebar-ui');
  });

  it('follows the row mode when the store picks up new preferences after mount', async () => {
    render(<SessionList />);
    expect(sessionButton('Has summary')).toHaveAttribute('data-row-mode', 'two-line');

    act(() => {
      useStore.getState().applySidebarUiPrefs({
        sidebarUi: {
          projectView: { collapsedProjectIds: [], collapsedFolderIds: [], showAllProjectIds: [] },
          sessionList: { rowMode: 'single-line' },
        },
      });
    });

    await waitFor(() => {
      expect(sessionButton('Has summary')).toHaveAttribute('data-row-mode', 'single-line');
    });
  });

  it('keeps single-line rows on the very first frame after a remount, without any request', () => {
    act(() => {
      useStore.getState().applySidebarUiPrefs({
        sidebarUi: {
          projectView: { collapsedProjectIds: [], collapsedFolderIds: [], showAllProjectIds: [] },
          sessionList: { rowMode: 'single-line' },
        },
      });
    });

    const first = render(<SessionList />);
    expect(sessionButton('Has summary')).toHaveAttribute('data-row-mode', 'single-line');
    first.unmount();

    render(<SessionList />);
    expect(sessionButton('Has summary')).toHaveAttribute('data-row-mode', 'single-line');
    expect(hanaFetchMock).not.toHaveBeenCalledWith('/api/preferences/sidebar-ui');
  });

  it('shows title search results first and then content results', async () => {
    hanaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/browser/session-states') return jsonResponse({});
      if (url.includes('phase=title')) {
        return jsonResponse({
          results: [{
            path: '/tmp/agents/hana/sessions/title-search.jsonl',
            title: '聊天记录搜索',
            firstMessage: 'hello',
            modified: '2026-05-22T08:00:00.000Z',
            messageCount: 2,
            agentId: 'hana',
            agentName: 'Hana',
            cwd: '/tmp/project',
            matchKind: 'title',
            snippet: '',
          }],
        });
      }
      if (url.includes('phase=content')) {
        return jsonResponse({
          results: [{
            path: '/tmp/agents/hana/sessions/content-search.jsonl',
            title: '排查记录',
            firstMessage: 'hello',
            modified: '2026-05-22T07:00:00.000Z',
            messageCount: 4,
            agentId: 'hana',
            agentName: 'Hana',
            cwd: '/tmp/project',
            matchKind: 'content',
            snippet: '这里记录了和其他 Agent 的聊天记录排查。',
          }],
        });
      }
      return jsonResponse({});
    });

    render(<SessionList />);
    fireEvent.change(screen.getByPlaceholderText('sidebar.searchPlaceholder'), {
      target: { value: '聊天记录' },
    });

    expect(await screen.findByText('聊天记录搜索')).toBeInTheDocument();
    expect(await screen.findByText(/和其他 Agent 的聊天记录/)).toBeInTheDocument();

    const searchCalls = hanaFetchMock.mock.calls
      .map(([url]) => String(url))
      .filter(url => url.startsWith('/api/sessions/search'));
    expect(searchCalls[0]).toContain('phase=title');
    expect(searchCalls[1]).toContain('phase=content');

    const resultButton = screen.getByText('聊天记录搜索').closest('button');
    if (!resultButton) throw new Error('missing search result button');
    fireEvent.click(resultButton);
    expect(switchSessionMock).toHaveBeenCalledWith('/tmp/agents/hana/sessions/title-search.jsonl');
  });

  it('uses the session meta font size for the summary body', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '../../components/SessionList.module.css'),
      'utf-8',
    );

    expect(css).toMatch(/\.sessionSummaryBody\s*\{[\s\S]*font-size:\s*var\(--fs-hint\)/);
    expect(css).not.toMatch(/\.sessionContextMenu/);
    expect(css).not.toMatch(/sessionItemSummaryEmpty/);
  });

  it('uses one fine-hover policy for row and heading hover controls', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '../../components/SessionList.module.css'),
      'utf-8',
    );

    expect(css).not.toMatch(/@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)/);
    expect(css).toMatch(/@media\s*\(any-hover:\s*hover\)\s*and\s*\(any-pointer:\s*fine\)\s*\{[\s\S]*\.sessionItem:hover\s*\{/);
    expect(css).toMatch(/@media\s*\(any-hover:\s*hover\)\s*and\s*\(any-pointer:\s*fine\)\s*\{[\s\S]*\.sessionItem:not\(\.sessionItemSingleLine\):hover \.sessionArchiveBtn/);
    expect(css).toMatch(/@media\s*\(any-hover:\s*hover\)\s*and\s*\(any-pointer:\s*fine\)\s*\{[\s\S]*\.sessionItemSingleLine:hover \.sessionItemActions\s*\{[\s\S]*width:\s*calc\(40px \+ var\(--space-4\)\)/);
    expect(css).toMatch(/@media\s*\(any-hover:\s*hover\)\s*and\s*\(any-pointer:\s*fine\)\s*\{[\s\S]*\.sessionListScroller:hover \.sectionTitleActions/);
  });

  it('keeps the mobile session search input at 16px to avoid browser auto zoom', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '../../components/SessionList.module.css'),
      'utf-8',
    );

    expect(css).toMatch(/:global\(\.mobile-desktop-root\) \.sessionSearchInput\s*\{[\s\S]*font-size:\s*16px/);
  });

  it('keeps row action controls hover-only and leaves active rows from reserving empty action space', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '../../components/SessionList.module.css'),
      'utf-8',
    );

    expect(css).toMatch(/\.sessionItem:not\(\.sessionItemSingleLine\):hover \.sessionPinBtn/);
    expect(css).toMatch(/\.sessionItem:not\(\.sessionItemSingleLine\):hover \.sessionArchiveBtn/);
    expect(css).toMatch(/\.sessionItem:not\(\.sessionItemSingleLine\):hover \.sessionItemMeta\s*\{[\s\S]*padding-right:\s*52px/);
    expect(css).toMatch(/\.sessionItem:not\(\.sessionItemSingleLine\) \.sessionItemActions\s*\{[\s\S]*position:\s*absolute/);
    expect(css).toMatch(/\.sessionItemSingleLine \.sessionItemActions\s*\{[\s\S]*width:\s*0/);
    expect(css).not.toMatch(/\.sessionItemActive \.sessionPinBtn/);
    expect(css).not.toMatch(/\.sessionItemActive \.sessionArchiveBtn/);
    expect(css).not.toMatch(/\.sessionItemActive \.sessionItemMeta/);
    expect(css).not.toMatch(/sessionRenameBtn/);
  });

  it('keeps rename in the context menu without rendering an inline rename button', async () => {
    render(<SessionList />);

    expect(screen.queryByTitle('session.rename')).not.toBeInTheDocument();

    fireEvent.contextMenu(sessionButton('No summary'), { clientX: 24, clientY: 32 });
    fireEvent.click(await screen.findByText('session.rename'));

    expect(screen.getByDisplayValue('No summary')).toBeInTheDocument();
  });

  it('renders unread output and running status as row-level status signals', async () => {
    useStore.setState({
      currentSessionPath: '/tmp/agents/hana/sessions/no-summary.jsonl',
      streamingSessions: ['/tmp/agents/hana/sessions/with-summary.jsonl'],
      unreadOutputSessionPaths: ['/tmp/agents/hana/sessions/with-summary.jsonl'],
    } as never);

    render(<SessionList />);

    const row = sessionButton('Has summary');
    expect(row).toHaveAttribute('data-unread-output', 'true');
    const dot = row.querySelector('[data-session-status-dot]');
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveAttribute('data-state', 'running');
  });

  it('marks the pending switch row immediately without changing the committed session path', () => {
    useStore.setState({
      currentSessionPath: '/tmp/agents/hana/sessions/no-summary.jsonl',
      pendingSessionSwitchPath: '/tmp/agents/hana/sessions/with-summary.jsonl',
      streamingSessions: [],
      unreadOutputSessionPaths: [],
    } as never);

    render(<SessionList />);

    const pendingRow = sessionButton('Has summary');
    expect(pendingRow).toHaveAttribute('data-switch-pending', 'true');

    const currentRow = sessionButton('No summary');
    expect(currentRow).toHaveAttribute('data-switch-pending', 'false');
  });

  // 切换会话是本地操作，通常几十毫秒就完成。此前它会借用「正在输出」的状态点，
  // 结果每次点列表都闪一下，既是视觉噪音，也把「这个会话正在跑」的语义冲淡了。
  it('shows no status dot while a session switch is loading', () => {
    useStore.setState({
      currentSessionPath: '/tmp/agents/hana/sessions/no-summary.jsonl',
      pendingSessionSwitchPath: '/tmp/agents/hana/sessions/with-summary.jsonl',
      streamingSessions: [],
      unreadOutputSessionPaths: [],
    } as never);

    render(<SessionList />);

    const pendingRow = sessionButton('Has summary');
    expect(pendingRow.querySelector('[data-session-status-dot]')).not.toBeInTheDocument();
  });

  it('keeps the running dot on a session that is both switching and streaming', () => {
    useStore.setState({
      currentSessionPath: '/tmp/agents/hana/sessions/no-summary.jsonl',
      pendingSessionSwitchPath: '/tmp/agents/hana/sessions/with-summary.jsonl',
      streamingSessions: ['/tmp/agents/hana/sessions/with-summary.jsonl'],
      unreadOutputSessionPaths: [],
    } as never);

    render(<SessionList />);

    const dot = sessionButton('Has summary').querySelector('[data-session-status-dot]');
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveAttribute('data-state', 'running');
  });

  it('keeps the status dot after a background session finishes until the user opens it', () => {
    useStore.setState({
      currentSessionPath: '/tmp/agents/hana/sessions/no-summary.jsonl',
      streamingSessions: [],
      unreadOutputSessionPaths: ['/tmp/agents/hana/sessions/with-summary.jsonl'],
    } as never);

    render(<SessionList />);

    const row = sessionButton('Has summary');
    const dot = row.querySelector('[data-session-status-dot]');
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveAttribute('data-state', 'unread');
  });

  it('does not reference removed session row status affordances', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../components/SessionList.tsx'),
      'utf-8',
    );

    expect(source).not.toContain('sessionItemHeaderWithStatus');
    expect(source).not.toContain('sessionStreamingRing');
    const css = fs.readFileSync(
      path.join(__dirname, '../../components/SessionList.module.css'),
      'utf-8',
    );
    expect(css).not.toContain('sessionItemUnreadOutput');
    expect(css).not.toContain('sessionStreamingRing');
  });

  it('reveals section heading actions on focus without depending on hover media queries', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '../../components/SessionList.module.css'),
      'utf-8',
    );

    expect(css).toMatch(/\.sessionSectionTitle:focus-within \.sectionTitleActions\s*\{[\s\S]*opacity:\s*1/);
  });

  it('switches views through one Codex-like sort menu on the section heading', async () => {
    makeSessionsToday();
    hanaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/browser/session-states') return jsonResponse({});
      if (url === '/api/session-projects') {
        return jsonResponse({ catalog: { folders: [], projects: [] } });
      }
      return jsonResponse({});
    });

    render(<SessionList />);

    await openSortMenu();
    expect(await screen.findByText('sidebar.view.time')).toBeInTheDocument();
    expect(await screen.findByText('sidebar.view.project')).toBeInTheDocument();
    fireEvent.click(screen.getByText('sidebar.view.project'));

    expect(await screen.findByText('sidebar.projects.title')).toBeInTheDocument();
    expect(await screen.findByText('project')).toBeInTheDocument();

    await openSortMenu();
    expect(await screen.findByText('sidebar.view.time')).toBeInTheDocument();
    expect(await screen.findByText('sidebar.view.project')).toBeInTheDocument();
    fireEvent.click(screen.getByText('sidebar.view.time'));
    expect(await screen.findByText('time.today')).toBeInTheDocument();
  });

  it('keeps the sort menu on an empty today heading when today has no sessions', async () => {
    hanaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/browser/session-states') return jsonResponse({});
      if (url === '/api/session-projects') {
        return jsonResponse({ catalog: { folders: [], projects: [] } });
      }
      return jsonResponse({});
    });

    render(<SessionList />);

    expect(await screen.findByText('time.today')).toBeInTheDocument();
    await switchToProjectView();
    expect(await screen.findByText('sidebar.projects.title')).toBeInTheDocument();
  });

  it('creates a project directly through the project heading button', async () => {
    makeSessionsToday();
    hanaFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/browser/session-states') return jsonResponse({});
      if (url === '/api/session-projects') {
        return jsonResponse({ catalog: { folders: [], projects: [] } });
      }
      if (url === '/api/session-projects/projects' && init?.method === 'POST') {
        return jsonResponse({ ok: true, project: { id: 'project-created', name: 'Created Project', folderId: null, order: 0 } });
      }
      return jsonResponse({});
    });

    render(<SessionList />);
    await switchToProjectView();

    fireEvent.click(await screen.findByRole('button', { name: 'sidebar.projects.create' }));
    fireEvent.change(await screen.findByPlaceholderText('sidebar.projects.newProjectPrompt'), {
      target: { value: 'Created Project' },
    });
    fireEvent.click(screen.getByText('sidebar.projects.createAction'));

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith('/api/session-projects/projects', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Created Project', folderId: null }),
      }));
    });
    expect(await screen.findByText('Created Project')).toBeInTheDocument();
    expect(screen.queryByText('sidebar.projects.newFolder')).not.toBeInTheDocument();
  });

  it('renames a project from the project row context menu', async () => {
    makeSessionsToday();
    hanaFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/browser/session-states') return jsonResponse({});
      if (url === '/api/session-projects') {
        return jsonResponse({
          catalog: {
            folders: [],
            projects: [{ id: 'project-root', name: 'Root Project', folderId: null, order: 0 }],
          },
        });
      }
      if (url === '/api/session-projects/projects/project-root' && init?.method === 'PATCH') {
        return jsonResponse({ ok: true, project: { id: 'project-root', name: 'Renamed Project', folderId: null, order: 0 } });
      }
      return jsonResponse({});
    });

    render(<SessionList />);
    await switchToProjectView();

    fireEvent.contextMenu(await screen.findByText('Root Project'), { clientX: 20, clientY: 20 });
    fireEvent.click(await screen.findByText('sidebar.projects.renameProject'));
    fireEvent.change(await screen.findByDisplayValue('Root Project'), {
      target: { value: 'Renamed Project' },
    });
    fireEvent.click(screen.getByText('sidebar.projects.save'));

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith('/api/session-projects/projects/project-root', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: 'Renamed Project' }),
      }));
    });
    expect(await screen.findByText('Renamed Project')).toBeInTheDocument();
  });

  it('deletes a project and moves its visible sessions to uncategorized', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    useStore.setState({
      sessions: [{
        path: '/tmp/agents/hana/sessions/project-1.jsonl',
        title: 'Project item 1',
        firstMessage: 'hello',
        modified: new Date().toISOString(),
        messageCount: 1,
        agentId: 'hana',
        agentName: 'Hana',
        cwd: '/tmp/project',
        projectId: 'project-root',
        pinnedAt: null,
        hasSummary: false,
      }],
    });
    hanaFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/browser/session-states') return jsonResponse({});
      if (url === '/api/session-projects') {
        return jsonResponse({
          catalog: {
            folders: [],
            projects: [{ id: 'project-root', name: 'Root Project', folderId: null, order: 0 }],
          },
        });
      }
      if (url === '/api/session-projects/projects/project-root' && init?.method === 'DELETE') {
        return jsonResponse({
          ok: true,
          catalog: { folders: [], projects: [] },
          assignment: { projectId: 'cwd:', sessionPaths: ['/tmp/agents/hana/sessions/project-1.jsonl'] },
        });
      }
      return jsonResponse({});
    });

    render(<SessionList />);
    await switchToProjectView();

    fireEvent.contextMenu(await screen.findByText('Root Project'), { clientX: 20, clientY: 20 });
    fireEvent.click(await screen.findByText('sidebar.projects.deleteProject'));

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith('/api/session-projects/projects/project-root', expect.objectContaining({
        method: 'DELETE',
      }));
      expect(useStore.getState().sessions[0].projectId).toBe('cwd:');
    });
    expect(await screen.findByText('未归类')).toBeInTheDocument();
  });

  it('starts a new session draft inside the selected project from the hover action', async () => {
    useStore.setState({
      sessions: [{
        path: '/tmp/agents/hana/sessions/project-1.jsonl',
        title: 'Project item 1',
        firstMessage: 'hello',
        modified: new Date().toISOString(),
        messageCount: 1,
        agentId: 'hana',
        agentName: 'Hana',
        cwd: '/tmp/project',
        projectId: 'project-root',
        pinnedAt: null,
        hasSummary: false,
      }],
    });
    hanaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/browser/session-states') return jsonResponse({});
      if (url === '/api/session-projects') {
        return jsonResponse({
          catalog: {
            folders: [],
            projects: [{ id: 'project-root', name: 'Root Project', folderId: null, order: 0 }],
          },
        });
      }
      return jsonResponse({});
    });

    render(<SessionList />);
    await switchToProjectView();

    const projectRow = (await screen.findByText('Root Project')).closest('[role="button"]');
    if (!projectRow) throw new Error('missing project row');
    const newChatButton = within(projectRow as HTMLElement).getByTitle('sidebar.projects.newChatInProject');
    fireEvent.click(newChatButton);

    await waitFor(() => {
      expect(createNewSessionMock).toHaveBeenCalledWith({ projectId: 'project-root', cwd: null });
    });
  });

  it('starts a new session draft inside a cwd project by carrying only cwd', async () => {
    useStore.setState({
      sessions: [{
        path: '/tmp/agents/hana/sessions/cwd-project.jsonl',
        title: 'Cwd project item',
        firstMessage: 'hello',
        modified: new Date().toISOString(),
        messageCount: 1,
        agentId: 'hana',
        agentName: 'Hana',
        cwd: '/tmp/project',
        projectId: null,
        pinnedAt: null,
        hasSummary: false,
      }],
    });
    hanaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/browser/session-states') return jsonResponse({});
      if (url === '/api/session-projects') {
        return jsonResponse({ catalog: { folders: [], projects: [] } });
      }
      return jsonResponse({});
    });

    render(<SessionList />);
    await switchToProjectView();

    const projectRow = (await screen.findByText('project')).closest('[role="button"]');
    if (!projectRow) throw new Error('missing cwd project row');
    const newChatButton = within(projectRow as HTMLElement).getByTitle('sidebar.projects.newChatInProject');
    fireEvent.click(newChatButton);

    await waitFor(() => {
      expect(createNewSessionMock).toHaveBeenCalledWith({ cwd: '/tmp/project' });
    });
  });

  it('shows five project sessions by default and persists the show-all expansion', async () => {
    useStore.setState({
      sessions: Array.from({ length: 6 }, (_, index) => ({
        path: `/tmp/agents/hana/sessions/project-${index + 1}.jsonl`,
        title: `Project item ${index + 1}`,
        firstMessage: 'hello',
        modified: new Date(Date.now() - index * 1000).toISOString(),
        messageCount: 1,
        agentId: 'hana',
        agentName: 'Hana',
        cwd: '/tmp/project',
        projectId: 'project-root',
        pinnedAt: null,
        hasSummary: false,
      })),
    });
    hanaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/browser/session-states') return jsonResponse({});
      if (url === '/api/session-projects') {
        return jsonResponse({
          catalog: {
            folders: [],
            projects: [{ id: 'project-root', name: 'Root Project', folderId: null, order: 0 }],
          },
        });
      }
      if (url === '/api/preferences/sidebar-ui') {
        return jsonResponse({ sidebarUi: { projectView: { collapsedProjectIds: [], collapsedFolderIds: [], showAllProjectIds: [] } } });
      }
      return jsonResponse({});
    });

    render(<SessionList />);
    await switchToProjectView();

    await waitFor(() => {
      expect(screen.getByText('Project item 5')).toBeInTheDocument();
    });
    expect(screen.queryByText('Project item 6')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByText('sidebar.projects.showMore'));
    await waitFor(() => {
      expect(screen.getByText('Project item 6')).toBeInTheDocument();
      expect(hanaFetchMock).toHaveBeenCalledWith('/api/preferences/sidebar-ui', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          projectView: {
            collapsedProjectIds: [],
            collapsedFolderIds: [],
            showAllProjectIds: ['project-root'],
          },
        }),
      }));
    });
  });

  it('persists project row collapse state through sidebar UI preferences', async () => {
    useStore.setState({
      sessions: [
        {
          path: '/tmp/agents/hana/sessions/project-1.jsonl',
          title: 'Project item 1',
          firstMessage: 'hello',
          modified: new Date().toISOString(),
          messageCount: 1,
          agentId: 'hana',
          agentName: 'Hana',
          cwd: '/tmp/project',
          projectId: 'project-root',
          pinnedAt: null,
          hasSummary: false,
        },
      ],
    });
    hanaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/browser/session-states') return jsonResponse({});
      if (url === '/api/session-projects') {
        return jsonResponse({
          catalog: {
            folders: [],
            projects: [{ id: 'project-root', name: 'Root Project', folderId: null, order: 0 }],
          },
        });
      }
      return jsonResponse({});
    });
    act(() => {
      useStore.getState().applySidebarUiPrefs({
        sidebarUi: { projectView: { collapsedProjectIds: ['project-root'], collapsedFolderIds: [], showAllProjectIds: [] } },
      });
    });

    render(<SessionList />);
    await switchToProjectView();

    expect(await screen.findByText('Root Project')).toBeInTheDocument();
    // 折叠状态通过 Collapse 组件的 AnimatePresence 退场控制。
    // jsdom 下退场动画可能延迟完成，用 waitFor 等待内容消失。
    await waitFor(() => {
      expect(screen.queryByText('Project item 1')).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Root Project'));

    await waitFor(() => {
      expect(screen.getByText('Project item 1')).toBeInTheDocument();
      expect(hanaFetchMock).toHaveBeenCalledWith('/api/preferences/sidebar-ui', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          projectView: {
            collapsedProjectIds: [],
            collapsedFolderIds: [],
            showAllProjectIds: [],
          },
        }),
      }));
    });
  });

  it('renders catalog folders and persists folder row expansion state', async () => {
    useStore.setState({
      sessions: [
        {
          path: '/tmp/agents/hana/sessions/project-1.jsonl',
          title: 'Folder child session',
          firstMessage: 'hello',
          modified: new Date().toISOString(),
          messageCount: 1,
          agentId: 'hana',
          agentName: 'Hana',
          cwd: '/tmp/project',
          projectId: 'project-child',
          pinnedAt: null,
          hasSummary: false,
        },
      ],
    });
    hanaFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/browser/session-states') return jsonResponse({});
      if (url === '/api/session-projects') {
        return jsonResponse({
          catalog: {
            folders: [{ id: 'folder-work', name: 'Work Folder', order: 0 }],
            projects: [{ id: 'project-child', name: 'Child Project', folderId: 'folder-work', order: 0 }],
          },
        });
      }
      return jsonResponse({});
    });
    act(() => {
      useStore.getState().applySidebarUiPrefs({
        sidebarUi: { projectView: { collapsedProjectIds: [], collapsedFolderIds: ['folder-work'], showAllProjectIds: [] } },
      });
    });

    render(<SessionList />);
    await switchToProjectView();

    expect(await screen.findByText('Work Folder')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('Child Project')).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Work Folder'));

    await waitFor(() => {
      expect(screen.getByText('Child Project')).toBeInTheDocument();
      expect(hanaFetchMock).toHaveBeenCalledWith('/api/preferences/sidebar-ui', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          projectView: {
            collapsedProjectIds: [],
            collapsedFolderIds: [],
            showAllProjectIds: [],
          },
        }),
      }));
    });
  });

  it('assigns a session when dragged onto a project row', async () => {
    makeSessionsToday();
    hanaFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/browser/session-states') return jsonResponse({});
      if (url === '/api/session-projects') {
        return jsonResponse({
          catalog: {
            folders: [],
            projects: [{ id: 'project-custom', name: 'Custom Project', folderId: null, order: 0 }],
          },
        });
      }
      if (url === '/api/session-projects/session-assignment' && init?.method === 'POST') {
        return jsonResponse({ ok: true, assignment: JSON.parse(String(init.body)) });
      }
      return jsonResponse({});
    });

    render(<SessionList />);
    await switchToProjectView();

    const dataTransfer = dragData();
    fireEvent.dragStart(sessionButton('Has summary'), { dataTransfer });
    fireEvent.dragOver(await screen.findByText('Custom Project'), { dataTransfer });
    fireEvent.drop(await screen.findByText('Custom Project'), { dataTransfer });

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith('/api/session-projects/session-assignment', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          sessionPath: '/tmp/agents/hana/sessions/with-summary.jsonl',
          projectId: 'project-custom',
        }),
      }));
    });
  });

  it('reorders projects when a project is dragged onto another project at the same level', async () => {
    makeSessionsToday();
    hanaFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/browser/session-states') return jsonResponse({});
      if (url === '/api/session-projects') {
        return jsonResponse({
          catalog: {
            folders: [],
            projects: [
              { id: 'project-first', name: 'First Project', folderId: null, order: 0 },
              { id: 'project-second', name: 'Second Project', folderId: null, order: 1 },
            ],
          },
        });
      }
      if (url === '/api/session-projects/projects/reorder' && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          catalog: {
            folders: [],
            projects: [
              { id: 'project-second', name: 'Second Project', folderId: null, order: 0 },
              { id: 'project-first', name: 'First Project', folderId: null, order: 1 },
            ],
          },
        });
      }
      return jsonResponse({});
    });

    render(<SessionList />);
    await switchToProjectView();

    const dataTransfer = dragData();
    fireEvent.dragStart(await screen.findByText('Second Project'), { dataTransfer });
    fireEvent.dragOver(await screen.findByText('First Project'), { dataTransfer });
    fireEvent.drop(await screen.findByText('First Project'), { dataTransfer });

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith('/api/session-projects/projects/reorder', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ folderId: null, projectIds: ['project-second', 'project-first', 'cwd:%2Ftmp%2Fproject'] }),
      }));
    });
  });

  it('materializes cwd projects before reordering them by drag', async () => {
    useStore.setState({
      sessions: [
        {
          path: '/tmp/agents/hana/sessions/alpha.jsonl',
          title: 'Alpha session',
          firstMessage: 'hello',
          modified: new Date(Date.now() - 1000).toISOString(),
          messageCount: 1,
          agentId: 'hana',
          agentName: 'Hana',
          cwd: '/tmp/alpha-project',
          pinnedAt: null,
          hasSummary: false,
        },
        {
          path: '/tmp/agents/hana/sessions/beta.jsonl',
          title: 'Beta session',
          firstMessage: 'hello',
          modified: new Date().toISOString(),
          messageCount: 1,
          agentId: 'hana',
          agentName: 'Hana',
          cwd: '/tmp/beta-project',
          pinnedAt: null,
          hasSummary: false,
        },
      ],
    });
    const alphaId = 'cwd:%2Ftmp%2Falpha-project';
    const betaId = 'cwd:%2Ftmp%2Fbeta-project';
    makeSessionsToday();
    hanaFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/browser/session-states') return jsonResponse({});
      if (url === '/api/session-projects') {
        return jsonResponse({ catalog: { folders: [], projects: [] } });
      }
      if (url.startsWith('/api/session-projects/projects/cwd%3A') && init?.method === 'PATCH') {
        const id = decodeURIComponent(url.slice('/api/session-projects/projects/'.length));
        const name = JSON.parse(String(init.body)).name;
        return jsonResponse({ ok: true, project: { id, name, folderId: null, order: 0 } });
      }
      if (url === '/api/session-projects/projects/reorder' && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          catalog: {
            folders: [],
            projects: [
              { id: alphaId, name: 'alpha-project', folderId: null, order: 0 },
              { id: betaId, name: 'beta-project', folderId: null, order: 1 },
            ],
          },
        });
      }
      return jsonResponse({});
    });

    render(<SessionList />);
    await switchToProjectView();

    const dataTransfer = dragData();
    fireEvent.dragStart(await screen.findByText('alpha-project'), { dataTransfer });
    fireEvent.dragOver(await screen.findByText('beta-project'), { dataTransfer });
    fireEvent.drop(await screen.findByText('beta-project'), { dataTransfer });

    await waitFor(() => {
      expect(hanaFetchMock).toHaveBeenCalledWith(`/api/session-projects/projects/${encodeURIComponent(alphaId)}`, expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: 'alpha-project', folderId: null }),
      }));
      expect(hanaFetchMock).toHaveBeenCalledWith(`/api/session-projects/projects/${encodeURIComponent(betaId)}`, expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: 'beta-project', folderId: null }),
      }));
      expect(hanaFetchMock).toHaveBeenCalledWith('/api/session-projects/projects/reorder', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ folderId: null, projectIds: [alphaId, betaId] }),
      }));
    });
  });

  it('keeps project-view session rows unindented because their two-line shape already separates them', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '../../components/SessionList.module.css'),
      'utf-8',
    );

    expect(css).toMatch(/\.projectSessionList\s*\{[\s\S]*padding-left:\s*0/);
    expect(css).not.toMatch(/\.projectSessionList\s*\{[\s\S]*margin-left:/);
  });

  describe('pinned strip reordering', () => {
    function seedPinnedSessions(options: { withSessionIds?: boolean } = {}) {
      const withSessionIds = options.withSessionIds !== false;
      useStore.setState({
        sessions: [
          {
            path: '/tmp/agents/hana/sessions/pin-a.jsonl',
            sessionId: withSessionIds ? 'sess_pin_a' : null,
            title: 'Pin A',
            firstMessage: 'a',
            modified: '2026-04-29T08:00:00.000Z',
            messageCount: 1,
            agentId: 'hana',
            agentName: 'Hana',
            cwd: '/tmp/project',
            pinnedAt: '2026-04-28T07:00:00.000Z',
            pinOrder: 1024,
          },
          {
            path: '/tmp/agents/hana/sessions/pin-b.jsonl',
            sessionId: withSessionIds ? 'sess_pin_b' : null,
            title: 'Pin B',
            firstMessage: 'b',
            modified: '2026-04-29T07:00:00.000Z',
            messageCount: 1,
            agentId: 'hana',
            agentName: 'Hana',
            cwd: '/tmp/project',
            pinnedAt: '2026-04-28T07:00:00.000Z',
            pinOrder: 2048,
          },
          {
            path: '/tmp/agents/hana/sessions/pin-c.jsonl',
            sessionId: withSessionIds ? 'sess_pin_c' : null,
            title: 'Pin C',
            firstMessage: 'c',
            modified: '2026-04-29T06:00:00.000Z',
            messageCount: 1,
            agentId: 'hana',
            agentName: 'Hana',
            cwd: '/tmp/project',
            pinnedAt: '2026-04-28T07:00:00.000Z',
            pinOrder: 3072,
          },
        ],
      } as never);
    }

    function pinnedRow(title: string) {
      const row = sessionButton(title).closest('[data-pinned-session-path]');
      if (!row) throw new Error(`Missing pinned row: ${title}`);
      return row as HTMLElement;
    }

    function stubRowGeometry(row: HTMLElement) {
      row.getBoundingClientRect = () => ({
        top: 0, bottom: 40, left: 0, right: 100, width: 100, height: 40, x: 0, y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    }

    // jsdom has no DragEvent, so fireEvent cannot carry pointer coordinates on a
    // drag event; define them on the event object the way a browser would.
    function fireDragAt(
      type: 'dragOver' | 'drop',
      row: HTMLElement,
      dataTransfer: ReturnType<typeof dragData>,
      clientY: number,
    ) {
      const event = createEvent[type](row, { dataTransfer });
      Object.defineProperty(event, 'clientY', { value: clientY });
      fireEvent(row, event);
    }

    it('submits the full pinned order when a row is dropped above another row', async () => {
      seedPinnedSessions();
      render(<SessionList />);

      const dataTransfer = dragData();
      fireEvent.dragStart(sessionButton('Pin C'), { dataTransfer });
      const target = pinnedRow('Pin A');
      stubRowGeometry(target);
      fireDragAt('dragOver', target, dataTransfer, 5);
      fireDragAt('drop', target, dataTransfer, 5);

      await waitFor(() => {
        expect(reorderPinnedSessionsMock).toHaveBeenCalledWith([
          'sess_pin_c',
          'sess_pin_a',
          'sess_pin_b',
        ]);
      });
    });

    it('submits the order with the dragged row below the target when dropped on its lower half', async () => {
      seedPinnedSessions();
      render(<SessionList />);

      const dataTransfer = dragData();
      fireEvent.dragStart(sessionButton('Pin A'), { dataTransfer });
      const target = pinnedRow('Pin B');
      stubRowGeometry(target);
      fireDragAt('dragOver', target, dataTransfer, 35);
      fireDragAt('drop', target, dataTransfer, 35);

      await waitFor(() => {
        expect(reorderPinnedSessionsMock).toHaveBeenCalledWith([
          'sess_pin_b',
          'sess_pin_a',
          'sess_pin_c',
        ]);
      });
    });

    it('disables pinned reordering entirely when any pinned row has no session id', () => {
      seedPinnedSessions({ withSessionIds: false });
      render(<SessionList />);

      expect(sessionButton('Pin A')).not.toHaveAttribute('draggable', 'true');

      const dataTransfer = dragData();
      fireEvent.dragStart(sessionButton('Pin C'), { dataTransfer });
      fireDragAt('drop', pinnedRow('Pin A'), dataTransfer, 5);

      expect(reorderPinnedSessionsMock).not.toHaveBeenCalled();
    });

    it('does not assign a pinned row to a project when it is dragged out of the pinned strip', async () => {
      seedPinnedSessions();
      hanaFetchMock.mockImplementation(async (url: string) => {
        if (url === '/api/browser/session-states') return jsonResponse({});
        if (url === '/api/session-projects') {
          return jsonResponse({
            catalog: {
              folders: [],
              projects: [{ id: 'project-custom', name: 'Custom Project', folderId: null, order: 0 }],
            },
          });
        }
        return jsonResponse({});
      });

      render(<SessionList />);
      await switchToProjectView();

      const dataTransfer = dragData();
      fireEvent.dragStart(sessionButton('Pin A'), { dataTransfer });
      const projectRow = await screen.findByText('Custom Project');
      fireEvent.dragOver(projectRow, { dataTransfer });
      fireEvent.drop(projectRow, { dataTransfer });

      await waitFor(() => {
        expect(hanaFetchMock).not.toHaveBeenCalledWith(
          '/api/session-projects/session-assignment',
          expect.anything(),
        );
      });
      expect(reorderPinnedSessionsMock).not.toHaveBeenCalled();
    });
  });

  it('keeps the pinned heading font unified with date and project headings', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '../../components/SessionList.module.css'),
      'utf-8',
    );

    const baseTitleRule = css.match(/\.sessionSectionTitle\s*\{[^}]*\}/)?.[0] || '';
    const pinnedTitleRule = css.match(/\.pinnedSection \.sessionSectionTitle\s*\{[^}]*\}/)?.[0] || '';
    expect(baseTitleRule).toContain('font-size: var(--fs-ui)');
    expect(pinnedTitleRule).not.toContain('font-size:');
  });
});
