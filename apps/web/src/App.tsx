import { Compass } from 'lucide-react';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router';

import { WorkspaceProvider } from './app/workspace.js';
import { Card, EmptyState, buttonStyles } from './components/ui/index.js';
import { sampleWorkspace, unauthenticatedWorkspace } from './dev-fixtures/workspace.fixture.js';
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
  const workspace = IS_DEV_OR_TEST ? sampleWorkspace : unauthenticatedWorkspace;

  return (
    <WorkspaceProvider value={workspace}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          {IS_DEV_OR_TEST ? <Route path="/design-system" element={<DesignSystemPage />} /> : null}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </WorkspaceProvider>
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
