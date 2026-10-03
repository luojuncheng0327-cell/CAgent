import { Worker } from 'node:worker_threads';
import type { Resource } from '../shared/contracts.ts';
import { AppError, invariant } from './errors.ts';

export interface ParsedAttachment {
  image?: Resource['image'];
  extraction?: Resource['extraction'];
  text?: string;
}

let active = 0;
export async function parseAttachment(
  mime: string,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<ParsedAttachment> {
  signal?.throwIfAborted();
  invariant(active < 2, 'ATTACHMENT_BUSY', '正在处理其他附件，请稍后重试', 429);
  active++;
  let worker: Worker | undefined;
  try {
    worker = new Worker(
      new URL(
        import.meta.url.endsWith('.cjs') ? './attachment-worker.mjs' : './attachment-worker.ts',
        import.meta.url,
      ),
      {
        workerData: { mime, bytes },
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
        stdout: true,
        stderr: true,
      },
    );
    // Parser diagnostics can contain document data. Only typed public errors leave the worker.
    worker.stdout?.resume();
    worker.stderr?.resume();
    return await new Promise<ParsedAttachment>((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new AppError('ATTACHMENT_TIMEOUT', '附件处理超时，请换用更小的文件', 408)),
        15000,
      );
      const cancelled = () => finish(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      let settled = false;
      const finish = (error?: unknown, value?: ParsedAttachment) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancelled);
        if (error) reject(error);
        else resolve(value!);
      };
      signal?.addEventListener('abort', cancelled, { once: true });
      if (signal?.aborted) cancelled();
      worker!.once('message', (result) => {
        if (result.error)
          finish(new AppError(result.error.code, result.error.message, result.error.status));
        else finish(undefined, result.data);
      });
      worker!.once('error', () =>
        finish(
          new AppError('ATTACHMENT_PROCESSING', '附件处理失败或超出内存限制，请尝试更小的文件'),
        ),
      );
      worker!.once('exit', () =>
        finish(new AppError('ATTACHMENT_PROCESSING', '附件处理意外结束，请重试')),
      );
    });
  } finally {
    try {
      await worker?.terminate();
    } finally {
      active--;
    }
  }
}
