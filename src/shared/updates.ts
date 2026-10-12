export type UpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';
export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  version?: string;
  percent?: number;
  error?: string;
}
