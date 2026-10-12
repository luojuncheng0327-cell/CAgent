import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Runtime } from './runtime.ts';
import type { Agent, Model, Provider, Session } from '../shared/contracts.ts';
import { sessionInput } from '../shared/contracts.ts';
import { invariant } from './errors.ts';
import { prepareDefaultWorkspace, sameDirectory } from './directories.ts';

export async function prepareSetupWorkspace(rt: Runtime, raw: unknown) {
  const input = z
    .object({ path: z.string().min(1).max(4096), create: z.boolean().default(false) })
    .parse(raw);
  invariant(
    sameDirectory(path.resolve(input.path), rt.suggestedWorkspace),
    'WORKSPACE_FIXED',
    '默认工作台位置固定，可在会话中另行授权其他文件夹',
  );
  return { path: await prepareDefaultWorkspace(rt.store) };
}

// Async directory checks finish before the SQLite commit. A stale final page
// cannot overwrite newer preferences or mark a broken configuration as ready.
export async function completeSetup(rt: Runtime, raw: unknown) {
  const input = z.object({ revision: z.number().int().positive() }).parse(raw);
  const before = rt.preferences();
  invariant(before.revision === input.revision, 'VERSION_CONFLICT', '配置已变化，请重新确认', 409);
  if (before.setupComplete) return { preferences: before, session: undefined };
  const agent = before.primaryAgentId
    ? rt.store.need<Agent>('agent', before.primaryAgentId)
    : rt.store.list<Agent>('agent')[0];
  invariant(agent, 'SETUP_AGENT_REQUIRED', '请先创建一个助手');
  function validateModels() {
    invariant(agent.modelId, 'SETUP_MODEL_REQUIRED', '请先选择一个对话模型');
    for (const id of [agent.modelId, before.smallToolModelId, before.largeToolModelId]) {
      if (!id) continue;
      const model = rt.store.need<Model>('model', id);
      invariant(
        rt.store.need<Provider>('provider', model.providerId).enabled,
        'PROVIDER_DISABLED',
        '所选模型的供应商已停用',
      );
    }
  }
  validateModels();
  invariant(before.defaultWorkspace, 'SETUP_WORKSPACE_REQUIRED', '请先确认工作台');
  const workspace = await prepareSetupWorkspace(rt, { path: before.defaultWorkspace });
  return rt.store.transaction(() => {
    const latest = rt.preferences();
    invariant(
      latest.revision === input.revision &&
        agent.revision === rt.store.need<Agent>('agent', agent.id).revision,
      'VERSION_CONFLICT',
      '配置已变化，请重新确认',
      409,
    );
    validateModels();
    const preferences = rt.savePreferences({
      ...latest,
      setupComplete: true,
      setupStep: 5,
      primaryAgentId: agent.id,
      defaultWorkspace: workspace.path,
    });
    const session = rt.store.put<Session>('session', randomUUID(), {
      ...sessionInput.parse({
        agentId: agent.id,
        modelId: agent.modelId,
        workspace: workspace.path,
      }),
      archived: false,
      pinned: false,
      draft: '',
      draftAttachmentIds: [],
      agentName: agent.name,
      parentId: null,
      forkMessageId: null,
    });
    return { preferences, session };
  });
}
