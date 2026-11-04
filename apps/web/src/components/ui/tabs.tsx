import { createContext, useContext, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { cn } from '../../lib/cn.js';

interface TabsContextValue {
  baseId: string;
  value: string;
  select: (value: string) => void;
  register: (value: string, element: HTMLButtonElement | null) => void;
  order: () => string[];
  focus: (value: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(): TabsContextValue {
  const context = useContext(TabsContext);
  if (!context) throw new Error('Tabs components must be rendered inside <Tabs>.');
  return context;
}

interface TabsProps {
  /** Controlled value. */
  value?: string;
  defaultValue: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  className?: string;
}

export function Tabs({
  value,
  defaultValue,
  onValueChange,
  children,
  className,
}: TabsProps): React.JSX.Element {
  const baseId = useId();
  const [internal, setInternal] = useState(defaultValue);
  const elements = useRef(new Map<string, HTMLButtonElement>());
  const current = value ?? internal;

  const context: TabsContextValue = {
    baseId,
    value: current,
    select: (next) => {
      if (value === undefined) setInternal(next);
      onValueChange?.(next);
    },
    register: (tab, element) => {
      if (element) elements.current.set(tab, element);
      else elements.current.delete(tab);
    },
    order: () => [...elements.current.keys()],
    focus: (tab) => elements.current.get(tab)?.focus(),
  };

  return (
    <TabsContext.Provider value={context}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabList({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        'flex items-center gap-1 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {children}
    </div>
  );
}

interface TabProps {
  value: string;
  children: ReactNode;
  /** Optional count shown beside the label. */
  count?: number;
}

export function Tab({ value, children, count }: TabProps): React.JSX.Element {
  const tabs = useTabs();
  const selected = tabs.value === value;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const order = tabs.order();
    const index = order.indexOf(value);
    let next: string | undefined;
    if (event.key === 'ArrowRight') next = order[(index + 1) % order.length];
    else if (event.key === 'ArrowLeft') next = order[(index - 1 + order.length) % order.length];
    else if (event.key === 'Home') next = order[0];
    else if (event.key === 'End') next = order[order.length - 1];
    if (next === undefined) return;
    event.preventDefault();
    tabs.select(next);
    tabs.focus(next);
  };

  return (
    <button
      ref={(element) => tabs.register(value, element)}
      type="button"
      role="tab"
      id={`${tabs.baseId}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${tabs.baseId}-panel-${value}`}
      tabIndex={selected ? 0 : -1}
      onClick={() => tabs.select(value)}
      onKeyDown={onKeyDown}
      className={cn(
        '-mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-sm font-medium whitespace-nowrap transition-colors duration-100 sm:gap-2 sm:px-3',
        selected
          ? 'border-accent text-fg'
          : 'border-transparent text-fg-subtle hover:border-border-strong hover:text-fg',
      )}
    >
      {children}
      {count !== undefined ? (
        <span
          className={cn(
            'tabular rounded-full px-1.5 text-2xs',
            selected ? 'bg-accent-soft text-accent-fg' : 'bg-surface-muted text-fg-subtle',
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

export function TabPanel({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}): React.JSX.Element | null {
  const tabs = useTabs();
  if (tabs.value !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`${tabs.baseId}-panel-${value}`}
      aria-labelledby={`${tabs.baseId}-tab-${value}`}
      tabIndex={0}
      className={className}
    >
      {children}
    </div>
  );
}
