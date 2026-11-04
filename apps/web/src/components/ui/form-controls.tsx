import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '../../lib/cn.js';
import { Icon } from './icon.js';

const control =
  'w-full rounded-md border bg-surface text-base text-fg shadow-xs placeholder:text-fg-subtle transition-colors duration-100 hover:border-fg-disabled disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-fg-disabled aria-invalid:border-danger-solid';

const controlBorder = 'border-border-strong';

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  /** Visually hide the label while keeping it for assistive technology. */
  hideLabel?: boolean;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** Label + control + hint/error wiring so every form control is labelled and described. */
export function Field({ label, hint, error, hideLabel, children }: FieldProps): React.JSX.Element {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={cn('text-sm font-medium text-fg', hideLabel && 'sr-only')}>
        {label}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error ? (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-fg-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className, ...rest }: InputProps): React.JSX.Element {
  return <input className={cn(control, controlBorder, 'h-8 px-2.5', className)} {...rest} />;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  children: ReactNode;
}

/** Native select (best accessibility and mobile behaviour) with the shared control skin. */
export function Select({ className, children, ...rest }: SelectProps): React.JSX.Element {
  return (
    <div className="relative">
      <select
        className={cn(control, controlBorder, 'h-8 appearance-none py-0 pr-8 pl-2.5', className)}
        {...rest}
      >
        {children}
      </select>
      <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-fg-subtle">
        <Icon icon={ChevronDown} size="sm" />
      </span>
    </div>
  );
}
