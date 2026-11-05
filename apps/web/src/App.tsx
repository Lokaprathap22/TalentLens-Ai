import { Compass } from 'lucide-react';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router';

import { AuthProvider } from './app/auth.js';
import { ProtectedRoute, RoleWorkspaceNoticePage } from './app/protected-route.js';
import { WorkspaceProvider } from './app/workspace.js';
import { Card, EmptyState, buttonStyles } from './components/ui/index.js';
import { sampleWorkspace } from './dev-fixtures/workspace.fixture.js';
import { LoginPage } from './features/auth/LoginPage.js';
import { ClientsPage } from './features/clients/ClientsPage.js';
import { DashboardPage } from './features/dashboard/DashboardPage.js';
import { DesignSystemPage } from './features/design-system/DesignSystemPage.js';
import { AppShell } from './layouts/AppShell.js';
import { PageHeader } from './layouts/PageHeader.js';

const IS_DEV_OR_TEST = import.meta.env.DEV || import.meta.env.MODE === 'test';

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

        <Route
          path="/client-portal"
          element={
            <ProtectedRoute allowedRoles={['CLIENT_HIRING_MANAGER']}>
              <RoleWorkspaceNoticePage role="CLIENT_HIRING_MANAGER" />
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
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/clients" element={<ClientsPage />} />
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
