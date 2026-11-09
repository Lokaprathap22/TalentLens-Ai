import { X } from 'lucide-react';
import { NavLink } from 'react-router';

import { recruiterNavigation, UNAVAILABLE_REASON } from '../app/navigation.js';
import type { NavItem } from '../app/navigation.js';
import { useWorkspace } from '../app/workspace.js';
import { LogoMark, Wordmark } from '../components/brand.js';
import { Icon, Tooltip } from '../components/ui/index.js';
import { cn } from '../lib/cn.js';

interface SidebarProps {
  collapsed?: boolean;
  /** Called after a link is chosen, so the mobile drawer can close itself. */
  onNavigate?: () => void;
  /** When provided (mobile drawer), shows a close button in the header. */
  onClose?: () => void;
}

const itemBase =
  'group relative flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-sm font-medium transition-colors duration-150 outline-offset-0 focus-visible:outline-sidebar-indicator';

function NavEntry({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
}): React.JSX.Element {
  const base = cn(itemBase, collapsed && 'justify-center px-0');
  const label = (
    <>
      <Icon icon={item.icon} size="lg" />
      <span className={cn('flex-1 truncate text-left', collapsed && 'sr-only')}>{item.label}</span>
    </>
  );

  if (item.available) {
    const link = (
      <NavLink
        to={item.to}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            base,
            isActive
              ? 'bg-sidebar-active text-sidebar-fg-strong'
              : 'text-sidebar-fg hover:bg-sidebar-hover hover:text-sidebar-fg-strong',
          )
        }
      >
        {({ isActive }) => (
          <>
            {isActive ? (
              <span
                aria-hidden="true"
                className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-sidebar-indicator"
              />
            ) : null}
            {label}
          </>
        )}
      </NavLink>
    );
    return collapsed ? (
      <Tooltip content={item.label} side="right">
        {link}
      </Tooltip>
    ) : (
      link
    );
  }

  const unavailable = (
    <button
      type="button"
      aria-disabled="true"
      onClick={(event) => event.preventDefault()}
      className={cn(base, 'cursor-not-allowed text-sidebar-muted/80')}
    >
      {label}
      {!collapsed ? (
        <span className="rounded-xs border border-sidebar-border px-1 text-2xs font-medium text-sidebar-muted">
          Soon
        </span>
      ) : null}
      <span className="sr-only">(not available yet)</span>
    </button>
  );
  return (
    <Tooltip content={`${item.label}: ${UNAVAILABLE_REASON}`} side="right">
      {unavailable}
    </Tooltip>
  );
}

export function Sidebar({
  collapsed = false,
  onNavigate,
  onClose,
}: SidebarProps): React.JSX.Element {
  const { organization, isSample } = useWorkspace();

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-fg">
      <div
        className={cn(
          'flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border',
          collapsed ? 'justify-center px-0' : 'px-4',
        )}
      >
        <LogoMark />
        {!collapsed ? <Wordmark className="text-sidebar-fg-strong" /> : null}
        {onClose ? (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={onClose}
            className="ml-auto flex size-8 items-center justify-center rounded-md text-sidebar-fg hover:bg-sidebar-hover hover:text-sidebar-fg-strong focus-visible:outline-sidebar-indicator"
          >
            <Icon icon={X} size="lg" />
          </button>
        ) : null}
      </div>

      <div className={cn('px-3 pt-3', collapsed && 'px-2')}>
        <div
          className={cn(
            'flex items-center gap-2.5 rounded-lg border border-sidebar-border bg-sidebar-hover/60 p-2',
            collapsed && 'justify-center border-transparent bg-transparent p-0',
          )}
        >
          <span
            role="img"
            aria-label={`Workspace: ${organization.name}`}
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-active text-xs font-semibold text-sidebar-fg-strong"
          >
            {organization.name.slice(0, 2).toUpperCase()}
          </span>
          {!collapsed ? (
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-sidebar-fg-strong">
                {organization.name}
              </p>
              <p className="truncate text-2xs text-sidebar-muted">
                Recruiter workspace{isSample ? ' · sample' : ''}
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <nav aria-label="Primary" className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {recruiterNavigation.map((section, index) => (
          <div key={section.id} className={cn(index > 0 && 'mt-5')}>
            {collapsed ? (
              index > 0 ? (
                <div aria-hidden="true" className="mx-2 mb-3 h-px bg-sidebar-border" />
              ) : null
            ) : (
              <h2 className="px-2.5 pb-1.5 text-2xs font-semibold tracking-wider text-sidebar-muted uppercase">
                {section.label}
              </h2>
            )}
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <li key={item.id}>
                  <NavEntry item={item} collapsed={collapsed} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}
