import type { Run, Approval } from '../shared/contracts.ts';
import { terminalStatuses } from '../shared/contracts.ts';
import type { Store } from './store.ts';
import { stamp } from './errors.ts';

export function completeToolPairs(store: Store, run: Run) {
  const messages = store.runMessages(run.sessionId, run.id);
  const completed = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.callId));
  for (const message of messages)
    for (const call of message.calls ?? []) {
      if (completed.has(call.id)) continue;
      store.addMessage({
        sessionId: run.sessionId,
        runId: run.id,
        role: 'tool',
        callId: call.id,
        text: JSON.stringify({
          error: {
            code: 'TOOL_OUTCOME_UNKNOWN',
            message: '执行中断，操作可能已生效，但未保存完整结果；请核对实际状态，不要自动重放。',
          },
        }),
      });
      completed.add(call.id);
    }
}

export function recoverInterruptedRuns(store: Store) {
  for (const run of store.list<Run>('run')) {
    if (terminalStatuses.has(run.status)) continue;
    store.transaction(() => {
      const rows = store.db
        .prepare(
          "SELECT kind,payload FROM events WHERE run_id=? AND id>coalesce((SELECT max(id) FROM events WHERE run_id=? AND kind='message'),0) ORDER BY id",
        )
        .all(run.id, run.id) as { kind: string; payload: string }[];
      const partial = { text: '', reasoning: '' };
      for (const row of rows)
        if (row.kind === 'text' || row.kind === 'reasoning')
          partial[row.kind] += JSON.parse(row.payload).text ?? '';
      const last = store.runMessages(run.sessionId, run.id).findLast((m) => m.role === 'assistant');
      completeToolPairs(store, run);
      if (
        (partial.text || partial.reasoning) &&
        !(last && last.text === partial.text && (last.reasoning ?? '') === partial.reasoning)
      ) {
        const message = store.addMessage({
          sessionId: run.sessionId,
          runId: run.id,
          role: 'assistant',
          ...partial,
        });
        store.event(run.id, run.sessionId, 'message', { message });
      }
      for (const approval of store.list<Approval>('approval'))
        if (approval.runId === run.id && approval.status === 'pending')
          store.put<Approval>('approval', approval.id, { ...approval, status: 'cancelled' });
      const error = {
        code: 'PROCESS_INTERRUPTED',
        message: '上次执行因进程退出而中断；已保留记录，请核对未完成操作后手动重试。',
      };
      store.put<Run>('run', run.id, { ...run, status: 'interrupted', endedAt: stamp(), error });
      store.event(run.id, run.sessionId, 'run.end', { status: 'interrupted', error });
    });
  }
  for (const approval of store.list<Approval>('approval'))
    if (approval.status === 'pending')
      store.put<Approval>('approval', approval.id, { ...approval, status: 'cancelled' });
}
