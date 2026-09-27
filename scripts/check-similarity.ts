// Development-only report on how closely this repository's code and wording follow the reference
// checkout. Reads the reference without modifying it and writes only to .artifacts/.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  Codebook,
  encodeProse,
  findException,
  prosePieces,
  proseUnits,
  readExceptions,
  scanScript,
  scanStyle,
  sharedRuns,
  type Exception,
  type Finding,
  type MatchOptions,
  type Prose,
  type Run,
  type ScriptScan,
  type StyleScan,
} from './similarity.ts';

const REFERENCE = 'F:/CAgent';
const SNAPSHOT = path.join(REFERENCE, '.codex/rewrite-spec/original-state.json');
/** Reviewed overlaps that are public conventions; each entry carries its reason. */
const EXCEPTIONS = 'scripts/similarity-exceptions.json';
const GENERATED = new Set(['docs/IMPLEMENTATION-STATUS.md', 'docs/CAgent-功能清单与验收规格.md']);
const OPTIONS: Record<'code' | 'style' | 'prose', MatchOptions> = {
  code: { seed: 20, min: 20, common: 10 },
  style: { seed: 4, min: 6, common: 10 },
  prose: { seed: 8, min: 10, common: 10 },
};
/** Only code runs at least this long are listed one by one; shorter ones count towards file pairs. */
const LISTED_RUN = 50;
/** Runs with fewer distinct token shapes are data-like repetition (tables, lists), not logic. */
const VARIETY = { listed: 10, pair: 8 };
/** Crossing any limit fails the check. Calibrated on disguised copies of reference files. */
const POLICY = {
  codeRun: 80,
  pairShare: 0.4,
  pairMinTokens: 150,
  proseRun: 16,
  styleRun: 8,
};
const MAX_FILE_BYTES = 2 * 1024 * 1024;

type Kind = 'script' | 'style' | 'prose';
type Scan = {
  file: string;
  script?: ScriptScan;
  style?: StyleScan;
  prose: Prose;
  literals: string[];
};
type Lines = [number, number];
type Place = { file: string; lines: Lines };

const kindOf = (file: string): Kind | null =>
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)
    ? 'script'
    : file.endsWith('.css')
      ? 'style'
      : /\.(md|html|json)$/.test(file)
        ? 'prose'
        : null;
const round = (x: number) => Math.round(x * 10000) / 10000;
const percent = (x: number) => (x * 100).toFixed(2) + '%';
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const where = (place: Place) => `${place.file}:${place.lines[0]}-${place.lines[1]}`;
const joinUnits = (units: string[]) =>
  units.reduce((text, unit) => text + (/\w$/.test(text) && /^\w/.test(unit) ? ' ' : '') + unit, '');

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.posix.join(dir, entry.name);
    return entry.isDirectory() ? walk(rel) : [rel];
  });
}

function scan(root: string, file: string, book: Codebook, keepUnits: boolean): Scan | null {
  const full = path.join(root, file);
  if (!fs.existsSync(full) || fs.statSync(full).size > MAX_FILE_BYTES) return null;
  const text = fs.readFileSync(full, 'utf8'),
    kind = kindOf(file);
  const script = kind === 'script' ? scanScript(file, text, book) : undefined,
    style = kind === 'style' ? scanStyle(text, book) : undefined,
    pieces = script?.pieces ?? style?.pieces ?? prosePieces(file, text);
  const literals = pieces
    .filter((p) => p.kind === 'string' || p.kind === 'markup')
    .map((p) => proseUnits(p.text))
    .filter((units) => units.length >= 3)
    .map((units) => units.join(' '));
  return { file, script, style, prose: encodeProse(pieces, book, keepUnits), literals };
}

/** Names declared by the platform and libraries we build on; sharing those says nothing. */
function vocabulary() {
  const words = new Set<string>();
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir)) {
      if (entry === 'node_modules') continue;
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) visit(full);
      else if (/\.d\.[cm]?ts$/.test(entry))
        for (const m of fs.readFileSync(full, 'utf8').matchAll(/[A-Za-z_$][\w$]*/g))
          words.add(m[0]);
    }
  };
  for (const root of ['typescript/lib', '@types', 'electron', 'zod', 'markdown-it']) {
    const dir = path.join('node_modules', root);
    if (fs.existsSync(dir)) visit(fs.realpathSync(dir));
  }
  return words;
}

function tally(map: Map<string, string[]>, key: string, file: string) {
  const files = map.get(key);
  if (!files) map.set(key, [file]);
  else if (files.at(-1) !== file) files.push(file);
}

/** Keeps one entry per region of our code; the rest are counted as other places it also matches. */
function distinct<T extends { run: Run }>(items: T[]) {
  const seen = new Map<string, T & { alsoMatches: number }>();
  for (const item of items) {
    const key = item.run.ours + ':' + item.run.ourStart + ':' + item.run.length;
    const known = seen.get(key);
    if (known) known.alsoMatches++;
    else seen.set(key, { ...item, alsoMatches: 0 });
  }
  return [...seen.values()];
}

const count = (bits: Uint8Array) => bits.reduce((n, bit) => n + bit, 0);
const timer = performance.now(),
  phases: Record<string, number> = {};
const lap = (name: string) => (phases[name] = Math.round(performance.now() - timer) / 1000);

if (!fs.existsSync(SNAPSHOT)) {
  console.log(
    JSON.stringify({
      referenceAvailable: false,
      note: 'Reference snapshot not found: ' + SNAPSHOT,
    }),
  );
  process.exit(0);
}
const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) as {
  head: string;
  hashes: Record<string, string>;
};
const book = new Codebook();

const ownFiles = [
  ...['src', 'tests', 'scripts', 'spec', 'docs'].flatMap(walk),
  'vite.config.ts',
  'README.md',
  '.codex/HANDOFF.md',
]
  .filter((f) => kindOf(f) && !f.endsWith('.json') && !GENERATED.has(f))
  .sort();
const own = ownFiles.flatMap((f) => scan('.', f, book, true) ?? []);
const ownScripts = own.filter((s) => s.script),
  ownStyles = own.filter((s) => s.style);
const ownNames = new Map<string, string[]>(),
  ownClasses = new Map<string, string[]>(),
  ownLiterals = new Map<string, string[]>();
for (const s of own) {
  for (const name of s.script?.names ?? []) tally(ownNames, name, s.file);
  for (const name of s.style?.classes ?? []) tally(ownClasses, name, s.file);
  for (const literal of s.literals) tally(ownLiterals, literal, s.file);
}
lap('ours');

const referenceFiles = Object.keys(snapshot.hashes)
  .filter((f) => kindOf(f) && !f.endsWith('package-lock.json'))
  .sort();
type Slim<T> = T & { file: string };
const refScripts: Slim<{ shape: Int32Array; exact: Int32Array; lines: Int32Array }>[] = [],
  refStyles: Slim<{ codes: Int32Array; lines: Int32Array }>[] = [],
  refProse: Slim<{ codes: Int32Array; lines: Int32Array }>[] = [];
const nameSpread = new Map<string, string[]>(),
  classSpread = new Map<string, string[]>(),
  literalSpread = new Map<string, string[]>();
for (const file of referenceFiles) {
  const s = scan(REFERENCE, file, book, false);
  if (!s) continue;
  if (s.script) {
    const { shape, exact, lines, names } = s.script;
    refScripts.push({ file, shape, exact, lines });
    for (const name of names) if (ownNames.has(name)) tally(nameSpread, name, file);
  }
  if (s.style) {
    refStyles.push({ file, codes: s.style.codes, lines: s.style.lines });
    for (const name of s.style.classes) if (ownClasses.has(name)) tally(classSpread, name, file);
  }
  refProse.push({ file, codes: s.prose.codes, lines: s.prose.lines });
  for (const literal of s.literals)
    if (ownLiterals.has(literal)) tally(literalSpread, literal, file);
}
lap('reference');

const codeRuns = sharedRuns(
  ownScripts.map((s) => s.script!.shape),
  refScripts.map((r) => r.shape),
  OPTIONS.code,
);
const styleRuns = sharedRuns(
  ownStyles.map((s) => s.style!.codes),
  refStyles.map((r) => r.codes),
  OPTIONS.style,
);
const proseRuns = sharedRuns(
  own.map((s) => s.prose.codes),
  refProse.map((r) => r.codes),
  OPTIONS.prose,
);
lap('matching');

const codeFindings = codeRuns.map((run) => {
  const mine = ownScripts[run.ours].script!,
    theirs = refScripts[run.theirs],
    shapes = new Set<number>();
  let named = 0,
    identical = 0;
  for (let i = 0; i < run.length; i++) {
    shapes.add(mine.shape[run.ourStart + i]);
    const value = mine.exact[run.ourStart + i];
    if (!value) continue;
    named++;
    if (value === theirs.exact[run.theirStart + i]) identical++;
  }
  const last = run.length - 1;
  return {
    ours: {
      file: ownScripts[run.ours].file,
      lines: [mine.lines[run.ourStart], mine.lines[run.ourStart + last]] as Lines,
    },
    reference: {
      file: theirs.file,
      lines: [theirs.lines[run.theirStart], theirs.lines[run.theirStart + last]] as Lines,
    },
    tokens: run.length,
    /** Share of names and literals in the run that are also spelled the same. */
    identical: named ? round(identical / named) : 0,
    variety: shapes.size,
    spread: run.spread,
    run,
  };
});

const listed = codeFindings.filter((f) => f.tokens >= LISTED_RUN && f.variety >= VARIETY.listed);
const covered = ownScripts.map((s) => new Uint8Array(s.script!.shape.length));
for (const f of listed) covered[f.run.ours].fill(1, f.run.ourStart, f.run.ourStart + f.run.length);
const files = ownScripts
  .map((s, i) => {
    const mine = listed.filter((f) => f.run.ours === i),
      byReference = new Map<string, number>();
    for (const f of mine)
      byReference.set(f.reference.file, (byReference.get(f.reference.file) ?? 0) + f.tokens);
    const tokens = s.script!.shape.length,
      hit = count(covered[i]);
    return {
      file: s.file,
      tokens,
      covered: hit,
      coverage: tokens ? round(hit / tokens) : 0,
      longest: mine.reduce((n, f) => Math.max(n, f.tokens), 0),
      references: [...byReference]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([file, tokens]) => ({ file, tokens })),
    };
  })
  .sort((a, b) => b.coverage - a.coverage || b.longest - a.longest);
const code = distinct(listed).sort((a, b) => b.tokens - a.tokens || b.identical - a.identical);
const repetitive = distinct(
  codeFindings.filter((f) => f.tokens >= LISTED_RUN && f.variety < VARIETY.listed),
);

// An edited copy breaks into many short runs against one reference file; add them up per pair.
const pairBits = new Map<
  string,
  { ours: number; theirs: number; bits: Uint8Array; runs: number }
>();
for (const f of codeFindings) {
  if (f.variety < VARIETY.pair) continue;
  const key = f.run.ours + ':' + f.run.theirs;
  let pair = pairBits.get(key);
  if (!pair)
    pairBits.set(
      key,
      (pair = {
        ours: f.run.ours,
        theirs: f.run.theirs,
        bits: new Uint8Array(covered[f.run.ours].length),
        runs: 0,
      }),
    );
  pair.bits.fill(1, f.run.ourStart, f.run.ourStart + f.run.length);
  pair.runs++;
}
const pairs = [...pairBits.values()]
  .map((p) => ({
    ours: ownScripts[p.ours].file,
    reference: refScripts[p.theirs].file,
    tokens: p.bits.length,
    covered: count(p.bits),
    share: round(count(p.bits) / p.bits.length),
    runs: p.runs,
  }))
  .sort((a, b) => b.share - a.share || b.covered - a.covered);

const blockEnd = book.code('css:}');
const style = distinct(
  styleRuns.map((run) => {
    const mine = ownStyles[run.ours].style!,
      theirs = refStyles[run.theirs],
      last = run.length - 1;
    return {
      ours: {
        file: ownStyles[run.ours].file,
        lines: [mine.lines[run.ourStart], mine.lines[run.ourStart + last]] as Lines,
      },
      reference: {
        file: theirs.file,
        lines: [theirs.lines[run.theirStart], theirs.lines[run.theirStart + last]] as Lines,
      },
      declarations: mine.codes
        .subarray(run.ourStart, run.ourStart + run.length)
        .filter((c) => c !== blockEnd).length,
      spread: run.spread,
      run,
    };
  }),
).sort((a, b) => b.declarations - a.declarations);

const prose = distinct(
  proseRuns.map((run) => {
    const mine = own[run.ours].prose,
      theirs = refProse[run.theirs];
    return {
      ours: { file: own[run.ours].file, line: mine.lines[run.ourStart] },
      reference: { file: theirs.file, line: theirs.lines[run.theirStart] },
      units: run.length,
      text: joinUnits(mine.units.slice(run.ourStart, run.ourStart + run.length)),
      spread: run.spread,
      run,
    };
  }),
).sort((a, b) => b.units - a.units);

const api = vocabulary();
const distinctive = [...ownNames.keys()].filter((name) => name.length >= 6 && !api.has(name));
const names = distinctive
  .filter((name) => nameSpread.has(name))
  .map((name) => ({
    name,
    ours: ownNames.get(name)!,
    referenceFiles: nameSpread.get(name)!.length,
    examples: nameSpread.get(name)!.slice(0, 2),
  }))
  .sort((a, b) => a.referenceFiles - b.referenceFiles || b.name.length - a.name.length);
const classes = [...classSpread]
  .map(([name, refs]) => ({
    name,
    ours: ownClasses.get(name)!,
    referenceFiles: refs.length,
    examples: refs.slice(0, 2),
  }))
  .sort((a, b) => a.referenceFiles - b.referenceFiles || b.name.length - a.name.length);
const literals = [...literalSpread]
  .map(([text, refs]) => ({
    text,
    ours: ownLiterals.get(text)!,
    referenceFiles: refs.length,
    examples: refs.slice(0, 2),
  }))
  .sort((a, b) => b.text.length - a.text.length);

const candidates: (Finding & { message: string })[] = [
  ...code
    .filter((f) => f.tokens >= POLICY.codeRun)
    .map((f) => ({
      kind: 'code' as const,
      ours: f.ours.file,
      reference: f.reference.file,
      size: f.tokens,
      message: `代码结构连续相同 ${f.tokens} 词元：${where(f.ours)} ↔ ${where(f.reference)}`,
    })),
  ...pairs
    .filter((p) => p.tokens >= POLICY.pairMinTokens && p.share >= POLICY.pairShare)
    .map((p) => ({
      kind: 'pair' as const,
      ours: p.ours,
      reference: p.reference,
      size: p.share,
      message: `文件累计重合 ${percent(p.share)}：${p.ours} ↔ ${p.reference}`,
    })),
  ...prose
    .filter((f) => f.units >= POLICY.proseRun)
    .map((f) => ({
      kind: 'prose' as const,
      ours: f.ours.file,
      reference: f.reference.file,
      size: f.units,
      text: f.text,
      message: `相同文字 ${f.units} 单位：${f.ours.file}:${f.ours.line} ↔ ${f.reference.file}:${f.reference.line}`,
    })),
  ...style
    .filter((f) => f.declarations >= POLICY.styleRun)
    .map((f) => ({
      kind: 'style' as const,
      ours: f.ours.file,
      reference: f.reference.file,
      size: f.declarations,
      message: `连续相同 CSS 声明 ${f.declarations} 条：${where(f.ours)} ↔ ${where(f.reference)}`,
    })),
];
const exceptions: Exception[] = fs.existsSync(EXCEPTIONS)
  ? readExceptions(JSON.parse(fs.readFileSync(EXCEPTIONS, 'utf8')))
  : [];
const used = new Set<Exception>(),
  violations: string[] = [],
  excused: { finding: string; reason: string; reviewed: string }[] = [];
for (const candidate of candidates) {
  const exception = findException(exceptions, candidate);
  if (!exception) {
    violations.push(candidate.message);
    continue;
  }
  used.add(exception);
  excused.push({
    finding: candidate.message,
    reason: exception.reason,
    reviewed: exception.reviewed,
  });
}
const staleExceptions = exceptions.filter((e) => !used.has(e));
lap('analysis');

const ownTokens = ownScripts.reduce((n, s) => n + s.script!.shape.length, 0),
  coveredTokens = covered.reduce((n, bits) => n + count(bits), 0);
const bucket = (low: number, high = Infinity) =>
  code.filter((f) => f.tokens >= low && f.tokens < high).length;
const judged = pairs.filter((p) => p.tokens >= POLICY.pairMinTokens);
const report = {
  date: new Date().toISOString(),
  referenceAvailable: true,
  reference: {
    root: REFERENCE,
    head: snapshot.head,
    files: referenceFiles.length,
    scripts: refScripts.length,
    styles: refStyles.length,
    tokens: refScripts.reduce((n, r) => n + r.shape.length, 0),
  },
  ours: {
    files: own.length,
    scripts: ownScripts.length,
    styles: ownStyles.length,
    tokens: ownTokens,
  },
  options: { ...OPTIONS, listedRun: LISTED_RUN, variety: VARIETY },
  policy: POLICY,
  violations,
  excused,
  staleExceptions,
  summary: {
    code: {
      coveredTokens,
      coverage: round(coveredTokens / ownTokens),
      runs: { '120+': bucket(120), '80-119': bucket(80, 120), '50-79': bucket(50, 80) },
      repetitiveRuns: repetitive.length,
      longest: code[0]?.tokens ?? 0,
      highestPairShare: judged[0]?.share ?? 0,
    },
    prose: { fragments: prose.length, longestUnits: prose[0]?.units ?? 0 },
    style: { runs: style.length, longestDeclarations: style[0]?.declarations ?? 0 },
    names: { distinctive: distinctive.length, alsoInReference: names.length },
    classes: { ours: ownClasses.size, alsoInReference: classes.length },
    literals: { ours: ownLiterals.size, alsoInReference: literals.length },
  },
  seconds: phases,
  files,
  code,
  pairs: pairs.slice(0, 50),
  prose,
  style,
  names,
  classes,
  literals,
  limits:
    'Token-level comparison with one reference checkout. It finds copied, renamed or lightly edited code and wording; heavily restructured code can pass, and it is not a copyright determination.',
};
fs.mkdirSync('.artifacts', { recursive: true });
fs.writeFileSync(
  '.artifacts/similarity-report.json',
  JSON.stringify(report, (key, value) => (key === 'run' ? undefined : value), 2) + '\n',
);

const sources = new Map<string, string[]>();
function excerpt(root: string, place: Place, max = 40) {
  const key = root + '|' + place.file;
  let rows = sources.get(key);
  if (!rows)
    sources.set(key, (rows = fs.readFileSync(path.join(root, place.file), 'utf8').split(/\r?\n/)));
  const [from, to] = place.lines;
  const shown = rows.slice(from - 1, Math.min(to, from - 1 + max));
  return (
    '````' +
    (place.file.split('.').at(-1) ?? '') +
    '\n' +
    shown.join('\n') +
    (to - from + 1 > max ? '\n…' : '') +
    '\n````\n'
  );
}
const md: string[] = [
  '# 相似度报告',
  '',
  '> 仅供本机审阅：含参考仓库的代码片段。位于 `.artifacts/`（已被 git 忽略），不要提交或外传。',
  '',
  `生成于 ${report.date}。参考 \`${REFERENCE}\` @ \`${snapshot.head.slice(0, 12)}\`：${report.reference.files} 个文件、${report.reference.tokens} 个代码词元；本仓库 ${own.length} 个文件、${ownTokens} 个代码词元。`,
  '',
  '## 判定',
  '',
  `限值：单段代码结构连续相同 ≥ ${POLICY.codeRun} 词元；单个文件（≥ ${POLICY.pairMinTokens} 词元）与同一参考文件的累计重合 ≥ ${percent(POLICY.pairShare)}；相同文字 ≥ ${POLICY.proseRun} 单位；连续相同 CSS 声明 ≥ ${POLICY.styleRun} 条。`,
  '',
  violations.length
    ? `**未通过：${violations.length} 项。**\n\n${violations.map((v) => '- ' + v).join('\n')}`
    : '**通过：没有越过任何限值。**',
  '',
  `已审核例外（\`${EXCEPTIONS}\`，公共约定，不计为越线）：${excused.length} 项。`,
  ...excused.map((e) => `- ${e.finding} —— ${e.reason}（${e.reviewed} 审核）`),
  ...staleExceptions.map(
    (e) => `- 已不再命中，可删除：${e.kind} · ${e.ours}${e.reference ? ' ↔ ' + e.reference : ''}`,
  ),
  '',
  '## 总览',
  '',
  `- 代码：${coveredTokens} 个词元（${percent(report.summary.code.coverage)}）落在与参考结构相同、至少 ${LISTED_RUN} 个词元的连续片段里。`,
  `- 片段数：120 词元以上 ${bucket(120)}，80–119 ${bucket(80, 120)}，50–79 ${bucket(50, 80)}；另有 ${repetitive.length} 段数据型重复（列表 / 表格，不计入覆盖）。`,
  `- 文件对：与同一参考文件累计重合最高 ${percent(report.summary.code.highestPairShare)}（只计 ≥ ${POLICY.pairMinTokens} 词元的文件）。`,
  `- 文案：${prose.length} 段至少 ${OPTIONS.prose.min} 个单位的相同文字。`,
  `- CSS：${style.length} 段至少 ${OPTIONS.style.min} 项连续相同（含块结束标记）。`,
  `- 命名：我们 ${distinctive.length} 个非平台 / 库的名字中，${names.length} 个也出现在参考里；CSS 类名 / 变量 ${ownClasses.size} 个中 ${classes.length} 个相同。`,
  `- 字符串：我们 ${ownLiterals.size} 条（至少 3 个单位）中 ${literals.length} 条与参考完全相同。`,
  '',
  '## 各文件覆盖率',
  '',
  '| 文件 | 词元 | 覆盖 | 最长片段 | 主要对应 |',
  '|---|---|---|---|---|',
  ...files
    .filter((f) => f.covered)
    .map(
      (f) =>
        `| ${f.file} | ${f.tokens} | ${percent(f.coverage)} | ${f.longest} | ${f.references.map((r) => `${r.file} (${r.tokens})`).join('<br>')} |`,
    ),
  '',
  `## 文件对累计重合（前 25 对，≥ ${OPTIONS.code.min} 词元的片段）`,
  '',
  '| 我们 | 参考 | 我们的词元 | 重合 | 比例 | 片段数 |',
  '|---|---|---|---|---|---|',
  ...pairs
    .slice(0, 25)
    .map(
      (p) =>
        `| ${p.ours} | ${p.reference} | ${p.tokens} | ${p.covered} | ${percent(p.share)} | ${p.runs} |`,
    ),
  '',
  `## 代码结构重合（前 40 段，共 ${code.length} 段）`,
  '',
];
code.slice(0, 40).forEach((f, i) => {
  md.push(
    `### ${i + 1}. ${where(f.ours)} ↔ ${where(f.reference)}`,
    '',
    `${f.tokens} 个词元 · 名字 / 字面值相同 ${percent(f.identical)} · 种类 ${f.variety} · 种子见于 ${f.spread} 个参考文件 · 另有 ${f.alsoMatches} 处也相同`,
    '',
    '我们：',
    excerpt('.', f.ours),
    '参考：',
    excerpt(REFERENCE, f.reference),
  );
});
md.push(
  `## 相同文案（前 80 段，共 ${prose.length} 段）`,
  '',
  '| 单位 | 我们 | 参考 | 文字 |',
  '|---|---|---|---|',
  ...prose
    .slice(0, 80)
    .map(
      (f) =>
        `| ${f.units} | ${f.ours.file}:${f.ours.line} | ${f.reference.file}:${f.reference.line}${f.alsoMatches ? ` 等 ${f.alsoMatches + 1} 处` : ''} | ${cell(f.text)} |`,
    ),
  '',
  `## CSS 连续相同声明（前 20 段，共 ${style.length} 段）`,
  '',
);
style.slice(0, 20).forEach((f, i) => {
  md.push(
    `### ${i + 1}. ${where(f.ours)} ↔ ${where(f.reference)}（${f.declarations} 条声明）`,
    '',
    excerpt('.', f.ours),
    excerpt(REFERENCE, f.reference),
  );
});
md.push(
  `## 共同命名（最罕见的前 120 个，共 ${names.length} 个）`,
  '',
  '| 名字 | 参考中的文件数 | 我们的文件 | 参考示例 |',
  '|---|---|---|---|',
  ...names
    .slice(0, 120)
    .map(
      (n) =>
        `| \`${n.name}\` | ${n.referenceFiles} | ${n.ours.join('<br>')} | ${n.examples.join('<br>')} |`,
    ),
  '',
  `## 共同 CSS 类名 / 变量（共 ${classes.length} 个）`,
  '',
  '| 名字 | 参考中的文件数 | 参考示例 |',
  '|---|---|---|',
  ...classes.map((n) => `| \`${n.name}\` | ${n.referenceFiles} | ${n.examples.join('<br>')} |`),
  '',
  `## 完全相同的字符串（前 150 条，共 ${literals.length} 条）`,
  '',
  '| 文字 | 我们的文件 | 参考中的文件数 | 参考示例 |',
  '|---|---|---|---|',
  ...literals
    .slice(0, 150)
    .map(
      (l) =>
        `| ${cell(l.text)} | ${l.ours.join('<br>')} | ${l.referenceFiles} | ${l.examples.join('<br>')} |`,
    ),
  '',
);
fs.writeFileSync('.artifacts/similarity-report.md', md.join('\n'));
lap('total');
console.log(
  JSON.stringify(
    {
      reference: report.reference,
      ours: report.ours,
      policy: POLICY,
      violations,
      excused,
      staleExceptions,
      summary: report.summary,
      closestPairs: judged.slice(0, 3).map((p) => ({
        ours: p.ours,
        reference: p.reference,
        share: p.share,
      })),
      seconds: phases,
      reports: ['.artifacts/similarity-report.json', '.artifacts/similarity-report.md'],
    },
    null,
    2,
  ),
);
if (violations.length) process.exitCode = 1;
