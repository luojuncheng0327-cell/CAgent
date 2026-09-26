/**
 * run-limits.ts — workflow 运行资源模型：limits 归一化、无进展 watchdog、节点重试分类。
 *
 * 语义总原则："报什么就是什么"。失败只能由 abort 引发（先 abort 再收尾），
 * 禁止出现"已报 fail 但脚本继续运行"的僵尸状态（旧实现里总时长 deadline 与脚本
 * promise 赛跑，reject 之后的收尾又把本该触发 abort 的定时器清掉，于是报死不死）。
 *
 * 三层资源模型：
 * - 节点级 nodeTimeoutMs：单节点超时（可重试的瞬时故障）
 * - 无进展 idleTimeoutMs：所有节点事件喂狗；饿死判定整条 workflow 卡死
 * - 总量 totalTimeoutMs + 节点总数上限：硬 backstop
 */

export const DEFAULT_RUN_LIMITS = {
  nodeTimeoutMs: 15 * 60_000,
  idleTimeoutMs: 10 * 60_000,
  totalTimeoutMs: 4 * 60 * 60_000,
  // Conservative desktop defaults; explicitly configured workflows can raise
  // these limits without changing the orchestration or permission contracts.
  maxConcurrent: 4,
  nodeRetries: 1,
};

export type RunLimits = typeof DEFAULT_RUN_LIMITS;

const CLAMPS: Record<keyof RunLimits, [number, number]> = {
  nodeTimeoutMs: [60_000, 60 * 60_000],
  idleTimeoutMs: [60_000, 60 * 60_000],
  totalTimeoutMs: [5 * 60_000, 12 * 60 * 60_000],
  maxConcurrent: [1, 64],
  nodeRetries: [0, 5],
};

export function normalizeRunLimits(raw: unknown): RunLimits {
  const source = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const out = { ...DEFAULT_RUN_LIMITS };
  for (const key of Object.keys(DEFAULT_RUN_LIMITS) as Array<keyof RunLimits>) {
    const v = source[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      const [lo, hi] = CLAMPS[key];
      out[key] = Math.min(hi, Math.max(lo, Math.floor(v)));
    }
  }
  return out;
}

/** 无进展 watchdog：feed() 重置计时；idleTimeoutMs 内无 feed → onIdleTimeout()（至多一次）。 */
export function createIdleWatchdog({ idleTimeoutMs, onIdleTimeout }: { idleTimeoutMs: number; onIdleTimeout: () => void }) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { if (!stopped) { stopped = true; onIdleTimeout(); } }, idleTimeoutMs);
    if (typeof (timer as any).unref === "function") (timer as any).unref();
  };
  return {
    start: arm,
    feed: arm,
    stop: () => { stopped = true; if (timer) clearTimeout(timer); },
  };
}

/**
 * 节点错误重试分类。默认可重试（未知错误按瞬时故障处理——provider 抖动形态
 * 无法穷举，宁多试一次不永久失败）；显式不可重试的是确定性失败：
 * 中止、预算/总数上限、选项与作用域校验、子代理越权。
 *
 * 注意：节点超时错误的措辞必须避开"中止 / aborted"，否则会被归成不可重试，
 * 单节点卡死就再也没有第二次机会（run-limits 测试里钉住了这条）。
 */
const NON_RETRYABLE_CODES = new Set([
  "WRITE_FOLDERS_INVALID",
  "WRITE_FOLDERS_CONFLICT_WITH_READ",
  "WRITE_FOLDERS_REQUIRED",
  "WRITE_FOLDER_NOT_FOUND",
  "WRITE_FOLDER_NOT_DIRECTORY",
  "WRITE_FOLDER_OUTSIDE_PARENT_SCOPE",
  "PARENT_SCOPE_UNAVAILABLE",
  "SUBAGENT_WRITE_DENIED_BY_PARENT_READ_ONLY",
]);

const NON_RETRYABLE_PATTERNS = [
  /已中止|被中止|\baborted\b/i,
  /预算耗尽/,
  /超出 agent 总数上限/,
  /unsupported option/,
  /access must be/,
  /agentType .* (was not found|cannot be resolved)/,
  /writeFolders/,
  /requires a non-empty prompt/,
];

export function isRetryableNodeError(err: unknown): boolean {
  const code = (err as any)?.code;
  if (typeof code === "string" && NON_RETRYABLE_CODES.has(code)) return false;
  const msg = String((err as any)?.message ?? err ?? "");
  if (NON_RETRYABLE_PATTERNS.some((re) => re.test(msg))) return false;
  return true;
}

/** 退避：第 1 次约 5s、之后约 20s，±20% jitter（宿主侧允许随机，脚本沙箱内才禁）。 */
export function retryDelayMs(attempt: number): number {
  const base = attempt <= 1 ? 5_000 : 20_000;
  const jitter = base * 0.2;
  return Math.round(base - jitter + Math.random() * jitter * 2);
}
