import { terminalStatuses } from '../shared/contracts.ts';
import type { Run, RunStatus } from '../shared/contracts.ts';

// Events and accepted snapshots are newer than the initial response that creates a run.
// Retain a bounded set so a late HTTP response cannot restore queued or completed work.
export function rememberRunStatus(states: Map<string, RunStatus>, id: string, status: RunStatus) {
  states.delete(id);
  states.set(id, status);
  if (states.size > 128) states.delete(states.keys().next().value!);
}
export function resolveRunStatus(states: Map<string, RunStatus>, run: Run): Run | null {
  const status = states.get(run.id) ?? run.status;
  return terminalStatuses.has(status) ? null : { ...run, status };
}
