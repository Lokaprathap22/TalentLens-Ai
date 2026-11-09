import type { WorkspaceContextValue } from '../app/workspace.js';

/**
 * Development-only synthetic workspace identity used exclusively by explicit dev/test
 * preview routes. Never used to hydrate production authenticated sessions.
 */
export const sampleWorkspace: WorkspaceContextValue = {
  user: {
    id: 'sample-user-recruiter',
    name: 'Priya Raman',
    email: 'priya.raman@example.test',
    role: 'RECRUITER',
    roleLabel: 'Recruiter',
  },
  organization: {
    id: 'sample-org-northwind',
    name: 'Northwind Talent',
  },
  isSample: true,
};

/**
 * Neutral unpopulated workspace state when no session is active.
 */
export const unauthenticatedWorkspace: WorkspaceContextValue = {
  user: {
    id: '',
    name: 'Unauthenticated session',
    email: '',
    role: 'RECRUITER',
    roleLabel: 'Authentication required',
  },
  organization: {
    id: '',
    name: 'TalentLens Workspace',
  },
  isSample: false,
};
