import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router';

import { cn } from '../lib/cn.js';
import { MobileNav } from './MobileNav.js';
import { SearchDialog } from './SearchDialog.js';
import { Sidebar } from './Sidebar.js';
import { TopBar } from './TopBar.js';
import { useSidebarCollapsed } from './use-sidebar-collapsed.js';

const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function AppShell(): React.JSX.Element {
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const main = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const firstRender = useRef(true);

  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  // Global search shortcut.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Move focus to the page after client-side navigation so keyboard and screen-reader
  // users land on the new content.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    main.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only z-[80] rounded-md bg-surface px-3 py-2 text-sm font-medium shadow-md focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to main content
      </a>

      <aside
        aria-label="Sidebar"
        className={cn(
          'sticky top-0 hidden h-dvh shrink-0 transition-[width] duration-200 ease-standard lg:block',
          collapsed ? 'w-[4.25rem]' : 'w-60',
        )}
      >
        <Sidebar collapsed={collapsed} />
      </aside>

      <MobileNav open={mobileNavOpen} onClose={closeMobileNav} />
      <SearchDialog open={searchOpen} onClose={closeSearch} />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          sidebarCollapsed={collapsed}
          onToggleSidebar={toggleCollapsed}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
          shortcutLabel={isApple ? '⌘K' : 'Ctrl K'}
        />
        <main
          id="main"
          ref={main}
          tabIndex={-1}
          className="mx-auto w-full max-w-[90rem] flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
