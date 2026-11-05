import { AlertCircle, Building2, LogOut, RefreshCw, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';

import { LogoMark, Wordmark } from '../components/brand.js';
import { Avatar, Badge, Button, Card, CardBody, Icon } from '../components/ui/index.js';
import {
  defaultLandingPathForRole,
  formatUserRoleLabel,
  type UserRole,
} from '../features/auth/auth.types.js';
import { usePageTitle } from '../lib/use-page-title.js';
import { useAuth } from './auth.js';
import { WorkspaceProvider, createAuthenticatedWorkspace, useWorkspace } from './workspace.js';

export function SessionLoadingScreen(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 text-center"
    >
      <LogoMark className="size-10 animate-pulse" />
      <p className="mt-3 text-sm font-medium text-fg">Restoring secure workspace session…</p>
      <p className="mt-1 text-xs text-fg-subtle">
        Verifying organization credentials and permissions
      </p>
    </div>
  );
}

export function SessionInitializationErrorScreen(): React.JSX.Element {
  const { state, isInitializing, retryInitialization } = useAuth();

  const isCsrfStage = state.status === 'initialization-error' && state.stage === 'csrf';
  const verifiedUser = state.status === 'initialization-error' ? state.user : undefined;
  const errorMessage =
    state.status === 'initialization-error'
      ? state.message
      : 'Unable to verify your workspace session right now. Please retry.';

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <LogoMark className="size-8" />
          <Wordmark className="text-lg text-fg" />
        </div>

        <Card>
          <CardBody className="p-6 sm:p-8">
            <div
              role="alert"
              className="flex items-start gap-3 rounded-lg border border-warning-border bg-warning-soft/60 p-4 text-sm text-fg"
            >
              <Icon icon={AlertCircle} size="md" className="mt-0.5 shrink-0 text-warning" />
              <div className="min-w-0 flex-1">
                <h1 className="text-base font-semibold tracking-tight text-fg">
                  {isCsrfStage
                    ? 'Workspace security initialization incomplete'
                    : 'Unable to verify workspace session'}
                </h1>
                <p className="mt-1 text-xs leading-relaxed text-fg-muted">{errorMessage}</p>
              </div>
            </div>

            {verifiedUser ? (
              <dl className="mt-5 grid grid-cols-1 gap-3 rounded-lg border border-border bg-surface-muted/60 p-4 text-xs sm:grid-cols-3">
                <div>
                  <dt className="font-medium text-fg-subtle">Verified account</dt>
                  <dd className="mt-1 truncate font-semibold text-fg">{verifiedUser.email}</dd>
                </div>
                <div>
                  <dt className="font-medium text-fg-subtle">Organization</dt>
                  <dd className="mt-1 truncate font-semibold text-fg">
                    {verifiedUser.organizationName}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-fg-subtle">Role</dt>
                  <dd className="mt-1 font-semibold text-fg">
                    {formatUserRoleLabel(verifiedUser.role)}
                  </dd>
                </div>
              </dl>
            ) : null}

            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
              <p className="text-xs text-fg-subtle">
                {isCsrfStage
                  ? 'Your session is active. Retry to finish initializing CSRF protection without signing in again.'
                  : 'Protected workspace content remains locked until your session can be verified.'}
              </p>
              <Button
                type="button"
                variant="primary"
                size="md"
                icon={RefreshCw}
                loading={isInitializing}
                onClick={() => void retryInitialization()}
              >
                {isInitializing ? 'Retrying…' : 'Retry'}
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

interface ProtectedRouteProps {
  allowedRoles?: readonly UserRole[];
  children?: ReactNode;
}

export function ProtectedRoute({ allowedRoles, children }: ProtectedRouteProps): React.JSX.Element {
  const { state } = useAuth();
  const location = useLocation();

  if (state.status === 'loading') {
    return <SessionLoadingScreen />;
  }

  if (state.status === 'initialization-error') {
    return <SessionInitializationErrorScreen />;
  }

  if (state.status === 'unauthenticated') {
    const requestedPath = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to="/login" state={{ from: requestedPath }} replace />;
  }

  const { user } = state;

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <Navigate to={defaultLandingPathForRole(user.role)} replace />;
  }

  const workspace = createAuthenticatedWorkspace(user);

  return (
    <WorkspaceProvider value={workspace}>
      {children ? <>{children}</> : <Outlet />}
    </WorkspaceProvider>
  );
}

interface RoleWorkspaceNoticePageProps {
  role: 'CLIENT_HIRING_MANAGER' | 'DELIVERY_HEAD';
}

export function RoleWorkspaceNoticePage({ role }: RoleWorkspaceNoticePageProps): React.JSX.Element {
  const isClientRole = role === 'CLIENT_HIRING_MANAGER';
  usePageTitle(isClientRole ? 'Client Portal' : 'Delivery Overview');

  const { user, organization } = useWorkspace();
  const { logout, isLoggingOut, logoutError, clearLogoutError } = useAuth();

  const handleSignOut = (): void => {
    void logout().catch(() => {
      // Error is stored on logoutError and surfaced via role="alert"
    });
  };

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="border-b border-border bg-surface px-4 sm:px-6 lg:px-8">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <LogoMark className="size-8" />
            <Wordmark className="text-base text-fg" />
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-2 sm:flex">
              <Avatar name={user.email} size="sm" />
              <div className="text-right">
                <p className="text-xs font-medium text-fg">{user.email}</p>
                <p className="text-2xs text-fg-subtle">
                  {formatUserRoleLabel(user.role)} · {organization.name}
                </p>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={LogOut}
              loading={isLoggingOut}
              onClick={handleSignOut}
            >
              {isLoggingOut ? 'Signing out…' : 'Sign out'}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-4 py-12 sm:px-6">
        {logoutError ? (
          <div
            role="alert"
            className="mb-5 flex items-start justify-between gap-3 rounded-lg border border-danger-border bg-danger-soft p-3.5 text-sm text-danger"
          >
            <div className="flex items-start gap-2.5">
              <Icon icon={AlertCircle} size="md" className="mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">Unable to sign out</p>
                <p className="mt-0.5 text-xs">{logoutError}</p>
              </div>
            </div>
            <Button size="sm" variant="secondary" onClick={clearLogoutError}>
              Dismiss
            </Button>
          </div>
        ) : null}

        <Card>
          <CardBody className="p-6 sm:p-8">
            <div className="flex items-center gap-2.5">
              <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface-muted text-accent">
                <Icon icon={isClientRole ? Building2 : ShieldAlert} size="lg" />
              </span>
              <Badge tone="accent">{formatUserRoleLabel(user.role)}</Badge>
            </div>

            <h1 className="mt-4 text-xl font-semibold tracking-tight text-fg">
              {isClientRole
                ? 'Client Hiring Manager portal arriving in an upcoming milestone'
                : 'Delivery Head workspace arriving in an upcoming milestone'}
            </h1>

            <p className="mt-2 text-sm leading-relaxed text-fg-muted">
              {isClientRole
                ? 'Your account is authenticated for client-side candidate review, structured interview feedback, and interview scheduling. The dedicated client portal UI is not yet enabled in this build, and recruiter-only modules are restricted for your role.'
                : 'Your account is authenticated with Delivery Head role permissions. Recruiter operational screens are restricted by role policy, and the delivery oversight workspace will be enabled in a future milestone.'}
            </p>

            <dl className="mt-6 grid grid-cols-1 gap-3 rounded-lg border border-border bg-surface-muted/60 p-4 text-xs sm:grid-cols-3">
              <div>
                <dt className="font-medium text-fg-subtle">Authenticated account</dt>
                <dd className="mt-1 truncate font-semibold text-fg">{user.email}</dd>
              </div>
              <div>
                <dt className="font-medium text-fg-subtle">Organization</dt>
                <dd className="mt-1 truncate font-semibold text-fg">{organization.name}</dd>
              </div>
              <div>
                <dt className="font-medium text-fg-subtle">Assigned role</dt>
                <dd className="mt-1 font-semibold text-fg">{formatUserRoleLabel(user.role)}</dd>
              </div>
            </dl>

            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
              <p className="text-xs text-fg-subtle">
                Need recruiter workspace access? Sign in with a Recruiter account for your
                organization.
              </p>
              <Button
                variant="primary"
                size="md"
                icon={LogOut}
                loading={isLoggingOut}
                onClick={handleSignOut}
              >
                {isLoggingOut ? 'Signing out…' : 'Sign out of session'}
              </Button>
            </div>
          </CardBody>
        </Card>
      </main>
    </div>
  );
}
