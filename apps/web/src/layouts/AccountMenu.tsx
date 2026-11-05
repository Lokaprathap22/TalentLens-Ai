import { AlertCircle, ChevronDown, LogOut, Palette, Settings, X } from 'lucide-react';
import { useNavigate } from 'react-router';

import { useAuthOptional } from '../app/auth.js';
import { useWorkspace } from '../app/workspace.js';
import { Avatar, Button, DropdownMenu, Icon } from '../components/ui/index.js';
import type { MenuEntry } from '../components/ui/index.js';

export function AccountMenu(): React.JSX.Element {
  const { user, organization, isSample } = useWorkspace();
  const auth = useAuthOptional();
  const navigate = useNavigate();

  const isLoggingOut = auth?.isLoggingOut ?? false;
  const logoutError = auth?.logoutError ?? null;
  const canSignOut = Boolean(auth && !isSample);

  const accountLabel = user.email || user.name;
  const showDistinctDisplayName = Boolean(user.name && user.email && user.name !== user.email);

  const handleSignOut = (): void => {
    if (!auth || isLoggingOut) {
      return;
    }
    void auth.logout().catch(() => {
      // Safe error state is captured on auth.logoutError and announced via role="alert"
    });
  };

  const entries: MenuEntry[] = [
    { type: 'item', label: 'Account settings', icon: Settings, disabled: true, hint: 'Soon' },
    ...(import.meta.env.DEV
      ? ([
          { type: 'separator' },
          { type: 'label', label: 'Development' },
          {
            type: 'item',
            label: 'Design system',
            icon: Palette,
            onSelect: () => void navigate('/design-system'),
          },
        ] satisfies MenuEntry[])
      : []),
    { type: 'separator' },
    canSignOut
      ? {
          type: 'item',
          label: isLoggingOut ? 'Signing out…' : 'Sign out',
          icon: LogOut,
          disabled: isLoggingOut,
          ...(isLoggingOut ? { hint: 'Working…' } : {}),
          onSelect: handleSignOut,
        }
      : {
          type: 'item',
          label: 'Sign out',
          icon: LogOut,
          disabled: true,
          hint: 'Preview mode',
        },
  ];

  return (
    <div className="relative flex items-center gap-2">
      <DropdownMenu
        label="Account menu"
        triggerClassName="flex h-9 items-center gap-2 rounded-md px-1.5 text-left hover:bg-surface-muted"
        trigger={
          <>
            <Avatar name={accountLabel} size="md" />
            <span className="hidden min-w-0 md:block">
              <span className="block max-w-40 truncate text-sm leading-4 font-medium text-fg">
                {accountLabel}
              </span>
              <span className="block max-w-40 truncate text-2xs leading-4 text-fg-subtle">
                {user.roleLabel} · {organization.name}
              </span>
            </span>
            <Icon
              icon={ChevronDown}
              size="sm"
              className="hidden shrink-0 text-fg-subtle md:block"
            />
          </>
        }
        header={
          <div className="flex items-center gap-2.5">
            <Avatar name={accountLabel} size="lg" />
            <div className="min-w-0">
              {showDistinctDisplayName ? (
                <>
                  <p className="truncate text-sm font-semibold text-fg">{user.name}</p>
                  <p className="truncate text-xs text-fg-subtle">{user.email}</p>
                </>
              ) : (
                <p className="truncate text-sm font-semibold text-fg">{accountLabel}</p>
              )}
              <p className="truncate text-xs text-fg-subtle">
                {user.roleLabel} · {organization.name}
              </p>
            </div>
          </div>
        }
        entries={entries}
      />

      {logoutError ? (
        <div
          role="alert"
          className="fixed top-16 right-4 z-50 flex max-w-sm items-start gap-2.5 rounded-lg border border-danger-border bg-surface p-3 shadow-md sm:right-6"
        >
          <Icon icon={AlertCircle} size="md" className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-fg">Unable to sign out</p>
            <p className="mt-0.5 text-xs text-fg-subtle">{logoutError}</p>
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" variant="secondary" loading={isLoggingOut} onClick={handleSignOut}>
                Retry sign out
              </Button>
              <Button size="sm" variant="ghost" onClick={() => auth?.clearLogoutError()}>
                Dismiss
              </Button>
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss sign-out error"
            onClick={() => auth?.clearLogoutError()}
            className="rounded-sm p-1 text-fg-subtle hover:bg-surface-muted hover:text-fg"
          >
            <Icon icon={X} size="sm" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
