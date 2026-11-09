import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiClient } from '../../lib/api-client.js';
import { ActivatePage } from './ActivatePage.js';

describe('ActivatePage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('displays an error state when no token query parameter is present', () => {
    render(
      <MemoryRouter initialEntries={['/activate']}>
        <Routes>
          <Route path="/activate" element={<ActivatePage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Activation link missing')).toBeInTheDocument();
    expect(screen.getByText(/No activation token was provided/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Return to sign in/i })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  it('validates password minimum length and matching confirm password', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/activate?token=valid-test-token']}>
        <Routes>
          <Route path="/activate" element={<ActivatePage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: /Activate your account/i })).toBeInTheDocument();

    const submitBtn = screen.getByRole('button', { name: /Activate account/i });
    await user.click(submitBtn);

    expect(screen.getByText('Password must be at least 8 characters long.')).toBeInTheDocument();

    // Mismatched passwords
    const passwordInput = screen.getByLabelText(/Choose password/i);
    const confirmInput = screen.getByLabelText(/Confirm password/i);

    await user.type(passwordInput, 'supersecret123');
    await user.type(confirmInput, 'different123');
    await user.click(submitBtn);

    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
  });

  it('submits valid password and displays success message', async () => {
    const user = userEvent.setup();
    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      user: {
        userId: 'user-1',
        organizationId: 'org-1',
        organizationName: 'TalentLens',
        email: 'recruiter@example.com',
        role: 'RECRUITER',
      },
    });

    render(
      <MemoryRouter initialEntries={['/activate?token=valid-test-token-123456']}>
        <Routes>
          <Route path="/activate" element={<ActivatePage />} />
        </Routes>
      </MemoryRouter>,
    );

    const passwordInput = screen.getByLabelText(/Choose password/i);
    const confirmInput = screen.getByLabelText(/Confirm password/i);

    await user.type(passwordInput, 'supersecret123');
    await user.type(confirmInput, 'supersecret123');

    const submitBtn = screen.getByRole('button', { name: /Activate account/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Account activated!')).toBeInTheDocument();
    });

    expect(postSpy).toHaveBeenCalledWith('/auth/activate', {
      token: 'valid-test-token-123456',
      password: 'supersecret123',
    });
  });

  it('displays alert when server rejects token as expired or invalid', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiClient, 'post').mockRejectedValueOnce(
      new ApiError({
        status: 400,
        code: 'invalid_token',
        message: 'Token is expired or consumed',
      }),
    );

    render(
      <MemoryRouter initialEntries={['/activate?token=expired-token-123456']}>
        <Routes>
          <Route path="/activate" element={<ActivatePage />} />
        </Routes>
      </MemoryRouter>,
    );

    const passwordInput = screen.getByLabelText(/Choose password/i);
    const confirmInput = screen.getByLabelText(/Confirm password/i);

    await user.type(passwordInput, 'supersecret123');
    await user.type(confirmInput, 'supersecret123');

    const submitBtn = screen.getByRole('button', { name: /Activate account/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /This activation link is invalid, expired, or has already been used/i,
      );
    });
  });

  it('extracts token from URL fragment #token=... and sanitizes history immediately', async () => {
    const user = userEvent.setup();
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      user: {
        userId: 'user-1',
        organizationId: 'org-1',
        organizationName: 'TalentLens',
        email: 'recruiter@example.com',
        role: 'RECRUITER',
      },
    });

    window.location.hash = '#token=fragment-token-987654';

    render(
      <MemoryRouter initialEntries={['/activate']}>
        <Routes>
          <Route path="/activate" element={<ActivatePage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(replaceStateSpy).toHaveBeenCalled();

    const passwordInput = screen.getByLabelText(/Choose password/i);
    const confirmInput = screen.getByLabelText(/Confirm password/i);

    await user.type(passwordInput, 'supersecret123');
    await user.type(confirmInput, 'supersecret123');

    const submitBtn = screen.getByRole('button', { name: /Activate account/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Account activated!')).toBeInTheDocument();
    });

    expect(postSpy).toHaveBeenCalledWith('/auth/activate', {
      token: 'fragment-token-987654',
      password: 'supersecret123',
    });

    window.location.hash = '';
  });
});
