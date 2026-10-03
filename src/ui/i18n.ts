import { useSyncExternalStore } from 'react';
import { normalizeLocale, localeTag, translate, errorText } from '../shared/i18n.ts';

// One renderer has one saved interface language. Subscriptions update existing components
// without remounting editors, clearing drafts, or changing user/model text.
let current = normalizeLocale('zh');
const listeners = new Set<() => void>();
const subscribe = (callback: () => void) => {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
};
export function setLanguage(value: unknown) {
  const next = normalizeLocale(value);
  if (typeof document !== 'undefined') document.documentElement.lang = localeTag(next);
  if (current === next) return;
  current = next;
  for (const listener of listeners) listener();
}
export const useLocale = () => useSyncExternalStore(subscribe, () => current);
export const currentLocaleTag = () => localeTag(current);
export const t = (source: string, values?: readonly unknown[]) =>
  translate(current, source, values);
export const localError = (code: string, message: string) => errorText(current, code, message);
