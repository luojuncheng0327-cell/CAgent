import type { Store } from './store.ts';
import type { Session } from '../shared/contracts.ts';
import { resourceBytes } from './resources.ts';
import { uploadWorkspaceFile } from './file-operations.ts';

export async function materializeAttachment(
  store: Store,
  session: Session,
  attachmentId: string,
  destination: string,
) {
  const { bytes } = resourceBytes(store, session.id, attachmentId);
  const result = await uploadWorkspaceFile(store, session, destination, bytes);
  return { ...result, attachmentId };
}
