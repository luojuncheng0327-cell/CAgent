import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Codebook,
  encodeProse,
  findException,
  prosePieces,
  readExceptions,
  scanScript,
  scanStyle,
  sharedRuns,
} from '../scripts/similarity.ts';

const options = { seed: 12, min: 40, common: 2 };
const reference = `
export function pickWinners(entries, limit) {
  const chosen = [];
  for (const entry of entries) {
    if (entry.score > limit && !entry.disabled) {
      chosen.push({ id: entry.id, score: entry.score * 2, labels: entry.labels.filter(Boolean) });
    } else if (entry.pinned) {
      chosen.unshift({ id: entry.id, score: 0, labels: [] });
    }
  }
  const ids = chosen.map((item) => item.id);
  return { ids, top: chosen.sort((a, b) => b.score - a.score).slice(0, limit) };
}
`;
// Same logic: every name changed, no semicolons, trailing commas, `let`, bare arrow parameter.
const renamed = `
export function selectTop(rows, cap) {
  let picked = []
  for (const row of rows) {
    if (row.rank > cap && !row.hidden) {
      picked.push({ key: row.key, rank: row.rank * 2, tags: row.tags.filter(Boolean), })
    } else if (row.sticky) {
      picked.unshift({ key: row.key, rank: 0, tags: [], })
    }
  }
  const keys = picked.map(x => x.key)
  return { keys, top: picked.sort((x, y) => y.rank - x.rank).slice(0, cap), }
}
`;
// Same behaviour, written another way.
const independent = `
export const selectTop = (rows, cap) => {
  const boosted = rows
    .filter((row) => row.rank > cap && !row.hidden)
    .map((row) => ({ key: row.key, rank: row.rank * 2, tags: row.tags.filter(Boolean) }));
  const sticky = rows
    .filter((row) => row.sticky && !(row.rank > cap && !row.hidden))
    .map((row) => ({ key: row.key, rank: 0, tags: [] }));
  const top = [...sticky.reverse(), ...boosted].sort((x, y) => y.rank - x.rank).slice(0, cap);
  return { keys: [...sticky, ...boosted].map((row) => row.key), top };
};
`;

test('CA-SHIP-001 相似度：改名、去分号、尾逗号和箭头括号不同的照抄仍整段识别', () => {
  const book = new Codebook();
  const theirs = scanScript('reference.js', reference, book),
    ours = scanScript('ours.js', renamed, book);
  assert.deepEqual([...ours.shape], [...theirs.shape]);
  const runs = sharedRuns([ours.shape], [theirs.shape], options);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].length, ours.shape.length);
  let named = 0,
    identical = 0;
  ours.exact.forEach((value, i) => {
    if (!value) return;
    named++;
    if (value === theirs.exact[i]) identical++;
  });
  assert.ok(identical / named < 0.5, 'names differ, so the match must come from structure');
});

test('CA-SHIP-001 相似度：同一行为的独立写法不被判为照抄', () => {
  const book = new Codebook();
  const theirs = scanScript('reference.js', reference, book),
    ours = scanScript('ours.js', independent, book);
  assert.deepEqual(sharedRuns([ours.shape], [theirs.shape], options), []);
});

test('CA-SHIP-001 相似度：参考里多处出现的写法视为惯用法，不作为起点', () => {
  const book = new Codebook();
  const theirs = [1, 2, 3].map((n) => scanScript(`reference${n}.js`, reference, book).shape);
  const ours = scanScript('ours.js', renamed, book).shape;
  assert.equal(sharedRuns([ours], theirs, { ...options, common: 2 }).length, 0);
  assert.equal(sharedRuns([ours], theirs, { ...options, common: 3 }).length, 3);
});

test('CA-SHIP-001 相似度：导入语句不计入结构，注释计入文案', () => {
  const book = new Codebook();
  const withImport = scanScript(
    'a.ts',
    "import { readFile } from 'node:fs';\n// 读取配置文件并返回解析结果\nexport const load = (p: string) => readFile(p);",
    book,
  );
  const bare = scanScript('b.ts', 'export const load = (p: string) => readFile(p)', book);
  assert.deepEqual([...withImport.shape], [...bare.shape]);
  assert.deepEqual(
    withImport.pieces.map((p) => [p.kind, p.text.trim(), p.line]),
    [['comment', '读取配置文件并返回解析结果', 2]],
  );
});

test('CA-SHIP-001 相似度：不同文件格式里的同一句文案被识别，且不跨越文本边界', () => {
  const book = new Codebook();
  const ours = encodeProse(
    scanScript(
      'Notice.tsx',
      "export const Notice = () => <p>请先在设置里选择一个支持图片的模型，再发送图片。</p>;\nconst a = 'alpha beta gamma delta';\nconst b = 'epsilon zeta eta theta';",
      book,
    ).pieces,
    book,
    true,
  );
  const theirs = encodeProse(
    prosePieces(
      'zh.json',
      '{\n  "notice": "请先在设置里选择一个支持图片的模型，再发送图片。",\n  "list": "alpha beta gamma delta epsilon zeta eta theta"\n}',
    ),
    book,
  );
  const runs = sharedRuns([ours.codes], [theirs.codes], { seed: 4, min: 6, common: 5 });
  assert.equal(runs.length, 1);
  assert.equal(
    ours.units.slice(runs[0].ourStart, runs[0].ourStart + runs[0].length).join(''),
    '请先在设置里选择一个支持图片的模型再发送图片',
  );
  assert.equal(theirs.lines[runs[0].theirStart], 2);
});

test('CA-SHIP-001 相似度：重新排版的 CSS 声明序列被识别，调换顺序后不算', () => {
  const book = new Codebook();
  const theirs = scanStyle(
    '.panel { display: flex; gap: 8px; padding: 0.5rem 1rem; color: #333; border-radius: 12px; background: rgba(0, 0, 0, 0.04); }',
    book,
  );
  const reformatted = scanStyle(
    '/* ours */\n.box{\n  DISPLAY:flex;gap:8px;\n  padding:.5rem   1rem;color:#333;border-radius:12px;\n  background:rgba(0,0,0,.04)\n}\n',
    book,
  );
  const reordered = scanStyle(
    '.box { gap: 8px; display: flex; color: #333; padding: 0.5rem 1rem; background: rgba(0, 0, 0, 0.04); border-radius: 12px; }',
    book,
  );
  const styleOptions = { seed: 3, min: 6, common: 5 };
  const runs = sharedRuns([reformatted.codes], [theirs.codes], styleOptions);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].length, 7, 'six declarations and the end of the block');
  assert.equal(reformatted.lines[0], 3);
  assert.deepEqual([...reformatted.classes], ['box']);
  assert.deepEqual(sharedRuns([reordered.codes], [theirs.codes], styleOptions), []);
});

test('CA-SHIP-001 相似度：已审核例外只放行同一文件、同一类别且不超过审核尺寸的公共约定', () => {
  const list = readExceptions({
    exceptions: [
      {
        kind: 'prose',
        ours: 'scripts/a.mjs',
        contains: 'mozilla 5 0',
        max: 20,
        reason: '标准浏览器标识',
        reviewed: '2026-09-27',
      },
      {
        kind: 'pair',
        ours: 'src/c.ts',
        reference: 'r.ts',
        max: 0.5,
        reason: '协议规定的字段',
        reviewed: '2026-09-27',
      },
    ],
  });
  const prose = {
    kind: 'prose' as const,
    ours: 'scripts/a.mjs',
    reference: 'x.cjs',
    size: 16,
    text: 'mozilla 5 0 windows nt',
  };
  assert.equal(findException(list, prose)?.reason, '标准浏览器标识');
  assert.equal(findException(list, { ...prose, size: 21 }), undefined, 'grew beyond the review');
  assert.equal(findException(list, { ...prose, ours: 'src/b.ts' }), undefined, 'another file');
  assert.equal(findException(list, { ...prose, kind: 'code' }), undefined, 'another kind');
  assert.equal(findException(list, { ...prose, text: '其他文字' }), undefined, 'other wording');
  const pair = { kind: 'pair' as const, ours: 'src/c.ts', reference: 'r.ts', size: 0.45 };
  assert.equal(findException(list, pair)?.reason, '协议规定的字段');
  assert.equal(findException(list, { ...pair, reference: 'other.ts' }), undefined);
  assert.throws(
    () =>
      readExceptions({
        exceptions: [{ kind: 'prose', ours: 'a', max: 5, reviewed: '2026-09-27' }],
      }),
    /reason/,
  );
  assert.throws(() => readExceptions({ exceptions: [{ kind: 'guess', ours: 'a' }] }), /kind/);
});
