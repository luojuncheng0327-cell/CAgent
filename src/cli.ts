import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Session } from './shared/contracts.ts';

const args = process.argv.slice(2),
  command = args.shift() ?? 'help';
function option(name: string) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数`);
  args.splice(i, 2);
  return value;
}
try {
  if (command === 'help')
    console.log(
      'CAgent\n\n  cagent serve             启动独立本机服务\n  cagent status            查看运行状态\n  cagent sessions          列出会话\n  cagent chat [--session ID] 交互聊天\n\n连接参数：--url URL --token TOKEN；默认读取 CAGENT_HOME/connection.json。',
    );
  else if (command === 'serve') await import('./server/main.ts');
  else {
    const home = process.env.CAGENT_HOME ?? path.join(os.homedir(), '.cagent');
    let connection: { origin: string; token: string } | null = null;
    const originArg = option('--url'),
      tokenArg = option('--token'),
      sessionArg = option('--session');
    if (!originArg || !tokenArg)
      connection = JSON.parse(fs.readFileSync(path.join(home, 'connection.json'), 'utf8'));
    const origin = originArg ?? connection!.origin,
      token = tokenArg ?? connection!.token;
    async function api(route: string, method = 'GET', body?: unknown) {
      const r = await fetch(origin + '/api/v1' + route, {
        method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await r.json()) as any;
      if (!r.ok) throw new Error(data.error.message);
      return data.data;
    }
    if (command === 'status') console.log(JSON.stringify(await api('/health'), null, 2));
    else if (command === 'sessions') {
      for (const session of await api('/sessions')) console.log(`${session.id}  ${session.title}`);
    } else if (command === 'chat') {
      const state = await api('/bootstrap');
      let sessionId = sessionArg;
      if (!sessionId) {
        const a = state.agents[0],
          m = state.models.find((m: any) => m.id === a.modelId) ?? state.models[0];
        if (!m) throw new Error('请先在桌面中配置模型');
        const s = await api('/sessions', 'POST', { agentId: a.id, modelId: m.id });
        sessionId = s.id;
      }
      const input = readline.createInterface({ input: stdin, output: stdout });
      console.log('输入 /exit 退出。会话 ' + sessionId);
      try {
        while (true) {
          const text = await input.question('你 > ');
          if (text === '/exit') break;
          if (!text.trim()) continue;
          const run = await api(`/sessions/${sessionId}/runs`, 'POST', {
            text,
            requestId: crypto.randomUUID(),
          });
          let done = false;
          while (!done) {
            await new Promise((r) => setTimeout(r, 150));
            const detail = await api('/sessions/' + sessionId);
            const current = detail.runs.find((r: any) => r.id === run.id);
            done = ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(current.status);
            if (done) {
              console.log(
                'CAgent > ' +
                  detail.messages
                    .filter((m: any) => m.runId === run.id && m.role === 'assistant')
                    .map((m: any) => m.text)
                    .join('\n'),
              );
              if (current.error) console.error(current.error.message);
            }
          }
        }
      } finally {
        input.close();
      }
    } else throw new Error('未知命令，请使用 help');
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : '操作失败');
  process.exitCode = 1;
}
