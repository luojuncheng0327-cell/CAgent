import { z } from 'zod';
import type { Runtime } from './runtime.ts';
import type { Agent, Preferences } from '../shared/contracts.ts';
import { invariant } from './errors.ts';
import { parseAttachment } from './attachment-parser.ts';

const cropInput = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  zoom: z.number().min(1).max(4),
});
const avatarInput = z.object({
  mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  base64: z
    .string()
    .min(4)
    .max(Math.ceil((4 * 1024 * 1024) / 3) * 4),
  crop: cropInput.default({ x: 0.5, y: 0.5, zoom: 1 }),
});
const profileInput = z
  .object({
    name: z.string().trim().max(120),
    description: z.string().trim().max(2000).default(''),
    revision: z.number().int().positive(),
    avatar: avatarInput.nullable().optional(),
  })
  .strict();

export async function saveProfile(rt: Runtime, agentId: string | null, raw: unknown) {
  const input = profileInput.parse(raw);
  const before = agentId ? rt.store.need<Agent>('agent', agentId) : rt.preferences();
  invariant(!agentId || input.name, 'PROFILE_NAME', '助手名称不能为空');
  invariant(
    before.revision === input.revision,
    'VERSION_CONFLICT',
    '内容已变化，请刷新后再保存',
    409,
  );
  let avatar: string | null | undefined;
  if (input.avatar === null) avatar = null;
  else if (input.avatar) {
    const bytes = Buffer.from(input.avatar.base64, 'base64');
    invariant(bytes.toString('base64') === input.avatar.base64, 'IMAGE_INVALID', '头像编码无效');
    invariant(bytes.length <= 4 * 1024 * 1024, 'IMAGE_LIMIT', '头像文件不能超过 4 MiB', 413);
    avatar = (await parseAttachment(input.avatar.mime, bytes, undefined, input.avatar.crop))
      .avatar!;
  }
  // Optimistic revision is checked again after decoding, including deletion during processing.
  return agentId
    ? rt.store.put<Agent>(
        'agent',
        agentId,
        {
          ...before,
          name: input.name,
          description: input.description,
          ...(avatar !== undefined ? { avatar } : {}),
        },
        input.revision,
      )
    : rt.store.put<Preferences>(
        'preferences',
        'global',
        {
          ...before,
          userName: input.name,
          userDescription: input.description,
          ...(avatar !== undefined ? { userAvatar: avatar } : {}),
        },
        input.revision,
      );
}

export function validateStoredAvatar(value: unknown) {
  if (value === undefined || value === null) return;
  invariant(
    typeof value === 'string' &&
      value.length <= 400000 &&
      value.startsWith('data:image/png;base64,') &&
      value.length > 22 &&
      Buffer.from(value.slice(22), 'base64').toString('base64') === value.slice(22),
    'AVATAR_INVALID',
    '备份头像必须是本机 PNG 图片',
  );
}

export async function restoreAvatar(value: string) {
  validateStoredAvatar(value);
  return (
    await parseAttachment('image/png', Buffer.from(value.split(',')[1], 'base64'), undefined, {
      x: 0.5,
      y: 0.5,
      zoom: 1,
    })
  ).avatar!;
}
