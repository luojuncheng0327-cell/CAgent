import { ZodError } from 'zod';
export class AppError extends Error {
  code: string;
  status: number;
  retryable: boolean;
  constructor(code: string, message: string, status = 400, retryable = false) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
export function invariant(
  value: unknown,
  code: string,
  message: string,
  status = 400,
): asserts value {
  if (!value) throw new AppError(code, message, status);
}
export function publicError(e: unknown) {
  if (e instanceof ZodError)
    return new AppError(
      'INVALID_INPUT',
      e.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '),
    );
  if (e instanceof AppError) return e;
  if (e instanceof DOMException && e.name === 'AbortError')
    return new AppError('CANCELLED', '操作已取消', 409);
  // Do not forward arbitrary upstream or filesystem errors, which can contain credentials.
  return new AppError('INTERNAL_ERROR', '操作未能完成，请查看本地诊断编号', 500);
}
export const stamp = () => new Date().toISOString();
