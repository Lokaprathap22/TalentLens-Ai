import type { LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { cn } from '../../lib/cn.js';
import { Icon } from './icon.js';

export type MenuEntry =
  | {
      type: 'item';
      label: string;
      icon?: LucideIcon;
      onSelect?: () => void;
      /** Disabled items stay focusable so users can discover why they are unavailable. */
      disabled?: boolean;
      hint?: string;
    }
  | { type: 'separator' }
  | { type: 'label'; label: string };

interface DropdownMenuProps {
  /** Accessible name of the menu and its trigger. */
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  entries: MenuEntry[];
  /** Optional non-interactive content shown above the items (e.g. account identity). */
  header?: ReactNode;
  align?: 'start' | 'end';
  width?: string;
}

export function DropdownMenu({
  label,
  trigger,
  triggerClassName,
  entries,
  header,
  align = 'end',
  width = 'w-64',
}: DropdownMenuProps): React.JSX.Element {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const items = (): HTMLElement[] =>
    Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const close = (restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const focusItem = (which: 'first' | 'last' | number): void => {
    // Wait for the menu to mount before moving focus.
    requestAnimationFrame(() => {
      const list = items();
      const target =
        which === 'first' ? list[0] : which === 'last' ? list[list.length - 1] : list[which];
      target?.focus();
    });
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      focusItem(event.key === 'ArrowDown' ? 'first' : 'last');
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      list[(index + 1) % list.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      list[(index - 1 + list.length) % list.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      list[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      list[list.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(event) => {
          const opening = !open;
          setOpen(opening);
          // Keyboard activation (detail === 0) moves focus into the menu.
          if (opening && event.detail === 0) focusItem('first');
        }}
        onKeyDown={onTriggerKeyDown}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open ? (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className={cn(
            'absolute z-50 mt-1.5 animate-pop-in rounded-lg border border-border bg-surface py-1 shadow-md',
            width,
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {header ? <div className="border-b border-border px-3 py-2.5">{header}</div> : null}
          <div className="py-1">
            {entries.map((entry, index) => {
              if (entry.type === 'separator') {
                return <div key={index} role="separator" className="my-1 h-px bg-border" />;
              }
              if (entry.type === 'label') {
                return (
                  <div
                    key={index}
                    className="px-3 pt-2 pb-1 text-2xs font-semibold tracking-wider text-fg-subtle uppercase"
                  >
                    {entry.label}
                  </div>
                );
              }
              return (
                <div
                  key={index}
                  role="menuitem"
                  tabIndex={-1}
                  aria-disabled={entry.disabled || undefined}
                  onClick={() => {
                    if (entry.disabled) return;
                    entry.onSelect?.();
                    close(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.currentTarget.click();
                    }
                  }}
                  className={cn(
                    'mx-1 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm outline-offset-0',
                    entry.disabled
                      ? 'cursor-not-allowed text-fg-disabled'
                      : 'cursor-pointer text-fg hover:bg-surface-muted focus:bg-surface-muted',
                  )}
                >
                  {entry.icon ? (
                    <Icon icon={entry.icon} size="md" className="shrink-0 text-fg-subtle" />
                  ) : null}
                  <span className="flex-1 truncate">{entry.label}</span>
                  {entry.hint ? (
                    <span className="text-2xs text-fg-subtle">{entry.hint}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
