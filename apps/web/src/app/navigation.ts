import {
  Briefcase,
  Building2,
  CalendarClock,
  ClipboardCheck,
  History,
  LayoutDashboard,
  Settings,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  to: string;
  /** Only items backed by a working screen are links; the rest are shown as unavailable. */
  available: boolean;
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

export const recruiterNavigation: NavSection[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [
      {
        id: 'dashboard',
        label: 'Dashboard',
        icon: LayoutDashboard,
        to: '/dashboard',
        available: true,
      },
    ],
  },
  {
    id: 'hiring',
    label: 'Hiring',
    items: [
      {
        id: 'requisitions',
        label: 'Requisitions',
        icon: Briefcase,
        to: '/requisitions',
        available: true,
      },
      {
        id: 'scorecards',
        label: 'Scorecards',
        icon: ClipboardCheck,
        to: '/scorecards',
        available: false,
      },
    ],
  },
  {
    id: 'talent',
    label: 'Talent',
    items: [
      { id: 'candidates', label: 'Candidates', icon: Users, to: '/candidates', available: false },
    ],
  },
  {
    id: 'relationships',
    label: 'Relationships',
    items: [{ id: 'clients', label: 'Clients', icon: Building2, to: '/clients', available: true }],
  },
  {
    id: 'coordination',
    label: 'Coordination',
    items: [
      {
        id: 'interviews',
        label: 'Interviews',
        icon: CalendarClock,
        to: '/interviews',
        available: false,
      },
    ],
  },
  {
    id: 'administration',
    label: 'Administration',
    items: [
      { id: 'audit', label: 'Audit history', icon: History, to: '/audit', available: false },
      { id: 'settings', label: 'Settings', icon: Settings, to: '/settings', available: false },
    ],
  },
];

export const UNAVAILABLE_REASON = 'Not available yet. This area arrives in a later milestone.';

export function allNavItems(): NavItem[] {
  return recruiterNavigation.flatMap((section) => section.items);
}
