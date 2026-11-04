import type { LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '../../lib/cn.js';
import { Icon } from './icon.js';

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  icon: LucideIcon;
  /** Required: icon-only controls need an accessible name. */
  label: string;
  size?: 'sm' | 'md';
}

const sizes = { sm: 'size-7', md: 'size-8' } as const;

export function IconButton({
  icon,
  label,
  size = 'md',
  type = 'button',
  className,
  ...rest
}: IconButtonProps): React.JSX.Element {
  const hasCustomDisplay = className ? /\bhidden\b/.test(className) : false;

  return (
    <button
      type={type}
      aria-label={label}
      title={rest['aria-haspopup'] ? undefined : label}
      className={cn(
        !hasCustomDisplay && 'inline-flex',
        'shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors duration-100 hover:bg-surface-muted hover:text-fg active:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50',
        sizes[size],
        className,
      )}
      {...rest}
    >
      <Icon icon={icon} size="md" />
    </button>
  );
}
