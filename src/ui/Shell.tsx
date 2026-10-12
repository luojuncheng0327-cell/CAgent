import { t, currentLocaleTag } from './i18n.ts';
import React from 'react';
import type { Bootstrap } from './api.ts';
import type { Session, SearchHit } from '../shared/contracts.ts';
import { Icon, Portrait, portraitSource } from './Marks.tsx';
import { SearchResults } from './SearchResults.tsx';
import { ChoiceMenu } from './ChoiceMenu.tsx';

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
      aria-label={t('{0} · 即将提供', [label])}
      title={t('{0} · 即将提供', [label])}
    >
      {icon && <Icon name={icon} size={15} />}
      {!compact && (
        <>
          <span>{label}</span>
          <small>{t('即将提供')}</small>
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
      <button
        className="icon-button"
        aria-label={t('侧边栏')}
        aria-expanded={rail}
        onClick={toggleRail}
      >
        <Icon name="sidebar" size={17} />
      </button>
      <div className="mode-switch" aria-label={t('工作模式')}>
        <button className="current" onClick={chat}>
          {t('聊天')}
        </button>
        <Soon label={t('频道')} />
      </div>
      <div className="topbar-actions">
        <button
          className="icon-button"
          aria-label={t('书桌')}
          aria-expanded={desk}
          onClick={toggleDesk}
        >
          <Icon name="panel" size={17} />
        </button>
        {window.cagent && (
          <div className="window-controls">
            <button aria-label={t('最小化')} onClick={() => window.cagent!.minimize()}>
              <Icon name="minus" size={14} />
            </button>
            <button aria-label={t('最大化')} onClick={() => window.cagent!.maximize()}>
              <Icon name="maximize" size={14} />
            </button>
            <button aria-label={t('关闭窗口')} onClick={() => window.cagent!.close()}>
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
  remove,
  locate,
  sort,
  reorder,
  report,
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
  remove: (session: Session) => void;
  locate: (hit: SearchHit) => void;
  sort: (mode: 'updated' | 'manual') => void;
  reorder: (bucket: 'pinned' | 'active' | 'archived', ids: string[]) => void;
  report: (error: unknown) => void;
}) {
  const date = (iso: string) =>
    new Intl.DateTimeFormat(currentLocaleTag(), { timeZone: data.preferences.timezone }).format(
      new Date(iso),
    );
  const today = date(new Date().toISOString());
  const groups = archived
    ? [[t('已归档'), sessions] as const]
    : data.preferences.sessionSort === 'manual'
      ? [
          [t('置顶'), sessions.filter((s) => s.pinned)] as const,
          [t('对话'), sessions.filter((s) => !s.pinned)] as const,
        ]
      : [
          [t('置顶'), sessions.filter((s) => s.pinned)] as const,
          [t('今天'), sessions.filter((s) => !s.pinned && date(s.updatedAt) === today)] as const,
          [t('更早'), sessions.filter((s) => !s.pinned && date(s.updatedAt) !== today)] as const,
        ];
  return (
    <aside className="sidebar" aria-label={t('对话列表')}>
      <div className="rail-heading">
        <h2>{t('对话')}</h2>
        <div className="grow" />
        <button
          className="icon-button"
          aria-label={t('新对话')}
          title={t('新对话 · Ctrl + N')}
          disabled={busy}
          onClick={create}
        >
          <Icon name="plus" size={16} />
        </button>
        <button
          className="icon-button"
          aria-label={t('界面设置')}
          title={t('设置')}
          onClick={settings}
        >
          <Icon name="gear" size={16} />
        </button>
        <button className="icon-button" aria-label={t('收起侧边栏')} onClick={collapse}>
          <Icon name="back" size={14} />
        </button>
      </div>
      <nav className="rail-shortcuts" aria-label={t('功能入口')}>
        <Soon label={t('社交平台')} icon="link" />
        <Soon label={t('助手活动')} icon="activity" />
        <Soon label={t('任务计划')} icon="clock" />
        <Soon label="Skills" icon="tools" />
      </nav>
      <div className="rail-divider" />
      <div className="search-box">
        <Icon name="search" size={14} />
        <input
          aria-label={t('搜索会话')}
          placeholder={t('搜索聊天记录')}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>
      <div className="session-list">
        {search.trim() ? (
          <SearchResults query={search} archived={archived} choose={locate} report={report} />
        ) : (
          groups.map(
            ([label, items]) =>
              (label !== t('更早') || items.length > 0) && (
                <section key={label} className="session-group">
                  <div className="list-heading">
                    <span>
                      {label}
                      {label === t('置顶') && <Icon name="pin" size={11} />}
                    </span>
                    {(label === t('今天') || label === t('对话') || archived) && (
                      <div className="rail-list-actions">
                        <ChoiceMenu
                          label={t('排序方式')}
                          compact
                          icon="sort"
                          value={data.preferences.sessionSort}
                          disabled={busy}
                          items={[
                            { id: 'updated', label: t('最近更新') },
                            { id: 'manual', label: t('手动排序'), hint: t('拖动或 Alt + ↑ / ↓') },
                          ]}
                          onChange={(id) => sort(id as 'updated' | 'manual')}
                        />
                        <button
                          className="icon-button"
                          aria-label={archived ? t('查看活动会话') : t('查看归档会话')}
                          title={archived ? t('查看活动会话') : t('查看归档会话')}
                          onClick={onArchive}
                        >
                          <Icon name="archive" size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                  {items.map((session) => (
                    <div className="session-row" key={session.id}>
                      <button
                        aria-label={session.title}
                        className={`session-item${selected === session.id ? ' selected' : ''}`}
                        disabled={busy}
                        onClick={() => choose(session.id)}
                        draggable={
                          !busy && (session.pinned || data.preferences.sessionSort === 'manual')
                        }
                        title={
                          session.pinned || data.preferences.sessionSort === 'manual'
                            ? t('拖动排序；也可按 Alt + ↑ / ↓')
                            : session.title
                        }
                        onDragStart={(event) => {
                          event.dataTransfer.setData('application/x-cagent-session', session.id);
                          event.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragOver={(event) => {
                          if (
                            !busy &&
                            (session.pinned || data.preferences.sessionSort === 'manual')
                          )
                            event.preventDefault();
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          if (
                            busy ||
                            (!session.pinned && data.preferences.sessionSort !== 'manual')
                          )
                            return;
                          const bucket = session.archived
                            ? 'archived'
                            : session.pinned
                              ? 'pinned'
                              : 'active';
                          const ids = [...data.sessionOrder[bucket]],
                            source = event.dataTransfer.getData('application/x-cagent-session');
                          if (!ids.includes(source) || source === session.id) return;
                          const target = ids.indexOf(session.id);
                          ids.splice(ids.indexOf(source), 1);
                          ids.splice(target, 0, source);
                          reorder(bucket, ids);
                        }}
                        onKeyDown={(event) => {
                          if (
                            !event.altKey ||
                            !['ArrowUp', 'ArrowDown'].includes(event.key) ||
                            busy ||
                            (!session.pinned && data.preferences.sessionSort !== 'manual')
                          )
                            return;
                          event.preventDefault();
                          const bucket = session.archived
                            ? 'archived'
                            : session.pinned
                              ? 'pinned'
                              : 'active';
                          const ids = [...data.sessionOrder[bucket]],
                            at = ids.indexOf(session.id),
                            to = at + (event.key === 'ArrowUp' ? -1 : 1);
                          if (to < 0 || to >= ids.length) return;
                          [ids[at], ids[to]] = [ids[to], ids[at]];
                          reorder(bucket, ids);
                        }}
                      >
                        <span className="session-title">
                          <Portrait
                            src={portraitSource(
                              data.agents.find((a) => a.id === session.agentId),
                              data.preferences.primaryAgentId,
                            )}
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
                            t('助手')}{' '}
                          · {session.workspace?.split(/[\\/]/).at(-1) ?? t('未选择工作台')} ·{' '}
                          {date(session.updatedAt) === today ? t('今天') : date(session.updatedAt)}
                        </small>
                      </button>
                      <button
                        className="icon-button session-delete"
                        aria-label={t('删除会话：{0}', [session.title])}
                        title={t('删除会话')}
                        disabled={busy || data.runs.some((run) => run.sessionId === session.id)}
                        onClick={() => remove(session)}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  ))}
                </section>
              ),
          )
        )}
        {!search.trim() && !sessions.length && (
          <p className="empty-list">{search ? t('没有匹配的对话') : t('还没有保存的对话')}</p>
        )}
      </div>
    </aside>
  );
}
