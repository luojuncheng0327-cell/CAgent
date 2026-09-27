// Development-only helpers that compare this repository with the reference checkout.
// Not imported by the application.
import ts from 'typescript';

/** Separates independent pieces of text. Never equal to anything, itself included. */
export const BARRIER = 0;

/** Maps token keys to small positive integers so sequences can be hashed and compared cheaply. */
export class Codebook {
  #codes = new Map<string, number>();
  code(key: string) {
    let value = this.#codes.get(key);
    if (value === undefined) this.#codes.set(key, (value = this.#codes.size + 1));
    return value;
  }
}

export type Piece = { text: string; line: number; kind: 'string' | 'markup' | 'comment' | 'prose' };
export type ScriptScan = {
  /** Structural codes. Names and literal values are abstracted, so renamed copies still line up. */
  shape: Int32Array;
  /** Identity of each name or literal (0 for keywords and punctuation), to measure verbatim reuse. */
  exact: Int32Array;
  lines: Int32Array;
  pieces: Piece[];
  names: Set<string>;
};
export type StyleScan = {
  codes: Int32Array;
  lines: Int32Array;
  pieces: Piece[];
  classes: Set<string>;
};
export type Prose = { codes: Int32Array; lines: Int32Array; units: string[] };
export type Run = {
  ours: number;
  ourStart: number;
  theirs: number;
  theirStart: number;
  length: number;
  /** How many reference files contain the k-gram that seeded this run. */
  spread: number;
};
/** seed: k-gram length; min: shortest run reported; common: k-grams in more reference files never seed. */
export type MatchOptions = { seed: number; min: number; common: number };

const K = ts.SyntaxKind;
const scriptKinds: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.jsx': ts.ScriptKind.JSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};
const COMMA = 'k' + K.CommaToken,
  OPEN = 'k' + K.OpenParenToken,
  CLOSE = 'k' + K.CloseParenToken,
  ARROW = 'k' + K.EqualsGreaterThanToken;
const CLOSERS = new Set([CLOSE, 'k' + K.CloseBracketToken, 'k' + K.CloseBraceToken]);

export function lineIndex(text: string) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset: number) => {
    let low = 0,
      high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

function fingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return hash || 1;
}

type Token = { shape: string; exact: string | null; line: number };
type Described = { shape: string; exact: string | null; piece?: string; name?: string };

function describe(node: ts.Node, source: ts.SourceFile): Described | null {
  switch (node.kind) {
    case K.Identifier:
    case K.PrivateIdentifier: {
      const name = (node as ts.Identifier).text;
      return { shape: 'name', exact: 'n:' + name, name };
    }
    case K.StringLiteral:
    case K.NoSubstitutionTemplateLiteral: {
      const value = (node as ts.LiteralLikeNode).text;
      return { shape: 'text', exact: 's:' + value, piece: value };
    }
    case K.TemplateHead:
    case K.TemplateMiddle:
    case K.TemplateTail: {
      const value = (node as ts.LiteralLikeNode).text;
      return { shape: 'k' + node.kind, exact: 's:' + value, piece: value };
    }
    case K.NumericLiteral:
    case K.BigIntLiteral:
    case K.RegularExpressionLiteral:
      return { shape: 'k' + node.kind, exact: 'v:' + node.getText(source) };
    case K.JsxText:
    case K.JsxTextAllWhiteSpaces: {
      const value = node.getText(source).trim();
      return value ? { shape: 'markup', exact: 'j:' + value, piece: value } : null;
    }
    case K.LetKeyword:
    case K.VarKeyword:
    case K.ConstKeyword:
      return { shape: 'declare', exact: null };
    case K.EqualsEqualsEqualsToken:
      return { shape: 'k' + K.EqualsEqualsToken, exact: null };
    case K.ExclamationEqualsEqualsToken:
      return { shape: 'k' + K.ExclamationEqualsToken, exact: null };
    case K.SemicolonToken:
    case K.EndOfFileToken:
      return null;
    default:
      return { shape: 'k' + node.kind, exact: null };
  }
}

/** Removes differences that are pure code style: trailing commas and `(x) =>` versus `x =>`. */
function withoutStyle(tokens: Token[]) {
  const kept: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i],
      next = tokens[i + 1];
    if (token.shape === COMMA && next && CLOSERS.has(next.shape)) continue;
    if (
      token.shape === OPEN &&
      next?.shape === 'name' &&
      tokens[i + 2]?.shape === CLOSE &&
      tokens[i + 3]?.shape === ARROW
    ) {
      kept.push(next);
      i += 2;
      continue;
    }
    kept.push(token);
  }
  return kept;
}

const commentBody = (raw: string) =>
  raw.startsWith('//') ? raw.slice(2) : raw.slice(2, -2).replace(/^\s*\*/gm, '');

export function scanScript(file: string, text: string, book: Codebook): ScriptScan {
  const source = ts.createSourceFile(
    file,
    text,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    false,
    scriptKinds[file.slice(file.lastIndexOf('.')).toLowerCase()] ?? ts.ScriptKind.TS,
  );
  const tokens: Token[] = [],
    pieces: Piece[] = [],
    names = new Set<string>();
  const lineOf = (pos: number) => source.getLineAndCharacterOfPosition(pos).line + 1;
  const visit = (node: ts.Node, quiet: boolean) => {
    if (node.kind >= K.FirstJSDocNode && node.kind <= K.LastJSDocNode) return;
    const children = node.getChildren(source);
    if (children.length) {
      // Import lists carry no logic; comments inside them still count as wording.
      const skip =
        quiet ||
        ts.isImportDeclaration(node) ||
        (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined);
      for (const child of children) visit(child, skip);
      return;
    }
    if (node.kind === K.SyntaxList || node.pos === node.end) return;
    if (node.kind !== K.JsxText)
      for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? [])
        pieces.push({
          text: commentBody(text.slice(range.pos, range.end)),
          line: lineOf(range.pos),
          kind: 'comment',
        });
    if (quiet) return;
    const found = describe(node, source);
    if (!found) return;
    const line = lineOf(node.getStart(source));
    if (found.piece !== undefined)
      pieces.push({
        text: found.piece,
        line,
        kind: found.shape === 'markup' ? 'markup' : 'string',
      });
    if (found.name !== undefined) names.add(found.name);
    tokens.push({ shape: found.shape, exact: found.exact, line });
  };
  visit(source, false);
  const kept = withoutStyle(tokens);
  return {
    shape: Int32Array.from(kept, (t) => book.code(t.shape)),
    exact: Int32Array.from(kept, (t) => (t.exact === null ? 0 : fingerprint(t.exact))),
    lines: Int32Array.from(kept, (t) => t.line),
    pieces,
    names,
  };
}

const cssValue = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([,()/!])\s*/g, '$1')
    .replace(/(^|[^\w.])0+(?=\.\d)/g, '$1');

/** Flattens a stylesheet into normalized `property:value` declarations with a marker after each block. */
export function scanStyle(text: string, book: Codebook): StyleScan {
  const lineAt = lineIndex(text),
    pieces: Piece[] = [];
  // Blank comments out (keeping offsets) so braces or semicolons inside them are ignored.
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, (comment: string, at: number) => {
    pieces.push({ text: comment.slice(2, -2), line: lineAt(at), kind: 'comment' });
    return comment.replace(/[^\n]/g, ' ');
  });
  const codes: number[] = [],
    lines: number[] = [],
    classes = new Set<string>();
  let start = 0,
    depth = 0,
    quote = '';
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === '{' || ch === '}' || ch === ';')) {
      const raw = plain.slice(start, i),
        segment = raw.trim();
      if (ch === '{') {
        if (!segment.startsWith('@'))
          for (const m of segment.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(m[1]);
      } else if (segment && !segment.startsWith('@')) {
        const colon = segment.indexOf(':');
        if (colon > 0) {
          const property = segment.slice(0, colon).trim().toLowerCase();
          if (property.startsWith('--')) classes.add(property);
          codes.push(book.code('css:' + property + ':' + cssValue(segment.slice(colon + 1))));
          lines.push(lineAt(start + raw.search(/\S/)));
        }
      }
      if (ch === '}') {
        codes.push(book.code('css:}'));
        lines.push(lineAt(i));
      }
      start = i + 1;
    }
  }
  return { codes: Int32Array.from(codes), lines: Int32Array.from(lines), pieces, classes };
}

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
/** One CJK character, or one run of other letters and digits, so both kinds of text weigh alike. */
const UNIT = new RegExp(`[${CJK}]|(?:(?![${CJK}])[\\p{L}\\p{N}_])+`, 'gu');

export const proseUnits = (text: string) =>
  Array.from(text.matchAll(UNIT), (m) => m[0].toLowerCase());

/** Splits documents into pieces of wording: paragraphs, or string values for JSON. */
export function prosePieces(file: string, text: string): Piece[] {
  if (file.endsWith('.json')) {
    const lineAt = lineIndex(text);
    return Array.from(text.matchAll(/"(?:[^"\\\r\n]|\\.)*"/g), (m) => {
      let value = m[0];
      try {
        value = JSON.parse(m[0]);
      } catch {}
      return { text: value, line: lineAt(m.index), kind: 'string' as const };
    });
  }
  const plain = file.endsWith('.html')
    ? text.replace(/<[^>]*>/g, (tag) => tag.replace(/[^\n]/g, ' '))
    : text;
  const pieces: Piece[] = [];
  let rows: string[] = [],
    first = 0;
  plain.split('\n').forEach((row, i) => {
    if (row.trim()) {
      if (!rows.length) first = i + 1;
      rows.push(row);
    } else if (rows.length) {
      pieces.push({ text: rows.join('\n'), line: first, kind: 'prose' });
      rows = [];
    }
  });
  if (rows.length) pieces.push({ text: rows.join('\n'), line: first, kind: 'prose' });
  return pieces;
}

export function encodeProse(pieces: Piece[], book: Codebook, keepUnits = false): Prose {
  const codes: number[] = [],
    lines: number[] = [],
    units: string[] = [];
  for (const piece of pieces) {
    let line = piece.line,
      seen = 0;
    for (const m of piece.text.matchAll(UNIT)) {
      for (; seen < m.index; seen++) if (piece.text.charCodeAt(seen) === 10) line++;
      const unit = m[0].toLowerCase();
      codes.push(book.code('u:' + unit));
      lines.push(line);
      if (keepUnits) units.push(unit);
    }
    codes.push(BARRIER);
    lines.push(line);
    if (keepUnits) units.push('');
  }
  return { codes: Int32Array.from(codes), lines: Int32Array.from(lines), units };
}

const BASE = 1_000_003;

/** Calls `visit` with a rolling hash of every window of `size` codes that contains no barrier. */
function windows(seq: Int32Array, size: number, visit: (hash: number, at: number) => void) {
  let top = 1;
  for (let i = 0; i < size; i++) top = Math.imul(top, BASE);
  let hash = 0,
    barrier = -1;
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] === BARRIER) barrier = i;
    hash = (Math.imul(hash, BASE) + seq[i]) | 0;
    if (i >= size) hash = (hash - Math.imul(seq[i - size], top)) | 0;
    if (i >= size - 1 && barrier <= i - size) visit(hash, i - size + 1);
  }
}

const same = (a: number, b: number) => a === b && a !== BARRIER;

function agree(a: Int32Array, i: number, b: Int32Array, j: number, size: number) {
  for (let x = 0; x < size; x++) if (!same(a[i + x], b[j + x])) return false;
  return true;
}

/**
 * Finds maximal runs of identical codes shared by one of `ours` and one of `theirs`.
 * Every window of `seed` codes is indexed on our side; windows found in more than `common`
 * reference files are treated as everyday idioms and never start a run, although a run that
 * began elsewhere may still extend through them.
 */
export function sharedRuns(ours: Int32Array[], theirs: Int32Array[], options: MatchOptions) {
  const { seed, min, common } = options;
  const index = new Map<number, number[]>();
  ours.forEach((seq, file) =>
    windows(seq, seed, (hash, at) => {
      const hits = index.get(hash);
      if (hits) hits.push(file, at);
      else index.set(hash, [file, at]);
    }),
  );
  const spread = new Map<number, number>(),
    lastFile = new Map<number, number>();
  theirs.forEach((seq, file) =>
    windows(seq, seed, (hash) => {
      if (!index.has(hash) || lastFile.get(hash) === file) return;
      lastFile.set(hash, file);
      spread.set(hash, (spread.get(hash) ?? 0) + 1);
    }),
  );
  const runs: Run[] = [];
  theirs.forEach((seq, file) => {
    // Furthest point already covered on each diagonal (our file, offset between the two sides).
    const reached = new Map<string, number>();
    windows(seq, seed, (hash, at) => {
      const hits = index.get(hash),
        files = spread.get(hash) ?? 0;
      if (!hits || files > common) return;
      for (let h = 0; h < hits.length; h += 2) {
        const mine = ours[hits[h]],
          start = hits[h + 1],
          diagonal = hits[h] + ':' + (at - start);
        if ((reached.get(diagonal) ?? -1) > start || !agree(mine, start, seq, at, seed)) continue;
        let before = 0,
          after = seed;
        while (
          start - before > 0 &&
          at - before > 0 &&
          same(mine[start - before - 1], seq[at - before - 1])
        )
          before++;
        while (
          start + after < mine.length &&
          at + after < seq.length &&
          same(mine[start + after], seq[at + after])
        )
          after++;
        reached.set(diagonal, start + after);
        if (before + after >= min)
          runs.push({
            ours: hits[h],
            ourStart: start - before,
            theirs: file,
            theirStart: at - before,
            length: before + after,
            spread: files,
          });
      }
    });
  });
  return runs;
}
