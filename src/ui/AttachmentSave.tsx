import React, { useEffect, useRef, useState } from 'react';
import type { Resource, Session } from '../shared/contracts.ts';
import { api } from './api.ts';
import { t } from './i18n.ts';
import { Field, Modal } from './components.tsx';

export function AttachmentSave({
  session,
  resource,
  onClose,
  onSaved,
}: {
  session: Session;
  resource: Resource;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [path, setPath] = useState(resource.name),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await api(`/sessions/${session.id}/materialize-attachment`, 'POST', {
        attachmentId: resource.id,
        path,
        workspace: session.workspace,
      });
      if (alive.current) onSaved();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={t('保存附件到工作区')}
      onClose={() => {
        if (!pending.current) onClose();
      }}
    >
      <form className="attachment-save-form" onSubmit={(event) => void save(event)}>
        <p className="muted">
          {resource.name} · {session.workspace}
        </p>
        <p>{t('保存原始文件，不覆盖同名目标；目标父目录须已存在。')}</p>
        <Field label={t('目标路径')}>
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            maxLength={4096}
            required
            autoFocus
            disabled={busy}
          />
        </Field>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <div className="button-row">
          <button type="button" disabled={busy} onClick={onClose}>
            {t('取消')}
          </button>
          <button className="primary" disabled={busy || !path.trim()}>
            {busy ? t('正在保存…') : t('保存原文件')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
