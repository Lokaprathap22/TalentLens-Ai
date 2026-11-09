import { Menu, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';

import { Icon, IconButton } from '../components/ui/index.js';
import { AccountMenu } from './AccountMenu.js';

interface TopBarProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenMobileNav: () => void;
  onOpenSearch: () => void;
  shortcutLabel: string;
}

export function TopBar({
  sidebarCollapsed,
  onToggleSidebar,
  onOpenMobileNav,
  onOpenSearch,
  shortcutLabel,
}: TopBarProps): React.JSX.Element {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 sm:px-4 lg:px-6">
      <IconButton
        icon={Menu}
        label="Open navigation"
        className="lg:hidden"
        onClick={onOpenMobileNav}
      />
      <IconButton
        icon={sidebarCollapsed ? PanelLeftOpen : PanelLeftClose}
        label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!sidebarCollapsed}
        className="hidden lg:inline-flex"
        onClick={onToggleSidebar}
      />

      <button
        type="button"
        onClick={onOpenSearch}
        aria-keyshortcuts="Control+K Meta+K"
        className="ml-1 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border-strong bg-surface-muted/60 px-2.5 text-left text-sm text-fg-subtle transition-colors duration-150 hover:border-fg-disabled hover:bg-surface sm:max-w-md sm:flex-none sm:basis-96"
      >
        <Icon icon={Search} size="md" />
        <span className="flex-1 truncate">Search…</span>
        <kbd className="hidden h-5 items-center rounded-xs border border-border bg-surface px-1.5 font-sans text-2xs text-fg-subtle sm:flex">
          {shortcutLabel}
        </kbd>
      </button>

      <div className="ml-auto">
        <AccountMenu />
      </div>
    </header>
  );
}
