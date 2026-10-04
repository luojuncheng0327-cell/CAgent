import type { Store } from './store.ts';
import type { Session } from '../shared/contracts.ts';
import { resourceBytes } from './resources.ts';
import { uploadWorkspaceFile } from './file-operations.ts';
import { invariant } from './errors.ts';

export async function materializeAttachment(
  store: Store,
  session: Session,
  attachmentId: string,
  destination: string,
  signal?: AbortSignal,
) {
  const { bytes, resource } = resourceBytes(store, session.id, attachmentId);
  const result = await uploadWorkspaceFile(store, session, destination, bytes, {
    signal,
    validateSource: () =>
      invariant(
        resourceBytes(store, session.id, attachmentId).resource.sha256 === resource.sha256,
        'RESOURCE_CORRUPT',
        '附件校验失败，请重新选择文件',
        409,
      ),
  });
  return { ...result, attachmentId };
}
