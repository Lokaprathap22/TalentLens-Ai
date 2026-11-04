import type { WorkspaceContextValue } from '../app/workspace.js';

/**
 * Development-only identity used until authentication is wired to the API (a later
 * milestone). Never import this from production feature code other than the bootstrap.
 */
export const sampleWorkspace: WorkspaceContextValue = {
  user: { name: 'Priya Raman', email: 'priya.raman@example.test', roleLabel: 'Recruiter' },
  organization: { name: 'Northwind Talent' },
  isSample: true,
};

/**
 * Neutral unpopulated workspace state used in production builds until M9.2 authentication
 * session hydration is wired. Prevents synthetic sample identity from leaking into prod.
 */
export const unauthenticatedWorkspace: WorkspaceContextValue = {
  user: { name: 'Recruiter session', email: '', roleLabel: 'Authentication pending' },
  organization: { name: 'TalentLens Workspace' },
  isSample: false,
};
