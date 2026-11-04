import { ChevronDown, LogOut, Palette, Settings } from 'lucide-react';
import { useNavigate } from 'react-router';

import { useWorkspace } from '../app/workspace.js';
import { Avatar, DropdownMenu, Icon } from '../components/ui/index.js';
import type { MenuEntry } from '../components/ui/index.js';

export function AccountMenu(): React.JSX.Element {
  const { user, organization } = useWorkspace();
  const navigate = useNavigate();

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
    { type: 'item', label: 'Sign out', icon: LogOut, disabled: true, hint: 'Needs auth' },
  ];

  return (
    <DropdownMenu
      label="Account menu"
      triggerClassName="flex h-9 items-center gap-2 rounded-md px-1.5 text-left hover:bg-surface-muted"
      trigger={
        <>
          <Avatar name={user.name} size="md" />
          <span className="hidden min-w-0 md:block">
            <span className="block max-w-36 truncate text-sm leading-4 font-medium text-fg">
              {user.name}
            </span>
            <span className="block max-w-36 truncate text-2xs leading-4 text-fg-subtle">
              {user.roleLabel}
            </span>
          </span>
          <Icon icon={ChevronDown} size="sm" className="hidden shrink-0 text-fg-subtle md:block" />
        </>
      }
      header={
        <div className="flex items-center gap-2.5">
          <Avatar name={user.name} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-fg">{user.name}</p>
            <p className="truncate text-xs text-fg-subtle">{user.email}</p>
            <p className="truncate text-xs text-fg-subtle">
              {user.roleLabel} · {organization.name}
            </p>
          </div>
        </div>
      }
      entries={entries}
    />
  );
}
