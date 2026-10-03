import test from 'node:test';
import assert from 'node:assert/strict';
import { translate, normalizeLocale, localeTag, copy, errorText } from '../src/shared/i18n.ts';
import fs from 'node:fs/promises';
import ts from 'typescript';
import { setup } from './helpers.ts';

test('P2 五语文本完整，插值保留参数且不解析参数内的占位符', () => {
  assert.equal(translate('en', '保存资料'), 'Save profile');
  assert.equal(translate('ja', '保存资料'), 'プロフィールを保存');
  assert.equal(translate('ko', '保存资料'), '프로필 저장');
  assert.equal(translate('zh-TW', '保存资料'), '儲存資料');
  assert.equal(translate('en', '撤销'), 'Undo');
  assert.equal(translate('en', '撤销授权'), 'Revoke access');
  assert.equal(translate('en', '移除附件 {0}', ['用户原文 {1}']), 'Remove attachment 用户原文 {1}');
  for (const [source, translations] of Object.entries(copy)) {
    assert.equal(translations.length, 4, source);
    const placeholders = (s: string) => [...s.matchAll(/\{\d+\}/g)].map((x) => x[0]).sort();
    for (const value of translations) {
      assert.ok(value.trim().length > 0, source);
      assert.deepEqual(placeholders(value), placeholders(source), source);
    }
  }
  assert.equal(translate('en', '用户的私人内容'), '用户的私人内容');
  assert.equal(translate('en', '移除附件 {0}'), 'Remove attachment {0}');
  assert.match(
    errorText('en', 'VERSION_CONFLICT', '内容已变化，请刷新后再保存'),
    /^Content changed/,
  );
  assert.match(
    errorText('en', 'UPSTREAM_ERROR', 'remote diagnostic'),
    /UPSTREAM_ERROR.*\nremote diagnostic/,
  );
  assert.equal(errorText('zh', 'UPSTREAM_ERROR', '上游信息'), '上游信息');
});

test('P2 每个界面翻译调用均有四语词条，防止静默遗漏新按钮', async () => {
  const root = new URL('../src/ui/', import.meta.url);
  for (const name of (await fs.readdir(root)).filter((name) => name.endsWith('.tsx'))) {
    const source = await fs.readFile(new URL(name, root), 'utf8');
    const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 't' &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        assert.ok(copy[node.arguments[0].text], name + ': ' + node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
});

test('P2 未知语言回退中文，持久化旧设置可读取而非法设置请求不接受', async () => {
  assert.equal(normalizeLocale('unknown'), 'zh');
  assert.equal(normalizeLocale(null), 'zh');
  assert.equal(translate('unknown', '保存资料'), '保存资料');
  const f = await setup('http://127.0.0.1:9/v1');
  try {
    f.rt.store.put('preferences', 'global', { ...f.rt.preferences(), locale: 'old-language' });
    assert.equal(f.rt.preferences().locale, 'zh');
    assert.throws(() => f.rt.savePreferences({ ...f.rt.preferences(), locale: 'invalid' }));
    for (const locale of ['zh', 'zh-TW', 'en', 'ja', 'ko']) {
      f.rt.savePreferences({ ...f.rt.preferences(), locale });
      assert.equal(f.rt.preferences().locale, locale);
      const created = await f.rt.createSession({ agentId: f.agent.id });
      assert.equal(created.title, translate(locale, '新会话'));
      assert.equal(f.rt.store.need<any>('session', f.session.id).title, '测试会话');
    }
  } finally {
    await f.cleanup();
  }
});

test('P2 各语言的日期按指定时区跨日显示，不修改原 UTC 值', () => {
  const instant = '2026-10-03T00:30:00.000Z';
  for (const locale of ['zh', 'zh-TW', 'en', 'ja', 'ko']) {
    const parts = (timezone: string) =>
      new Intl.DateTimeFormat(localeTag(locale), {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(instant));
    assert.equal(parts('Asia/Shanghai').find((p) => p.type === 'day')?.value, '03');
    assert.equal(parts('America/Los_Angeles').find((p) => p.type === 'day')?.value, '02');
    assert.equal(new Date(instant).toISOString(), instant);
  }
});
