import { cn } from '../lib/cn.js';

/** TalentLens mark: a lens ring with a focused evidence point. */
export function LogoMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      className={cn('size-8 shrink-0', className)}
    >
      <rect width="32" height="32" rx="8" fill="var(--color-accent)" />
      <circle cx="15" cy="15" r="7" fill="none" stroke="#fff" strokeWidth="2.25" />
      <circle cx="15" cy="15" r="2.25" fill="var(--color-sidebar-indicator)" />
      <path d="M20.5 20.5 25 25" stroke="#fff" strokeWidth="2.25" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span className={cn('text-lg font-semibold tracking-tight', className)}>
      TalentLens<span className="text-sidebar-indicator"> AI</span>
    </span>
  );
}
