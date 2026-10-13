import { request } from 'node:http';
import { z } from 'zod';
import { AppError, invariant } from './errors.ts';

export type KnowledgeSearch = (
  agentId: string,
  query: string,
  limit: number,
  signal: AbortSignal,
) => Promise<unknown>;

const resultSchema = z.object({
  method: z.enum(['lexical', 'vector']),
  hits: z
    .array(
      z.object({
        document_id: z.string().min(1).max(150),
        chunk_id: z.string().min(1).max(150),
        revision: z.number().int().positive(),
        text: z.string().max(50000),
        start_offset: z.number().int().nonnegative(),
        end_offset: z.number().int().nonnegative(),
        score: z.number().finite(),
        metadata: z.record(z.string(), z.unknown()),
      }),
    )
    .max(10),
  truncated: z.boolean(),
});
const unavailable = () =>
  new AppError('KNOWLEDGE_UNAVAILABLE', '知识服务暂时不可用，请稍后重试', 503);
const invalidResponse = () => new AppError('KNOWLEDGE_INVALID_RESPONSE', '知识服务响应无效', 502);

export class HttpKnowledgeClient {
  private origin: string | (() => string);
  private token: string;
  constructor(origin: string | (() => string), publicToken: string) {
    this.origin = origin;
    this.token = publicToken;
  }
  search: KnowledgeSearch = async (agentId, query, limit, signal) => {
    signal.throwIfAborted();
    invariant(/^[A-Za-z0-9_-]{1,150}$/.test(agentId), 'INVALID_INPUT', '助手编号无效');
    const args = z
      .object({ query: z.string().trim().min(1).max(4096), limit: z.number().int().min(1).max(10) })
      .parse({ query, limit });
    try {
      const origin = new URL(typeof this.origin === 'function' ? this.origin() : this.origin);
      invariant(
        origin.protocol === 'http:' &&
          ['127.0.0.1', '[::1]'].includes(origin.hostname) &&
          !origin.username &&
          !origin.password &&
          !origin.search &&
          !origin.hash &&
          origin.pathname === '/',
        'KNOWLEDGE_UNAVAILABLE',
        '知识服务暂时不可用',
        503,
      );
      const response = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const outgoing = request(
          new URL('/api/v1/knowledge/' + agentId + '/search', origin),
          {
            method: 'POST',
            agent: false,
            headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
            signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            incoming.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 1024 * 1024) {
                incoming.destroy();
                reject(invalidResponse());
              } else chunks.push(chunk);
            });
            incoming.on('end', () =>
              resolve({ status: incoming.statusCode ?? 502, body: Buffer.concat(chunks) }),
            );
            incoming.on('error', reject);
          },
        );
        outgoing.on('error', reject);
        outgoing.end(JSON.stringify({ queryText: args.query, limit: args.limit }));
      });
      if (response.status < 200 || response.status >= 300) throw unavailable();
      let json: unknown;
      try {
        json = JSON.parse(response.body.toString('utf8'));
      } catch {
        throw invalidResponse();
      }
      const parsed = z.object({ data: resultSchema }).safeParse(json);
      if (!parsed.success) throw invalidResponse();
      signal.throwIfAborted();
      return parsed.data.data;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
  };
}
