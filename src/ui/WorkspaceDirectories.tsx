import React, { useEffect, useId, useState } from 'react';
import type { Session } from '../shared/contracts.ts';
import { useDirectoryPage } from './use-directory-page.ts';
import type { DirectoryNavigation } from './use-directory-page.ts';
import { t } from './i18n.ts';

export function DirectoryPager({
  navigation,
  tree = false,
}: {
  navigation: DirectoryNavigation;
  tree?: boolean;
}) {
  const { page, loading, index, next, previous } = navigation;
  if (!page.total && !index) return null;
  return (
    <div className="directory-pager">
      <span role="status">
        {t('显示 {0}–{1} 项，共 {2} 项', [
          page.offset + 1,
          page.offset + page.entries.length,
          page.total,
        ])}
      </span>
      {(page.nextCursor || index > 0) && (
        <div>
          <button
            disabled={loading || index === 0}
            aria-label={t(tree ? '上一页目录' : '上一页文件')}
            onClick={previous}
          >
            ‹
          </button>
          <button
            disabled={loading || !page.nextCursor}
            aria-label={t(tree ? '下一页目录' : '下一页文件')}
            onClick={next}
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}

export function DirectoryBreadcrumbs({
  folder,
  select,
}: {
  folder: string;
  select: (path: string) => void;
}) {
  const parts = folder === '.' ? [] : folder.split('/');
  return (
    <nav className="file-crumb" aria-label={t('目录路径')}>
      <button aria-current={!parts.length ? 'location' : undefined} onClick={() => select('.')}>
        {t('根目录')}
      </button>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          <span aria-hidden="true">/</span>
          <button
            title={parts.slice(0, i + 1).join('/')}
            aria-current={i === parts.length - 1 ? 'location' : undefined}
            onClick={() => select(parts.slice(0, i + 1).join('/'))}
          >
            {part}
          </button>
        </React.Fragment>
      ))}
      {!!parts.length && (
        <button
          aria-label={t('上一级')}
          onClick={() => select(parts.slice(0, -1).join('/') || '.')}
        >
          ↑
        </button>
      )}
    </nav>
  );
}

export function WorkspaceDirectories({
  session,
  folder,
  select,
  refresh,
}: {
  session: Session;
  folder: string;
  select: (path: string) => void;
  refresh: number;
}) {
  const [opened, setOpened] = useState(new Set<string>());
  const scope = JSON.stringify([session.directoryGrants, session.blockedDirectories]);
  useEffect(() => {
    setOpened(new Set());
  }, [scope]);
  function toggle(path: string) {
    setOpened((old) => {
      const next = new Set(old);
      if (old.has(path))
        for (const item of old) {
          if (item === path || item.startsWith(path + '/')) next.delete(item);
        }
      else if (old.size < 64) next.add(path);
      return next;
    });
  }
  return (
    <nav className="directory-tree" aria-label={t('目录树')}>
      <button
        aria-label={t('浏览目录 {0}', ['.'])}
        aria-current={folder === '.' ? 'location' : undefined}
        onClick={() => select('.')}
      >
        {t('根目录')}
      </button>
      <DirectoryBranch
        session={session}
        path="."
        level={0}
        folder={folder}
        select={select}
        opened={opened}
        toggle={toggle}
        refresh={refresh}
      />
      <p className="directory-note">{t('目录树最多展开 64 个目录、16 层；可点击名称直接浏览')}</p>
    </nav>
  );
}

function DirectoryBranch({
  session,
  path,
  level,
  folder,
  select,
  opened,
  toggle,
  refresh,
}: {
  session: Session;
  path: string;
  level: number;
  folder: string;
  select: (path: string) => void;
  opened: Set<string>;
  toggle: (path: string) => void;
  refresh: number;
}) {
  const id = useId();
  const navigation = useDirectoryPage({
    session,
    folder: path,
    kind: 'directories',
    limit: 25,
    refresh,
  });
  return (
    <div id={id}>
      {navigation.loading && !navigation.page.total && !navigation.index ? (
        <p className="directory-note">{t('正在读取…')}</p>
      ) : navigation.error ? (
        <p className="inline-error" role="alert">
          {navigation.error.message}
        </p>
      ) : (
        <>
          <ul>
            {navigation.page.entries.map((entry) => {
              const child = (path === '.' ? '' : path + '/') + entry.name;
              const expanded = opened.has(child);
              return (
                <li key={entry.name}>
                  <div className="directory-tree-row">
                    <button
                      aria-label={t(expanded ? '收起目录 {0}' : '展开目录 {0}', [child])}
                      aria-expanded={expanded}
                      disabled={level >= 15 || (!expanded && opened.size >= 64)}
                      onClick={() => toggle(child)}
                    >
                      {expanded ? '⌄' : '›'}
                    </button>
                    <button
                      title={child}
                      aria-label={t('浏览目录 {0}', [child])}
                      aria-current={folder === child ? 'location' : undefined}
                      onClick={() => select(child)}
                    >
                      {entry.name}
                    </button>
                  </div>
                  {expanded && (
                    <DirectoryBranch
                      session={session}
                      path={child}
                      level={level + 1}
                      folder={folder}
                      select={select}
                      opened={opened}
                      toggle={toggle}
                      refresh={refresh}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          {!navigation.page.total && <p className="directory-note">{t('没有子目录')}</p>}
          <DirectoryPager navigation={navigation} tree />
        </>
      )}
      {navigation.notice && (
        <p className="directory-note" role="status">
          {t(navigation.notice)}
        </p>
      )}
    </div>
  );
}
