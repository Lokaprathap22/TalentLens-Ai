import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../app/auth.js';
import { WorkspaceProvider } from '../../app/workspace.js';
import type { WorkspaceContextValue } from '../../app/workspace.js';
import { ApiError, apiClient } from '../../lib/api-client.js';
import { SettingsPage } from './SettingsPage.js';

const mockWorkspace: WorkspaceContextValue = {
  user: {
    id: 'user-1',
    name: 'Jane Recruiter',
    email: 'jane@acme.com',
    role: 'RECRUITER',
    roleLabel: 'Recruiter',
  },
  organization: {
    id: 'org-1',
    name: 'Acme Staffing',
  },
  isSample: false,
};

function renderSettingsPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <AuthProvider>
        <WorkspaceProvider value={mockWorkspace}>
          <Routes>
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </WorkspaceProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      user: {
        userId: 'user-1',
        organizationId: 'org-1',
        organizationName: 'Acme Staffing',
        name: 'Jane Recruiter',
        email: 'jane@acme.com',
        role: 'RECRUITER',
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders profile details and security sections correctly', () => {
    renderSettingsPage();

    expect(screen.getByRole('heading', { name: /Account Settings/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Profile Identity/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Security & Password/i })).toBeInTheDocument();

    expect(screen.getByDisplayValue('Jane Recruiter')).toBeInTheDocument();
    expect(screen.getByDisplayValue('jane@acme.com')).toBeInTheDocument();
    expect(screen.getByText('Acme Staffing')).toBeInTheDocument();
    expect(screen.getByText('Recruiter')).toBeInTheDocument();
  });

  it('updates display name successfully', async () => {
    const user = userEvent.setup({ delay: null });
    const patchSpy = vi.spyOn(apiClient, 'patch').mockResolvedValueOnce({
      user: {
        userId: 'user-1',
        organizationId: 'org-1',
        organizationName: 'Acme Staffing',
        name: 'Jane Senior Recruiter',
        email: 'jane@acme.com',
        role: 'RECRUITER',
      },
    });

    renderSettingsPage();

    const nameInput = screen.getByLabelText(/Display name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Jane Senior Recruiter');

    const saveBtn = screen.getByRole('button', { name: /Save changes/i });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText(/Profile display name updated successfully/i)).toBeInTheDocument();
    });

    expect(patchSpy).toHaveBeenCalledWith('/auth/profile', {
      name: 'Jane Senior Recruiter',
    });
  });

  it('validates password matching and minimum length on password change form', async () => {
    const user = userEvent.setup({ delay: null });
    renderSettingsPage();

    const currentInput = screen.getByLabelText(/^Current password$/i);
    const newInput = screen.getByLabelText(/^New password$/i);
    const confirmInput = screen.getByLabelText(/^Confirm new password$/i);

    await user.type(currentInput, 'oldpass');
    await user.type(newInput, 'short');
    await user.type(confirmInput, 'mismatch');

    const changeBtn = screen.getByRole('button', { name: /Change password/i });
    await user.click(changeBtn);

    expect(
      screen.getByText('New password must be at least 8 characters long.'),
    ).toBeInTheDocument();
    expect(screen.getByText('New passwords do not match.')).toBeInTheDocument();
  });

  it('submits valid password change and displays success status', async () => {
    const user = userEvent.setup({ delay: null });
    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      status: 'ok',
      message: 'Password updated successfully',
    });

    renderSettingsPage();

    const currentInput = screen.getByLabelText(/^Current password$/i);
    const newInput = screen.getByLabelText(/^New password$/i);
    const confirmInput = screen.getByLabelText(/^Confirm new password$/i);

    await user.type(currentInput, 'oldSecretPassword123');
    await user.type(newInput, 'newSecretPassword123');
    await user.type(confirmInput, 'newSecretPassword123');

    const changeBtn = screen.getByRole('button', { name: /Change password/i });
    await user.click(changeBtn);

    await waitFor(() => {
      expect(screen.getByText(/Password updated successfully/i)).toBeInTheDocument();
    });

    expect(postSpy).toHaveBeenCalledWith('/auth/password/change', {
      currentPassword: 'oldSecretPassword123',
      newPassword: 'newSecretPassword123',
    });
  });

  it('displays error alert when current password is incorrect', async () => {
    const user = userEvent.setup({ delay: null });
    vi.spyOn(apiClient, 'post').mockRejectedValueOnce(
      new ApiError({
        status: 400,
        code: 'current_password_incorrect',
        message: 'Current password is incorrect',
      }),
    );

    renderSettingsPage();

    const currentInput = screen.getByLabelText(/^Current password$/i);
    const newInput = screen.getByLabelText(/^New password$/i);
    const confirmInput = screen.getByLabelText(/^Confirm new password$/i);

    await user.type(currentInput, 'wrongSecretPassword');
    await user.type(newInput, 'newSecretPassword123');
    await user.type(confirmInput, 'newSecretPassword123');

    const changeBtn = screen.getByRole('button', { name: /Change password/i });
    await user.click(changeBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Current password is incorrect/i);
    });
  });
}, 15000);
