import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { AppRoutes } from './App.js';

function renderAt(initialEntry = '/dashboard'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('TalentLens AI Recruiter AppShell & Dashboard (M9.1)', () => {
  it('renders the application shell, workspace identity, and dashboard pipeline', async () => {
    renderAt('/dashboard');

    expect(screen.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(screen.getAllByText('Northwind Talent').length).toBeGreaterThan(0);

    // Wait for dashboard fixture resolution
    expect(await screen.findByRole('heading', { name: 'Hiring pipeline' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Candidate review queue' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Active requisitions' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Upcoming interviews' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent workflow activity' })).toBeInTheDocument();
  });

  it('switches review queue tabs and explicitly surfaces insufficient evidence without zero scores', async () => {
    const user = userEvent.setup();
    renderAt('/dashboard');

    // Ready tab shows verified candidates
    expect(await screen.findByText('CAN-4821')).toBeInTheDocument();

    // Switch to Evidence & parsing gaps tab
    const gapsTab = screen.getByRole('tab', { name: /Evidence & parsing gaps/i });
    await user.click(gapsTab);

    // CAN-4799 has score: null, coverage: 31 -> must show "Insufficient evidence (not scored)", never "0 / 100"
    expect(screen.getByText('CAN-4799')).toBeInTheDocument();
    expect(screen.getAllByText(/Insufficient evidence \(not scored\)/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('0 / 100')).not.toBeInTheDocument();

    // Switch to Consent holds tab
    const consentTab = screen.getByRole('tab', { name: /Consent holds/i });
    await user.click(consentTab);
    expect(screen.getByText('CAN-4768')).toBeInTheDocument();
    expect(screen.getAllByText('Consent withdrawn').length).toBeGreaterThan(0);
  });

  it('filters the candidate review queue by search query and opens the candidate inspection dialog', async () => {
    const user = userEvent.setup();
    renderAt('/dashboard');

    expect(await screen.findByText('CAN-4821')).toBeInTheDocument();

    const searchInput = screen.getByRole('searchbox', {
      name: /Filter review queue by candidate code or requisition/i,
    });
    await user.type(searchInput, 'CAN-4786');

    expect(screen.getByText('CAN-4786')).toBeInTheDocument();
    expect(screen.queryByText('CAN-4821')).not.toBeInTheDocument();

    const inspectButton = screen.getByRole('button', { name: 'Inspect' });
    await user.click(inspectButton);

    const dialog = screen.getByRole('dialog', { name: /Assessment preview · CAN-4786/i });
    expect(dialog).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Mandatory human review & fairness guardrails/i),
    ).toBeInTheDocument();
  });

  it('supports empty and error preview states via URL search parameters', async () => {
    renderAt('/dashboard?state=error');
    expect(
      await screen.findByRole('heading', { name: /Unable to load dashboard workspace/i }),
    ).toBeInTheDocument();
  });

  it('renders the design system reference route', () => {
    renderAt('/design-system');
    expect(screen.getByRole('heading', { name: 'Design system', level: 1 })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Domain status badges', level: 2 }),
    ).toBeInTheDocument();
  });
});
