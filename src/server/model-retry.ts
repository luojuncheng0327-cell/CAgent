import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from './errors.ts';
import type { Fetcher } from './models.ts';

export interface RetryNotice {
  attempt: number;
  delayMs: number;
  code: string;
}

export async function fetchModelResponse(
  url: string,
  init: RequestInit,
  options: {
    fetcher?: Fetcher;
    signal: AbortSignal;
    maxRetries: number;
    onRetry?: (notice: RetryNotice) => void;
  },
) {
  const transientStatus = new Set([408, 429, 500, 502, 503, 504]);
  const certificateErrors = new Set([
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  ]);
  for (let attempt = 0; ; attempt++) {
    options.signal.throwIfAborted();
    let failure: AppError;
    let wait = 250 * 2 ** attempt;
    try {
      const response = await (options.fetcher ?? fetch)(url, { ...init, signal: options.signal });
      if (response.ok) return response;
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) {
        const seconds = /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
        const milliseconds = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(milliseconds)) wait = Math.max(0, milliseconds);
      }
      await response.body?.cancel().catch(() => {});
      failure = new AppError(
        `MODEL_HTTP_${response.status}`,
        `模型服务返回 HTTP ${response.status}`,
        502,
        transientStatus.has(response.status),
      );
    } catch (error: any) {
      options.signal.throwIfAborted();
      const tls = certificateErrors.has(error?.cause?.code ?? error?.code);
      failure = new AppError(
        tls ? 'MODEL_TLS' : 'MODEL_NETWORK',
        tls
          ? '模型服务的安全证书验证失败，请检查证书和系统时间'
          : '无法连接模型服务，请检查地址和网络',
        502,
        !tls,
      );
    }
    // Long server-directed delays are left for an explicit retry; never retry earlier than requested.
    if (!failure.retryable || attempt >= options.maxRetries || wait > 30000) throw failure;
    options.onRetry?.({ attempt: attempt + 1, delayMs: wait, code: failure.code });
    await delay(wait, undefined, { signal: options.signal });
  }
}
