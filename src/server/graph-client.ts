import { request } from 'node:http';
import { AppError, invariant } from './errors.ts';
import type { ToolCall, ToolDefinition, Run } from '../shared/contracts.ts';
import type { Fetcher } from './models.ts';

export interface GraphClient {
  execute(
    runId: string,
    maxToolRounds: number,
    signal: AbortSignal,
    purpose?: Run['purpose'],
  ): Promise<void>;
}
export interface GraphModelStep {
  calls: ToolCall[];
  tools: ToolDefinition[];
}

const graphErrors: Record<string, string> = {
  TOOL_ROUND_LIMIT: '已达到本次工具执行轮数上限，请检查结果后继续',
  GRAPH_RUN_REUSED: '执行标识已经使用；请核对已有结果后重新发送',
  GRAPH_UNAVAILABLE: 'Agent 编排服务暂时无法连接，请稍后重试',
  GRAPH_RUN_INACTIVE: '此执行已经结束，不能继续执行步骤',
  GRAPH_STEP_ORDER: '执行步骤顺序不一致，已停止以避免重复操作',
  DUPLICATE_TOOL_CALL: '模型重复使用已执行的工具调用标识，已停止以避免重复操作',
  CONTEXT_LIMIT: '上下文接近模型上限，请先压缩或显式选择更大上下文模型',
  CANCELLED: '操作已取消',
};

const graphRequest: Fetcher = (url, init = {}) =>
  new Promise((resolve, reject) => {
    // A graph may span many model rounds. Unlike fetch's default header timeout,
    // this transport waits for completion until the Runtime's cancellation signal.
    const outgoing = request(
      url,
      {
        method: init.method,
        agent: false,
        headers: init.headers as Record<string, string>,
        signal: init.signal ?? undefined,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on('data', (data: Buffer) => {
          bytes += data.length;
          if (bytes > 16384) {
            incoming.destroy();
            reject(new AppError('GRAPH_UNAVAILABLE', graphErrors.GRAPH_UNAVAILABLE, 502));
          } else chunks.push(data);
        });
        incoming.on('end', () =>
          resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 502 })),
        );
        incoming.on('error', reject);
      },
    );
    outgoing.on('error', reject);
    if (typeof init.body === 'string') outgoing.write(init.body);
    outgoing.end();
  });

// The endpoint may become available after the independent worker has already opened its database.
export class HttpGraphClient implements GraphClient {
  private origin: string | (() => string);
  private token: string;
  private fetcher: Fetcher;
  constructor(origin: string | (() => string), token: string, fetcher: Fetcher = graphRequest) {
    this.origin = origin;
    this.token = token;
    this.fetcher = fetcher;
  }
  private endpoint(suffix: string) {
    const url = new URL(typeof this.origin === 'function' ? this.origin() : this.origin);
    invariant(
      url.protocol === 'http:' &&
        ['127.0.0.1', '[::1]'].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/',
      'GRAPH_UNAVAILABLE',
      graphErrors.GRAPH_UNAVAILABLE,
      503,
    );
    return new URL('/internal/v1/graph/runs' + suffix, url).toString();
  }
  async execute(
    runId: string,
    maxToolRounds: number,
    signal: AbortSignal,
    purpose: Run['purpose'] = 'chat',
  ) {
    signal.throwIfAborted();
    const url = this.endpoint('');
    try {
      const response = await this.fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.token },
        body: JSON.stringify({ runId, maxToolRounds, purpose }),
        signal,
        redirect: 'error',
      });
      const data = (await response.json().catch(() => null)) as {
        error?: { code?: string };
        runId?: string;
        status?: string;
      } | null;
      if (!response.ok) {
        const code = data?.error?.code;
        throw new AppError(
          code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'GRAPH_UNAVAILABLE',
          (code && graphErrors[code]) || 'Agent 编排未能完成，请查看当前执行记录',
          response.status,
        );
      }
      invariant(
        data?.runId === runId && data.status === 'succeeded',
        'GRAPH_INCOMPLETE',
        'Agent 编排未完整结束',
        502,
      );
    } catch (error) {
      if (signal.aborted) {
        // Abort disconnects the HTTP request, so explicitly stop the graph rather than leaving an approval blocked.
        await this.fetcher(this.endpoint('/' + encodeURIComponent(runId) + '/cancel'), {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + this.token },
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        }).catch(() => {});
        throw signal.reason;
      }
      if (error instanceof AppError) throw error;
      throw new AppError('GRAPH_UNAVAILABLE', graphErrors.GRAPH_UNAVAILABLE, 503);
    }
  }
}
