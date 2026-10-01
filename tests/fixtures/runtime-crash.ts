import { Runtime } from '../../src/server/runtime.ts';
import { randomUUID } from 'node:crypto';
const [home, sessionId] = process.argv.slice(2);
const rt = new Runtime(home, {
  codec: null,
  fetcher: async () =>
    new Response(
      JSON.stringify({
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'crash-write',
            name: 'write_file',
            arguments: '{"path":"once.txt","text":"只执行一次"}',
          },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    ),
});
const add = rt.store.addMessage.bind(rt.store);
rt.store.addMessage = (message, at) => {
  // Deliberately end the process after the filesystem effect and before its result is committed.
  if (message.role === 'tool') process.exit(86);
  return add(message, at);
};
const run = await rt.start(sessionId, { text: '保存一次', requestId: randomUUID() });
await rt.wait(run.id);
process.exit(85);
