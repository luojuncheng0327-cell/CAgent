import { t } from './i18n.ts';
import React, { useEffect, useRef, useState } from 'react';
import type { Bootstrap } from './api.ts';
import { api } from './api.ts';
import type { Agent } from '../shared/contracts.ts';
import { Field, Portrait } from './components.tsx';
import { portraitSource } from './Marks.tsx';

type AvatarDraft = { mime: string; base64: string; crop: { x: number; y: number; zoom: number } };

export function ProfileEditor({
  data,
  agent,
  refresh,
}: {
  data: Bootstrap;
  agent?: Agent;
  refresh: () => Promise<void>;
}) {
  const [saved, setSaved] = useState(agent ?? data.preferences);
  const [name, setName] = useState(agent?.name ?? data.preferences.userName);
  const [description, setDescription] = useState(
    agent?.description ?? data.preferences.userDescription ?? '',
  );
  const [avatar, setAvatar] = useState<AvatarDraft | null | undefined>();
  const [picture, setPicture] = useState<HTMLImageElement | null>(null);
  const [busy, setBusy] = useState(false),
    [reading, setReading] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const selection = useRef(0);
  useEffect(
    () => () => {
      selection.current++;
    },
    [],
  );
  useEffect(() => {
    if (!picture || !avatar || !canvas.current) return;
    const size = Math.max(
      1,
      Math.floor(Math.min(picture.naturalWidth, picture.naturalHeight) / avatar.crop.zoom),
    );
    canvas.current
      .getContext('2d')
      ?.drawImage(
        picture,
        Math.round((picture.naturalWidth - size) * avatar.crop.x),
        Math.round((picture.naturalHeight - size) * avatar.crop.y),
        size,
        size,
        0,
        0,
        256,
        256,
      );
  }, [picture, avatar]);
  const savedAvatar = agent
    ? (saved as Agent).avatar
    : (saved as Bootstrap['preferences']).userAvatar;
  const fallback = agent
    ? portraitSource(
        { ...agent, avatar: avatar === null ? null : savedAvatar },
        data.preferences.primaryAgentId,
      )
    : (savedAvatar ?? undefined);
  async function choose(file?: File) {
    if (!file) return;
    const turn = ++selection.current;
    setReading(true);
    setError('');
    setNotice('');
    try {
      if (
        !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) ||
        file.size > 4 * 1024 * 1024
      )
        throw new Error(t('请选择 4 MiB 以内的 PNG、JPEG、GIF 或 WebP 图片'));
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const base64 = btoa(binary);
      const img = new Image();
      img.src = `data:${file.type};base64,${base64}`;
      await img.decode().catch(() => {
        throw new Error(t('无法读取这张图片，请选择其他文件'));
      });
      if (
        img.naturalWidth > 8192 ||
        img.naturalHeight > 8192 ||
        img.naturalWidth * img.naturalHeight > 16777216
      )
        throw new Error(t('图片尺寸过大，请缩小后再上传'));
      if (turn !== selection.current) return;
      setAvatar({ mime: file.type, base64, crop: { x: 0.5, y: 0.5, zoom: 1 } });
      setPicture(img);
    } catch (e) {
      if (turn === selection.current)
        setError(e instanceof Error ? e.message : t('无法读取这张图片'));
    } finally {
      if (turn === selection.current) setReading(false);
    }
  }
  return (
    <form
      className="editor-form profile-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || reading) return;
        setBusy(true);
        setError('');
        setNotice('');
        try {
          const next = await api<Agent | Bootstrap['preferences']>(
            '/profiles/' + (agent ? 'agents/' + agent.id : 'user'),
            'PUT',
            {
              name,
              description,
              revision: saved.revision,
              ...(avatar !== undefined ? { avatar } : {}),
            },
          );
          setSaved(next);
          setAvatar(undefined);
          setPicture(null);
          await refresh();
          setNotice(t('资料已保存'));
        } catch (e) {
          setError(e instanceof Error ? e.message : t('保存失败，请重试'));
        } finally {
          setBusy(false);
        }
      }}
    >
      {!agent && <h2>{t('我的资料')}</h2>}
      <fieldset disabled={busy || reading} className="profile-fields">
        <div className="profile-avatar-row">
          {avatar && picture ? (
            <canvas ref={canvas} width={256} height={256} aria-label={t('头像裁剪预览')} />
          ) : (
            <Portrait
              name={name || t('你')}
              src={avatar === null && !agent ? undefined : fallback}
              size={88}
            />
          )}
          <div>
            <label className="button-file">
              {t('上传头像')}
              <input
                type="file"
                aria-label={t('上传头像')}
                accept="image/png,image/jpeg,image/gif,image/webp"
                onChange={(e) => {
                  void choose(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
            <button
              type="button"
              disabled={!savedAvatar && !avatar}
              onClick={() => {
                selection.current++;
                setAvatar(null);
                setPicture(null);
                setNotice('');
              }}
            >
              {t('移除头像')}
            </button>
            <small>{t('图片仅保存在本机；保存为静态头像。')}</small>
          </div>
        </div>
        {avatar && (
          <div className="avatar-crop-controls">
            {(
              [
                ['zoom', t('头像缩放'), 1, 4, 0.05],
                ['x', t('水平位置'), 0, 1, 0.01],
                ['y', t('垂直位置'), 0, 1, 0.01],
              ] as const
            ).map(([key, label, min, max, step]) => (
              <Field key={key} label={label}>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={avatar.crop[key]}
                  onChange={(e) =>
                    setAvatar({
                      ...avatar,
                      crop: { ...avatar.crop, [key]: Number(e.target.value) },
                    })
                  }
                />
              </Field>
            ))}
          </div>
        )}
        <Field label={agent ? t('名称') : t('称呼')}>
          <input
            required={!!agent}
            maxLength={120}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNotice('');
            }}
          />
        </Field>
        <Field
          label={t('简介')}
          hint={
            agent
              ? t('用于区分助手；行为规则仍在助手说明中编辑。')
              : t('会作为背景资料发送给当前对话使用的模型。')
          }
        >
          <textarea
            rows={4}
            maxLength={2000}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setNotice('');
            }}
          />
        </Field>
      </fieldset>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="form-actions">
        <button className="primary" disabled={busy || reading}>
          {busy ? t('正在保存…') : reading ? t('正在读取图片…') : t('保存资料')}
        </button>
      </div>
    </form>
  );
}
