import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

export interface WorkspaceContextValue {
  user: { name: string; email: string; roleLabel: string };
  organization: { name: string };
  /** True while identity comes from development fixtures rather than the API. */
  isSample: boolean;
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
