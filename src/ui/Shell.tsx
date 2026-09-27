import React from 'react';
import type { Bootstrap } from './api.ts';
import type { Session } from '../shared/contracts.ts';
import { Icon, Portrait } from './Marks.tsx';

export function Soon({
  label,
  icon,
  compact = false,
}: {
  label: string;
  icon?: string;
  compact?: boolean;
}) {
  return (
    <button
      disabled
      className={compact ? 'future-control compact' : 'future-control'}
      aria-label={`${label} · 即将提供`}
      title={`${label} · 即将提供`}
    >
      {icon && <Icon name={icon} size={15} />}
      {!compact && (
        <>
          <span>{label}</span>
          <small>即将提供</small>
        </>
      )}
    </button>
  );
}

export function TopStrip({
  rail,
  desk,
  toggleRail,
  toggleDesk,
  chat,
}: {
  rail: boolean;
  desk: boolean;
  toggleRail: () => void;
  toggleDesk: () => void;
  chat: () => void;
}) {
  return (
    <header className="topbar">
      <button className="icon-button" aria-label="侧边栏" aria-expanded={rail} onClick={toggleRail}>
        <Icon name="sidebar" size={17} />
      </button>
      <div className="mode-switch" aria-label="工作模式">
        <button className="current" onClick={chat}>
          聊天
        </button>
        <Soon label="频道" />
      </div>
      <div className="topbar-actions">
        <button className="icon-button" aria-label="书桌" aria-expanded={desk} onClick={toggleDesk}>
          <Icon name="panel" size={17} />
        </button>
        {window.cagent && (
          <div className="window-controls">
            <button aria-label="最小化" onClick={() => window.cagent!.minimize()}>
              <Icon name="minus" size={14} />
            </button>
            <button aria-label="最大化" onClick={() => window.cagent!.maximize()}>
              <Icon name="maximize" size={14} />
            </button>
            <button aria-label="关闭窗口" onClick={() => window.cagent!.close()}>
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

export function SessionRail({
  data,
  sessions,
  selected,
  search,
  archived,
  busy,
  onSearch,
  onArchive,
  create,
  settings,
  collapse,
  choose,
}: {
  data: Bootstrap;
  sessions: Session[];
  selected: string | null;
  search: string;
  archived: boolean;
  busy: boolean;
  onSearch: (value: string) => void;
  onArchive: () => void;
  create: () => void;
  settings: () => void;
  collapse: () => void;
  choose: (id: string) => void;
}) {
  const date = (iso: string) =>
    new Intl.DateTimeFormat('zh-CN', { timeZone: data.preferences.timezone }).format(new Date(iso));
  const today = date(new Date().toISOString());
  const groups = archived
    ? [['已归档', sessions] as const]
    : [
        ['置顶', sessions.filter((s) => s.pinned)] as const,
        ['今天', sessions.filter((s) => !s.pinned && date(s.updatedAt) === today)] as const,
        ['更早', sessions.filter((s) => !s.pinned && date(s.updatedAt) !== today)] as const,
      ];
  return (
    <aside className="sidebar" aria-label="对话列表">
      <div className="rail-heading">
        <h2>对话</h2>
        <div className="grow" />
        <button
          className="icon-button"
          aria-label="新对话"
          title="新对话 · Ctrl + N"
          disabled={busy}
          onClick={create}
        >
          <Icon name="plus" size={16} />
        </button>
        <button className="icon-button" aria-label="界面设置" title="设置" onClick={settings}>
          <Icon name="gear" size={16} />
        </button>
        <button className="icon-button" aria-label="收起侧边栏" onClick={collapse}>
          <Icon name="back" size={14} />
        </button>
      </div>
      <nav className="rail-shortcuts" aria-label="功能入口">
        <Soon label="社交平台" icon="link" />
        <Soon label="助手活动" icon="activity" />
        <Soon label="任务计划" icon="clock" />
        <Soon label="Skills" icon="tools" />
      </nav>
      <div className="rail-divider" />
      <div className="search-box">
        <Icon name="search" size={14} />
        <input
          aria-label="搜索会话"
          placeholder="搜索聊天记录"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>
      <div className="session-list">
        {groups.map(
          ([label, items]) =>
            (label !== '更早' || items.length > 0) && (
              <section key={label} className="session-group">
                <div className="list-heading">
                  <span>
                    {label}
                    {label === '置顶' && <Icon name="pin" size={11} />}
                  </span>
                  {(label === '今天' || archived) && (
                    <div className="rail-list-actions">
                      <Soon label="排序方式" icon="sort" compact />
                      <button
                        className="icon-button"
                        aria-label={archived ? '查看活动会话' : '查看归档会话'}
                        title={archived ? '查看活动会话' : '查看归档会话'}
                        onClick={onArchive}
                      >
                        <Icon name="archive" size={13} />
                      </button>
                    </div>
                  )}
                </div>
                {items.map((session) => (
                  <button
                    key={session.id}
                    aria-label={session.title}
                    className={`session-item${selected === session.id ? ' selected' : ''}`}
                    disabled={busy}
                    onClick={() => choose(session.id)}
                  >
                    <span className="session-title">
                      <Portrait
                        name={
                          data.agents.find((a) => a.id === session.agentId)?.name ??
                          session.agentName ??
                          'CAgent'
                        }
                        size={16}
                      />
                      <span>{session.title}</span>
                      {data.runs.some((r) => r.sessionId === session.id) && (
                        <i className="running-dot" />
                      )}
                    </span>
                    <small>
                      {data.agents.find((a) => a.id === session.agentId)?.name ??
                        session.agentName ??
                        '助手'}{' '}
                      · {session.workspace?.split(/[\\/]/).at(-1) ?? '未选择工作台'} ·{' '}
                      {date(session.updatedAt) === today ? '今天' : date(session.updatedAt)}
                    </small>
                  </button>
                ))}
              </section>
            ),
        )}
        {!sessions.length && (
          <p className="empty-list">{search ? '没有匹配的对话' : '还没有保存的对话'}</p>
        )}
      </div>
    </aside>
  );
}
