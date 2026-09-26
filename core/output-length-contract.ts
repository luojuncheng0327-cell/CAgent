type TextCaller<TResponse = unknown> = (request: Record<string, unknown>) => Promise<TResponse>;

export type OutputLengthUnit = "chars" | "words";

export type OutputLengthContract = {
  label?: string;
  target: number;
  unit?: OutputLengthUnit;
  min?: number;
  max?: number;
  minRatio?: number;
  maxRatio?: number;
  maxRepairAttempts?: number;
  locale?: string;
  neutralFallback?: string;
};

export type OutputLengthEvaluation = {
  ok: boolean;
  length: number;
  min: number;
  max: number;
  target: number;
  unit: OutputLengthUnit;
};

type Candidate<TResponse> = {
  response: TResponse;
  text: string;
  evaluation: OutputLengthEvaluation;
  attempt: number;
};

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function normalizeText(text: unknown): string {
  return String(text || "").replace(/\r\n?/g, "\n").trim();
}

function defaultExtractText(response: unknown): string {
  if (typeof response === "string") return response;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const maybeText = (response as Record<string, unknown>).text;
    if (typeof maybeText === "string") return maybeText;
  }
  return "";
}

export function measureOutputLength(text: string, unit: OutputLengthUnit = "chars"): number {
  const normalized = normalizeText(text);
  if (!normalized) return 0;
  if (unit === "words") {
    const words = normalized.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu);
    return words?.length || 0;
  }
  return Array.from(normalized).length;
}

export function evaluateLengthContract(text: string, contract: OutputLengthContract): OutputLengthEvaluation {
  const target = positiveInteger(contract.target) || 1;
  const unit = contract.unit || "chars";
  const min = positiveInteger(contract.min)
    || Math.max(1, Math.floor(target * (contract.minRatio ?? 0.6)));
  const max = positiveInteger(contract.max)
    || Math.max(min, Math.ceil(target * (contract.maxRatio ?? 2)));
  const length = measureOutputLength(text, unit);
  return {
    ok: length >= min && length <= max,
    length,
    min,
    max,
    target,
    unit,
  };
}

function unitLabel(unit: OutputLengthUnit, locale?: string): string {
  if (String(locale || "").toLowerCase().startsWith("en")) {
    return unit === "words" ? "words" : "characters";
  }
  return unit === "words" ? "个词" : "个字";
}

function buildRepairInstruction(contract: OutputLengthContract, evaluation: OutputLengthEvaluation): string {
  const locale = contract.locale || "";
  const label = contract.label || "文本";
  const unit = unitLabel(evaluation.unit, locale);
  if (locale.toLowerCase().startsWith("en")) {
    return [
      `The previous ${label} is ${evaluation.length} ${unit}, outside the acceptable range.`,
      `Please rewrite it near the target length of ${evaluation.target} ${unit}. Acceptable range: ${evaluation.min}-${evaluation.max} ${unit}.`,
      "Preserve the original meaning and useful details. Do not add explanations, prefixes, quotes, or markdown unless the original task asked for them.",
      "Output only the rewritten text.",
    ].join("\n");
  }
  return [
    `上一次输出的${label}长度是 ${evaluation.length}${unit}，不在可接受范围内。`,
    `请把它改写到目标 ${evaluation.target}${unit}附近，可接受范围是 ${evaluation.min}-${evaluation.max}${unit}。`,
    "保留原意和有用细节，不要额外解释，不要加前缀、引号或 markdown，除非原任务要求。",
    "只输出改写后的文本。",
  ].join("\n");
}

function buildRepairMessages(
  messages: unknown,
  candidateText: string,
  contract: OutputLengthContract,
  evaluation: OutputLengthEvaluation,
) {
  const baseMessages = Array.isArray(messages) ? messages : [];
  return [
    ...baseMessages,
    { role: "assistant", content: candidateText },
    { role: "user", content: buildRepairInstruction(contract, evaluation) },
  ];
}

function candidateScore(candidate: Candidate<unknown>): number {
  const length = candidate.evaluation.length;
  if (length <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(length - candidate.evaluation.target);
}

function selectBestCandidate<TResponse>(candidates: Candidate<TResponse>[]): Candidate<TResponse> | null {
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => candidateScore(a) - candidateScore(b))[0] || null;
}

export async function callTextWithLengthContract<TResponse = unknown>({
  callText,
  request,
  contract,
  extractText = defaultExtractText,
}: {
  callText: TextCaller<TResponse>;
  request: Record<string, unknown>;
  contract: OutputLengthContract;
  extractText?: (response: TResponse) => string;
}): Promise<{
  response: TResponse;
  text: string;
  evaluation: OutputLengthEvaluation;
  attempts: number;
  repaired: boolean;
}> {
  // Length is a presentation preference, not a reason to silently spend two
  // more model calls. Repairs are opt-in and must retain the caller's budget.
  const baseRequest = { ...request };
  const maxRepairAttempts = contract.maxRepairAttempts ?? 0;
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0 || maxRepairAttempts > 2) {
    throw new RangeError("maxRepairAttempts must be an integer between 0 and 2");
  }
  const signal = request.signal as AbortSignal | undefined;
  const candidates: Candidate<TResponse>[] = [];
  let nextRequest = baseRequest;

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt += 1) {
    signal?.throwIfAborted();
    const response = await callText(nextRequest);
    signal?.throwIfAborted();
    const text = normalizeText(extractText(response));
    const evaluation = evaluateLengthContract(text, contract);
    const candidate = { response, text, evaluation, attempt };
    candidates.push(candidate);
    if (evaluation.ok) {
      return {
        ...candidate,
        attempts: attempt + 1,
        repaired: attempt > 0,
      };
    }
    nextRequest = {
      ...baseRequest,
      messages: buildRepairMessages(baseRequest.messages, text, contract, evaluation),
    };
  }

  const best = selectBestCandidate(candidates);
  if (best) {
    return {
      ...best,
      attempts: candidates.length,
      repaired: best.attempt > 0,
    };
  }

  const fallbackText = normalizeText(contract.neutralFallback);
  const fallbackResponse = fallbackText as TResponse;
  return {
    response: fallbackResponse,
    text: fallbackText,
    evaluation: evaluateLengthContract(fallbackText, contract),
    attempts: candidates.length,
    repaired: false,
  };
}
