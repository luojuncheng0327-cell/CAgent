import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Marks.tsx';
import './choices.css';

export interface Choice {
  id: string;
  label: string;
  hint?: string;
  icon?: string;
  group?: string;
  disabled?: boolean;
}

// Each menu owns its focus and viewport placement, independently of the composer layout.
export function ChoiceMenu({
  label,
  value,
  items,
  icon,
  compact = false,
  disabled = false,
  align = 'end',
  onChange,
}: {
  label: string;
  value: string;
  items: Choice[];
  icon: string;
  compact?: boolean;
  disabled?: boolean;
  align?: 'start' | 'end';
  onChange: (id: string) => void;
}) {
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({ left: 0, top: 0, ready: false });
  const selected = items.find((item) => item.id === value);
  const enabled = () => [
    ...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
  ];
  function dismiss(restore: boolean) {
    setOpen(false);
    if (restore) anchor.current?.focus();
  }
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !panel.current) return;
    const position = () => {
      const trigger = anchor.current!.getBoundingClientRect();
      const menu = panel.current!.getBoundingClientRect();
      const x = align === 'end' ? trigger.right - menu.width : trigger.left;
      const above = trigger.top - menu.height - 4;
      const y = above >= 8 ? above : trigger.bottom + 4;
      setPlacement({
        left: Math.max(8, Math.min(x, innerWidth - menu.width - 8)),
        top: Math.max(8, Math.min(y, innerHeight - menu.height - 8)),
        ready: true,
      });
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(panel.current);
    window.addEventListener('resize', position);
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) dismiss(false);
    };
    const focusLeft = (event: FocusEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) dismiss(false);
    };
    const scrolled = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) dismiss(false);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', focusLeft);
    document.addEventListener('scroll', scrolled, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', focusLeft);
      document.removeEventListener('scroll', scrolled, true);
    };
  }, [open, align]);
  useLayoutEffect(() => {
    if (open && placement.ready) {
      const first =
        panel.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? enabled()[0];
      first?.focus({ preventScroll: true });
    }
  }, [open, placement.ready]);
  function toggle() {
    setPlacement((previous) => ({ ...previous, ready: false }));
    setOpen((previous) => !previous);
  }
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={compact ? 'choice-trigger choice-icon' : 'choice-trigger choice-model'}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={`${label}：${selected?.label ?? '未选择'}`}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            if (!open) toggle();
          }
          if (event.key === 'Escape') dismiss(false);
        }}
      >
        <Icon name={icon} size={compact ? 15 : 14} />
        {!compact && <span>{selected?.label ?? '选择模型'}</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="listbox"
            aria-label={label}
            className={'choice-popup' + (align === 'start' ? ' choice-permissions' : '')}
            style={{
              left: placement.left,
              top: placement.top,
              visibility: placement.ready ? 'visible' : 'hidden',
            }}
            onKeyDown={(event) => {
              const controls = enabled();
              const index = controls.indexOf(document.activeElement as HTMLButtonElement);
              let next: number | undefined;
              if (event.key === 'ArrowDown') next = (index + 1) % controls.length;
              if (event.key === 'ArrowUp') next = (index - 1 + controls.length) % controls.length;
              if (event.key === 'Home') next = 0;
              if (event.key === 'End') next = controls.length - 1;
              if (next !== undefined) {
                event.preventDefault();
                controls[next]?.focus();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                dismiss(true);
              }
              if (event.key === 'Tab') {
                event.preventDefault();
                const focusable = [
                  ...document.querySelectorAll<HTMLElement>(
                    'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,a[href],[tabindex="0"]',
                  ),
                ].filter(
                  (element) =>
                    !panel.current?.contains(element) &&
                    element.getClientRects().length &&
                    getComputedStyle(element).visibility !== 'hidden',
                );
                const start = focusable.indexOf(anchor.current!);
                dismiss(false);
                (focusable[start + (event.shiftKey ? -1 : 1)] ?? anchor.current)?.focus();
              }
            }}
          >
            {items.map((item, index) => (
              <React.Fragment key={item.id}>
                {item.group && item.group !== items[index - 1]?.group && (
                  <div className="choice-group">
                    <Icon name="model" size={12} />
                    {item.group}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={item.id === value}
                  aria-label={item.disabled ? `${item.label} · 即将提供` : item.label}
                  disabled={item.disabled}
                  tabIndex={-1}
                  className={item.group ? 'choice-row grouped' : 'choice-row'}
                  title={item.hint}
                  onClick={() => {
                    dismiss(true);
                    if (item.id !== value) onChange(item.id);
                  }}
                >
                  {item.icon && <Icon name={item.icon} size={14} />}
                  <span>{item.label}</span>
                  {item.disabled ? (
                    <small>即将提供</small>
                  ) : (
                    item.hint && <small>{item.hint}</small>
                  )}
                </button>
              </React.Fragment>
            ))}
            {!items.length && (
              <p className="choice-empty">还没有可用模型，请在供应商设置中添加。</p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
