import { t } from './i18n.ts';
import React, { useState } from 'react';
import { sessionDirectories } from '../shared/contracts.ts';
import type { Session, DirectoryGrant } from '../shared/contracts.ts';
import { Modal, Field } from './components.tsx';

export function DirectoryPermissions({
  session,
  close,
  save,
  report,
}: {
  session: Session;
  close: () => void;
  save: (grants: DirectoryGrant[], first?: string) => Promise<void>;
  report: (error: unknown) => void;
}) {
  const grants = sessionDirectories(session);
  const [directory, setDirectory] = useState(''),
    [access, setAccess] = useState<'read' | 'write'>('read'),
    [busy, setBusy] = useState(false);
  async function change(next: DirectoryGrant[], first?: string) {
    if (busy) return;
    setBusy(true);
    try {
      await save(next, first);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function add() {
    if (!directory.trim() || busy) return;
    setBusy(true);
    try {
      await save(
        [...grants, { path: directory.trim(), access }],
        !session.workspace ? directory.trim() : undefined,
      );
      setDirectory('');
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={t('会话目录授权')} onClose={close}>
      <div className="editor-form directory-permissions">
        <p>
          {t(
            '每个文件夹分别设置读写权限。文件工具只访问本会话授权的目录；会话的只读模式同时限制全部目录。',
          )}
        </p>
        <p className="muted">{t('本机命令仍需逐次批准，当前没有系统沙盒。')}</p>
        {grants.map((grant) => (
          <div className="directory-grant" key={grant.path}>
            <strong title={grant.path}>
              {grant.path}
              {session.workspace === grant.path && <small>{t('当前工作台')}</small>}
            </strong>
            <select
              aria-label={grant.path + t(' 的权限')}
              value={grant.access}
              disabled={busy}
              onChange={(event) =>
                void change(
                  grants.map((g) =>
                    g.path === grant.path
                      ? { ...g, access: event.target.value as 'read' | 'write' }
                      : g,
                  ),
                )
              }
            >
              <option value="read">{t('只读')}</option>
              <option value="write">{t('读写')}</option>
            </select>
            <button
              aria-label={t('撤销目录 ') + grant.path}
              disabled={busy}
              onClick={() => void change(grants.filter((g) => g.path !== grant.path))}
            >
              {t('撤销')}
            </button>
          </div>
        ))}
        {!grants.length && <p>{t('此会话尚未授权任何目录。')}</p>}
        {!!session.blockedDirectories?.length && (
          <div className="revoked-directories">
            <p>{t('以下子目录已撤销，父目录授权不会重新放行；添加该目录授权后可恢复访问。')}</p>
            {session.blockedDirectories.map((root) => (
              <p key={root}>{root}</p>
            ))}
          </div>
        )}
        <Field label={t('授权目录路径')}>
          <input
            value={directory}
            disabled={busy}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder={t('输入本机文件夹路径')}
          />
        </Field>
        <div className="form-actions">
          {window.cagent && (
            <button
              disabled={busy}
              onClick={() =>
                void window
                  .cagent!.chooseFolder()
                  .then((folder) => {
                    if (folder) setDirectory(folder);
                  })
                  .catch(report)
              }
            >
              {t('选择文件夹')}
            </button>
          )}
          <select
            aria-label={t('新目录权限')}
            value={access}
            disabled={busy}
            onChange={(event) => setAccess(event.target.value as 'read' | 'write')}
          >
            <option value="read">{t('只读')}</option>
            <option value="write">{t('读写')}</option>
          </select>
          <button
            className="primary"
            disabled={busy || !directory.trim() || grants.length >= 16}
            onClick={() => void add()}
          >
            {t('添加目录授权')}
          </button>
        </div>
        <small>
          {t(
            '最多授权 16 个目录。父子目录重叠时，使用最具体目录的权限；撤销后尚未执行的文件操作会重新检查。',
          )}
        </small>
      </div>
    </Modal>
  );
}
