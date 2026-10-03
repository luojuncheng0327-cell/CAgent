import translations from './ui-copy.json' with { type: 'json' };

export const locales = ['zh', 'zh-TW', 'en', 'ja', 'ko'] as const;
export type Locale = (typeof locales)[number];
export const copy: Record<string, readonly string[]> = translations;
export function normalizeLocale(value: unknown): Locale {
  return locales.includes(value as Locale) ? (value as Locale) : 'zh';
}
export function localeTag(value: unknown) {
  const locale = normalizeLocale(value);
  return locale === 'zh' ? 'zh-CN' : locale;
}
export function translate(locale: unknown, source: string, values: readonly unknown[] = []) {
  const selected = normalizeLocale(locale);
  const translated =
    selected === 'zh' ? source : (copy[source]?.[locales.indexOf(selected) - 1] ?? source);
  // Replace once: user-supplied strings containing braces never become new placeholders.
  return translated.replace(/\{(\d+)\}/g, (match, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : match,
  );
}
export function errorText(locale: unknown, code: string, message: string) {
  if (normalizeLocale(locale) === 'zh' || copy[message]) return translate(locale, message);
  return translate(locale, '请求失败（{0}），请检查配置后重试。', [code]) + '\n' + message;
}
