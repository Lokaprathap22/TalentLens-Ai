import { Search, X } from 'lucide-react';
import { useRef } from 'react';
import type { InputHTMLAttributes } from 'react';

import { cn } from '../../lib/cn.js';
import { Icon } from './icon.js';

interface SearchFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'onChange' | 'size'
> {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name; the field has no visible label. */
  label: string;
  /** Optional trailing hint, e.g. a keyboard shortcut. */
  shortcutHint?: string;
}

export function SearchField({
  value,
  onValueChange,
  label,
  shortcutHint,
  className,
  ...rest
}: SearchFieldProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div role="search" className={cn('relative', className)}>
      <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-fg-subtle">
        <Icon icon={Search} size="md" />
      </span>
      <input
        ref={inputRef}
        type="search"
        aria-label={label}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.stopPropagation();
            onValueChange('');
          }
        }}
        className="h-8 w-full appearance-none rounded-md border border-border-strong bg-surface pr-8 pl-8 text-base text-fg shadow-xs placeholder:text-fg-subtle hover:border-fg-disabled [&::-webkit-search-cancel-button]:hidden"
        {...rest}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onValueChange('');
            inputRef.current?.focus();
          }}
          className="absolute inset-y-0 right-1.5 my-auto flex size-5 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-sunken hover:text-fg"
        >
          <Icon icon={X} size="sm" />
        </button>
      ) : shortcutHint ? (
        <kbd className="pointer-events-none absolute inset-y-0 right-2 my-auto hidden h-5 items-center rounded-xs border border-border bg-surface-muted px-1.5 font-sans text-2xs text-fg-subtle sm:flex">
          {shortcutHint}
        </kbd>
      ) : null}
    </div>
  );
}
