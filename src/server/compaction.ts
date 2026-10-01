import type { InputMessage } from './resources.ts';
import { invariant } from './errors.ts';

export function estimateContext(messages: InputMessage[], instructions: string) {
  return (
    JSON.stringify(
      messages.map((m) => ({
        ...m,
        images: m.images?.map(() => ({ image: true })),
      })),
    ).length +
    instructions.length +
    messages.reduce((n, m) => n + (m.images?.length ?? 0) * 4096, 0)
  );
}

export interface HistoryFragment {
  original: InputMessage;
  text: string;
}
export interface FragmentCursor {
  index: number;
  offset: number;
}

export function summaryFragments(messages: InputMessage[]): HistoryFragment[] {
  return messages.map((message) => ({
    original: message,
    text: JSON.stringify({
      role: message.role,
      text: message.text,
      reasoning: message.reasoning,
      calls: message.calls,
      callId: message.callId,
      attachmentIds: message.attachmentIds,
    }),
  }));
}

export function nextSummaryBatch(
  fragments: HistoryFragment[],
  start: FragmentCursor,
  instructions: string,
  budget: number,
) {
  const messages: InputMessage[] = [];
  let { index, offset } = start;
  while (index < fragments.length) {
    const { original, text } = fragments[index];
    const build = (end: number): InputMessage => ({
      id: original.id,
      sessionId: original.sessionId,
      runId: original.runId,
      at: original.at,
      position: original.position,
      role: 'user',
      text:
        '历史消息资料 ' +
        JSON.stringify({ messageId: original.id, position: original.position, offset }) +
        '\n' +
        text.slice(offset, end),
      images: offset === 0 ? original.images : undefined,
    });
    let low = offset,
      high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (estimateContext([...messages, build(middle)], instructions) < budget) low = middle;
      else high = middle - 1;
    }
    // Keep UTF-16 surrogate pairs together, so JSON and UTF-8 encoding cannot alter a split character.
    if (low < text.length && low > offset && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
    if (low === offset) {
      if (messages.length) break;
      invariant(
        false,
        'COMPACT_INPUT_LIMIT',
        '摘要或单张图片已超过当前模型窗口，请选择更大上下文模型；原文保持完整',
      );
    }
    messages.push(build(low));
    if (low < text.length) {
      offset = low;
      break;
    }
    index++;
    offset = 0;
  }
  return { messages, cursor: { index, offset } };
}
