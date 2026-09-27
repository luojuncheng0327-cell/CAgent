import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, setup, send, temporary, removeTemporary } from './helpers.ts';
import { discoverModels } from '../src/server/discovery.ts';

test('CA-MODEL-001/005 模型发现不覆盖显式保存的地址或协议', async () => {
  const mock = await fixture((req, res) => {
    assert.equal(req.url, '/v1/selected/models');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'model-new' }, { id: 'second' }] }));
  });
  const f = await setup(mock.url);
  try {
    const p = f.rt.saveProvider({ ...f.provider, baseUrl: mock.url + '/selected' }, f.provider.id);
    const before = f.rt.store.need<any>('provider', p.id);
    const result = await discoverModels(p, f.rt.vault.get(p.id), {});
    assert.equal(result.models.length, 2);
    assert.deepEqual(f.rt.store.need<any>('provider', p.id), before);
    assert.equal(f.rt.store.list('model').length, 1);
  } finally {
    await f.cleanup();
    await mock.close();
  }
});
for (const protocol of [
  'anthropic-messages',
  'openai-completions',
  'google-generative-ai',
] as const)
  test(`CA-MODEL-002 ${protocol} 工具往返与独立参数转换`, async () => {
    let count = 0,
      secondBody: any;
    const mock = await fixture((req, res, body) => {
      count++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (count === 1) {
        if (protocol === 'anthropic-messages') {
          send(res, { type: 'message_start', message: { usage: { input_tokens: 10 } } });
          send(res, {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'read-a', name: 'read_file', input: {} },
          });
          send(res, {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"path":"text.txt"}' },
          });
          send(res, {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 5 },
          });
          send(res, { type: 'message_stop' });
        } else if (protocol === 'openai-completions') {
          send(res, {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'read-c',
                      function: { name: 'read_file', arguments: '{"path":' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          send(res, {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: '"text.txt"}' } }] },
                finish_reason: 'tool_calls',
              },
            ],
          });
          res.write('data: [DONE]\n\n');
        } else
          send(res, {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: { name: 'read_file', args: { path: 'text.txt' } },
                      thoughtSignature: 'signed-tool-state',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          });
      } else {
        secondBody = body;
        if (protocol === 'anthropic-messages') {
          send(res, {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          });
          send(res, {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: '已经读到文件' },
          });
          send(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' } });
          send(res, { type: 'message_stop' });
        } else if (protocol === 'openai-completions') {
          send(res, { choices: [{ delta: { content: '已经读到文件' }, finish_reason: 'stop' }] });
          res.write('data: [DONE]\n\n');
        } else
          send(res, {
            candidates: [{ content: { parts: [{ text: '已经读到文件' }] }, finishReason: 'STOP' }],
          });
      }
      res.end();
    });
    const f = await setup(mock.url, protocol),
      workspace = await temporary();
    try {
      await fs.writeFile(path.join(workspace, 'text.txt'), '独立工具读取夹具');
      await f.rt.updateSession(f.session.id, { workspace, revision: f.session.revision });
      const run = await f.rt.start(f.session.id, { text: '读文件', requestId: randomUUID() });
      const finished = await f.rt.wait(run.id);
      assert.equal(finished.status, 'succeeded', finished.error?.message);
      assert.equal(count, 2);
      assert.ok(JSON.stringify(secondBody).includes('独立工具读取夹具'));
      if (protocol === 'anthropic-messages')
        assert.equal(secondBody.messages.at(-1).content[0].tool_use_id, 'read-a');
      if (protocol === 'openai-completions')
        assert.equal(secondBody.messages.at(-1).tool_call_id, 'read-c');
      if (protocol === 'google-generative-ai')
        assert.ok(JSON.stringify(secondBody).includes('signed-tool-state'));
    } finally {
      await f.cleanup();
      await mock.close();
      await removeTemporary(workspace);
    }
  });
