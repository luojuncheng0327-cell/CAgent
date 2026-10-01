import React, { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Marks.tsx';

export function SetupMenu({
  label,
  value,
  items,
  searchLabel,
  emptyLabel,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  items: { id: string; label: string }[];
  searchLabel?: string;
  emptyLabel?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const choices = items.filter((item) =>
    item.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  function dismiss(restore = false) {
    setOpen(false);
    setQuery('');
    if (restore) trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) dismiss();
    };
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('focusin', closeOutside);
    const focus = searchLabel
      ? root.current?.querySelector<HTMLInputElement>('input')
      : (root.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ??
        root.current?.querySelector<HTMLButtonElement>('[role="option"]'));
    focus?.focus();
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('focusin', closeOutside);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) dismiss();
  }, [disabled]);
  return (
    <div
      className="first-run-menu"
      ref={root}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          dismiss(true);
          return;
        }
        if (event.key === 'Tab') {
          dismiss();
          return;
        }
        const buttons = [
          ...(root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []),
        ];
        if (!buttons.length) return;
        const inSearch = event.target instanceof HTMLInputElement;
        if (inSearch && !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        const position = buttons.indexOf(document.activeElement as HTMLButtonElement);
        let target: number | null = null;
        if (event.key === 'ArrowDown') target = (position + 1) % buttons.length;
        if (event.key === 'ArrowUp')
          target =
            position < 0 ? buttons.length - 1 : (position - 1 + buttons.length) % buttons.length;
        if (event.key === 'Home') target = 0;
        if (event.key === 'End') target = buttons.length - 1;
        if (target !== null) {
          event.preventDefault();
          buttons[target].focus();
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => (open ? dismiss() : setOpen(true))}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{items.find((item) => item.id === value)?.label ?? label}</span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className="first-run-popup">
          {searchLabel && (
            <input
              type="search"
              aria-label={searchLabel}
              placeholder={searchLabel}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          <div id={id} role="listbox" aria-label={label}>
            {choices.map((item) => (
              <button
                type="button"
                key={item.id}
                role="option"
                data-choice={item.id}
                aria-selected={value === item.id}
                onClick={() => {
                  onChange(item.id);
                  dismiss(true);
                }}
              >
                {item.label}
                {value === item.id && <Icon name="check" size={14} />}
              </button>
            ))}
            {!choices.length && emptyLabel && <p role="status">{emptyLabel}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
