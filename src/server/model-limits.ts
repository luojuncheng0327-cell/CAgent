export const deepSeekLimitsUrl = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';

function tokens(text: string): number | null {
  const exact = text.match(/[（(]([\d,]+)[）)]/);
  const amount = text.match(
    /^(?:最大\s*|Max(?:imum)?\s*)?([\d,]+(?:\.\d+)?)\s*([KMG]?)(?:\s*tokens?)?$/i,
  );
  if (!exact && !amount) return null;
  const value = exact
    ? Number(exact[1].replaceAll(',', ''))
    : Number(amount![1].replaceAll(',', '')) *
      1024 ** (amount![2] ? 'KMG'.indexOf(amount![2].toUpperCase()) + 1 : 0);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function parseDeepSeekLimits(html: string, model: string) {
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
      [...row[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => ({
        text: cell[2]
          .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '')
          .replace(/<[^>]*>/g, ' ')
          .replace(/&nbsp;|&#160;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
        span: Number(cell[1].match(/\bcolspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1),
      })),
    );
    const heading = rows.find((row) => /^(模型|Model)$/i.test(row[0]?.text ?? ''));
    if (!heading) continue;
    const names = heading.slice(1).map((cell) => cell.text);
    const index = names.indexOf(model);
    if (index < 0) continue;
    const limit = (label: RegExp) => {
      const row = rows.find((cells) => label.test(cells[0]?.text ?? ''));
      if (!row) return null;
      const cells = row
        .slice(1)
        .flatMap((cell) =>
          Array.from({ length: Math.min(cell.span, names.length) }, () => cell.text),
        );
      return cells.length === names.length ? tokens(cells[index]) : null;
    };
    const contextWindow = limit(/^(上下文长度|Context Length)$/i);
    const maxOutput = limit(/^(输出长度|Max Output|Output Length)$/i);
    if (contextWindow !== null || maxOutput !== null) return { contextWindow, maxOutput };
  }
  return null;
}
