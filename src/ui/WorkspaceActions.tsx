import React, { useEffect, useState } from 'react';
import type { Session } from '../shared/contracts.ts';
import { sessionDirectories } from '../shared/contracts.ts';
import { api, ApiError } from './api.ts';
import { Field, Modal } from './components.tsx';

export async function uploadWorkspaceFiles(
  sessionId: string,
  folder: string,
  files: File[],
  report: (value: unknown) => void,
) {
  let uploaded = 0;
  for (const file of files) {
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error('每个文件最多 16 MiB');
      const target = (folder === '.' ? '' : folder + '/') + file.name;
      const response = await fetch(
        `/api/v1/sessions/${sessionId}/file-upload?path=${encodeURIComponent(target)}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          body: file,
        },
      );
      const value = await response.json();
      if (!response.ok) throw new ApiError(value.error.code, value.error.message);
      uploaded++;
    } catch (error) {
      report(`${file.name}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return uploaded;
}

export function WorkspaceActions({
  session,
  target,
  readonly,
  dirty,
  onClose,
  onChanged,
}: {
  session: Session;
  target: string;
  readonly: boolean;
  dirty: boolean;
  onClose: () => void;
  onChanged: (operation: string, target: string) => Promise<void>;
}) {
  const [info, setInfo] = useState<{
    kind: string;
    sha256: string;
    bytes: number;
    entries: number;
  } | null>(null);
  const [destinationRoot, setDestinationRoot] = useState(session.workspace ?? '');
  const [destination, setDestination] = useState(target);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    void api<NonNullable<typeof info>>(
      `/sessions/${session.id}/file-info?path=${encodeURIComponent(target)}`,
    )
      .then((value) => {
        if (current) setInfo(value);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [session.id, target]);
  async function change(operation: 'rename' | 'copy' | 'trash') {
    if (!info || dirty || readonly || busy) return;
    if (
      operation === 'trash' &&
      !window.confirm(`将“${target}”移入系统回收站？可在系统回收站中恢复。`)
    )
      return;
    setBusy(true);
    setError('');
    try {
      await api(`/sessions/${session.id}/file-operation`, 'POST', {
        operation,
        path: target,
        expectedHash: info.sha256,
        confirmed: operation === 'trash',
        ...(operation !== 'trash' ? { destination: destinationRoot + '/' + destination } : {}),
      });
      await onChanged(operation, target);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const disabled = !info || readonly || dirty || busy;
  return (
    <Modal
      title="管理文件与目录"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="editor-form">
        <p className="managed-path">{target}</p>
        <p className="muted">
          {info
            ? `${info.kind === 'directory' ? '目录' : '文件'} · ${info.bytes.toLocaleString()} 字节 · ${info.entries} 项`
            : '正在检查内容和权限…'}
        </p>
        {dirty && (
          <p role="alert" className="inline-error">
            请先保存或关闭此项目的编辑草稿。
          </p>
        )}
        {readonly && (
          <p role="alert" className="inline-error">
            当前工作区为只读。
          </p>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <Field label="目标工作区">
          <select
            value={destinationRoot}
            onChange={(event) => setDestinationRoot(event.target.value)}
            disabled={busy}
          >
            {sessionDirectories(session).map((grant) => (
              <option key={grant.path} value={grant.path} disabled={grant.access === 'read'}>
                {grant.path}
                {grant.access === 'read' ? '（只读）' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="目标路径" hint="相对于所选工作区；同名目标不会覆盖。跨磁盘移动暂未提供。">
          <input
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            disabled={busy}
          />
        </Field>
        <div className="form-actions">
          <button onClick={() => void change('rename')} disabled={disabled || !destination.trim()}>
            确认移动
          </button>
          {info?.kind === 'file' && (
            <button onClick={() => void change('copy')} disabled={disabled || !destination.trim()}>
              确认复制
            </button>
          )}
          <button className="danger" onClick={() => void change('trash')} disabled={disabled}>
            移入系统回收站
          </button>
        </div>
      </div>
    </Modal>
  );
}
