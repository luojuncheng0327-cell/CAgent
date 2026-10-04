export function lineStarts(text: string) {
  const starts = text ? [0] : [];
  const newline = /\r\n|\r|\n/g;
  for (const match of text.matchAll(newline)) {
    const next = match.index + match[0].length;
    if (next < text.length) starts.push(next);
  }
  return starts;
}

export function fileRange(
  text: string,
  input: { offset?: number; limit: number; startLine?: number; endLine?: number },
) {
  const starts = lineStarts(text);
  const offset =
    input.startLine === undefined
      ? (input.offset ?? 0)
      : (starts[input.startLine - 1] ?? text.length);
  const requestedEnd =
    input.endLine === undefined ? text.length : (starts[input.endLine] ?? text.length);
  const end = Math.min(requestedEnd, offset + input.limit);
  const nextLine = starts.findIndex((start) => start >= end);
  return {
    text: text.slice(offset, end),
    totalLines: starts.length,
    offset,
    truncated: end < text.length,
    ...(end < text.length ? { nextOffset: end } : {}),
    ...(input.startLine === undefined
      ? {}
      : {
          startLine: input.startLine,
          endLine: starts.filter((start) => start < end).length,
          ...(end < text.length && starts[nextLine] === end ? { nextLine: nextLine + 1 } : {}),
        }),
  };
}
