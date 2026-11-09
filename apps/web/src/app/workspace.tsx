import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

import {
  formatUserRoleLabel,
  type AuthenticatedUser,
  type UserRole,
} from '../features/auth/auth.types.js';

export interface WorkspaceContextValue {
  user: {
    id: string;
    /** Account identity label (email for authenticated sessions; never an invented personal name). */
    name: string;
    email: string;
    role: UserRole;
    roleLabel: string;
  };
  organization: {
    id: string;
    name: string;
  };
  /** True while identity comes from development fixtures rather than the API. */
  isSample: boolean;
}

export function createAuthenticatedWorkspace(user: AuthenticatedUser): WorkspaceContextValue {
  const displayName = user.name?.trim() ? user.name.trim() : user.email;
  return {
    user: {
      id: user.userId,
      name: displayName,
      email: user.email,
      role: user.role,
      roleLabel: formatUserRoleLabel(user.role),
    },
    organization: {
      id: user.organizationId,
      name: user.organizationName,
    },
    isSample: false,
  };
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  value,
  children,
}: {
  value: WorkspaceContextValue;
  children: ReactNode;
}): React.JSX.Element {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace must be used inside <WorkspaceProvider>.');
  return context;
}
