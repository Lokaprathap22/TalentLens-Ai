import type { LucideIcon } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '../../lib/cn.js';
import { Icon } from './icon.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const base =
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-on-accent shadow-xs hover:bg-accent-hover active:bg-accent-active disabled:hover:bg-accent',
  secondary:
    'border border-border-strong bg-surface text-fg shadow-xs hover:bg-surface-muted hover:border-fg-disabled active:bg-surface-sunken disabled:hover:bg-surface disabled:hover:border-border-strong',
  ghost: 'text-fg-muted hover:bg-surface-muted hover:text-fg active:bg-surface-sunken',
  danger: 'bg-danger text-on-accent shadow-xs hover:brightness-95 active:brightness-90',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-sm',
  md: 'h-8 px-3 text-sm',
  lg: 'h-10 px-4 text-base',
};

/** Shared class recipe so links can look exactly like buttons. */
export function buttonStyles(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
): string {
  return cn(base, variants[variant], sizes[size]);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconEnd?: LucideIcon;
  loading?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconEnd,
  loading = false,
  type = 'button',
  className,
  disabled,
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      className={cn(buttonStyles(variant, size), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Icon icon={Loader2} size="sm" className="shrink-0 animate-spin" />
      ) : icon ? (
        <Icon icon={icon} size="sm" />
      ) : null}
      {children}
      {iconEnd && !loading ? <Icon icon={iconEnd} size="sm" /> : null}
    </button>
  );
}
