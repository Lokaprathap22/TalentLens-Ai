import { Compass } from 'lucide-react';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes } from 'react-router';

import { AuthProvider } from './app/auth.js';
import { ProtectedRoute, RoleWorkspaceNoticePage } from './app/protected-route.js';
import { WorkspaceProvider, useWorkspace } from './app/workspace.js';
import { Card, EmptyState, buttonStyles } from './components/ui/index.js';
import { sampleWorkspace } from './dev-fixtures/workspace.fixture.js';
import { ActivatePage } from './features/auth/ActivatePage.js';
import { LoginPage } from './features/auth/LoginPage.js';
import { ResetPasswordPage } from './features/auth/ResetPasswordPage.js';
import { CandidateDetailPage } from './features/candidates/CandidateDetailPage.js';
import { CandidatesPage } from './features/candidates/CandidatesPage.js';
import { GlobalCandidatesPage } from './features/candidates/GlobalCandidatesPage.js';
import { ClientPortalPage } from './features/client-portal/ClientPortalPage.js';
import { ClientDetailPage } from './features/clients/ClientDetailPage.js';
import { ClientsPage } from './features/clients/ClientsPage.js';
import { ConsentPortalPage } from './features/consent/ConsentPortalPage.js';
import { ConsentWithdrawalPage } from './features/consent/ConsentWithdrawalPage.js';
import { ConsentDeletionPage } from './features/consent/ConsentDeletionPage.js';
import { DashboardPage } from './features/dashboard/DashboardPage.js';
import { DesignSystemPage } from './features/design-system/DesignSystemPage.js';
import { InterviewsPage } from './features/interviews/InterviewsPage.js';
import { RequisitionDetailPage } from './features/requisitions/RequisitionDetailPage.js';
import { RequisitionsPage } from './features/requisitions/RequisitionsPage.js';
import { ScorecardEditorPage } from './features/scorecards/ScorecardEditorPage.js';
import { ScorecardIndexPage } from './features/scorecards/ScorecardIndexPage.js';
import { ScorecardsPage } from './features/scorecards/ScorecardsPage.js';
import { SettingsPage } from './features/settings/SettingsPage.js';
import { AppShell } from './layouts/AppShell.js';
import { PageHeader } from './layouts/PageHeader.js';

const IS_DEV_OR_TEST = import.meta.env.DEV || import.meta.env.MODE === 'test';

function DashboardRouteWrapper(): React.JSX.Element {
  const { user } = useWorkspace();
  if (user.role === 'RECRUITER') {
    return <AppShell />;
  }
  return <Outlet />;
}

function InterviewsRouteWrapper(): React.JSX.Element {
  const { user } = useWorkspace();
  if (user.role === 'RECRUITER') {
    return <AppShell />;
  }
  return <Outlet />;
}

function NotFoundPage(): React.JSX.Element {
  return (
    <div>
      <PageHeader
        title="Page not found"
        description="The workspace route you requested does not exist or is scheduled for a later milestone."
      />
      <Card>
        <EmptyState
          icon={Compass}
          title="Route unavailable"
          description="Return to the recruiter dashboard to review candidates, requisitions, and upcoming interviews."
          action={
            <Link to="/dashboard" className={buttonStyles('primary', 'md')}>
              Back to dashboard
            </Link>
          }
        />
      </Card>
    </div>
  );
}

export function AppRoutes(): React.JSX.Element {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/activate" element={<ActivatePage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/consent" element={<ConsentPortalPage />} />
        <Route path="/consent/withdraw" element={<ConsentWithdrawalPage />} />
        <Route path="/consent/deletion" element={<ConsentDeletionPage />} />

        <Route
          path="/client-portal"
          element={
            <ProtectedRoute allowedRoles={['CLIENT_HIRING_MANAGER']}>
              <ClientPortalPage />
            </ProtectedRoute>
          }
        />

        <Route
          path="/delivery-overview"
          element={
            <ProtectedRoute allowedRoles={['DELIVERY_HEAD']}>
              <RoleWorkspaceNoticePage role="DELIVERY_HEAD" />
            </ProtectedRoute>
          }
        />

        <Route
          path="/dashboard"
          element={
            <ProtectedRoute allowedRoles={['RECRUITER', 'CLIENT_HIRING_MANAGER']}>
              <DashboardRouteWrapper />
            </ProtectedRoute>
          }
        >
          <Route index element={<DashboardPage />} />
        </Route>

        <Route
          path="/interviews"
          element={
            <ProtectedRoute allowedRoles={['RECRUITER', 'CLIENT_HIRING_MANAGER']}>
              <InterviewsRouteWrapper />
            </ProtectedRoute>
          }
        >
          <Route index element={<InterviewsPage />} />
        </Route>

        {IS_DEV_OR_TEST ? (
          <Route
            path="/dev/preview"
            element={
              <WorkspaceProvider value={sampleWorkspace}>
                <AppShell />
              </WorkspaceProvider>
            }
          >
            <Route index element={<Navigate to="/dev/preview/dashboard" replace />} />
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="design-system" element={<DesignSystemPage />} />
          </Route>
        ) : null}

        <Route element={<ProtectedRoute allowedRoles={['RECRUITER']} />}>
          <Route element={<AppShell />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/clients" element={<ClientsPage />} />
            <Route path="/clients/:clientId" element={<ClientDetailPage />} />
            <Route path="/requisitions" element={<RequisitionsPage />} />
            <Route path="/requisitions/:requisitionId" element={<RequisitionDetailPage />} />
            <Route path="/scorecards" element={<ScorecardIndexPage />} />
            <Route path="/candidates" element={<GlobalCandidatesPage />} />
            <Route path="/requisitions/:requisitionId/candidates" element={<CandidatesPage />} />
            <Route
              path="/requisitions/:requisitionId/candidates/:candidateId"
              element={<CandidateDetailPage />}
            />
            <Route path="/requisitions/:requisitionId/scorecards" element={<ScorecardsPage />} />
            <Route
              path="/requisitions/:requisitionId/scorecards/:versionId"
              element={<ScorecardEditorPage />}
            />
            <Route path="/settings" element={<SettingsPage />} />
            {IS_DEV_OR_TEST ? <Route path="/design-system" element={<DesignSystemPage />} /> : null}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </AuthProvider>
  );
}

export function App(): React.JSX.Element {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

export default App;
