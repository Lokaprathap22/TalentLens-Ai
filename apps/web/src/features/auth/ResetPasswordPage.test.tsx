import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiClient } from '../../lib/api-client.js';
import { ResetPasswordPage } from './ResetPasswordPage.js';

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders request mode when no token is in URL and validates required fields', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/reset-password']}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: /Reset your password/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Organization/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Work email/i)).toBeInTheDocument();

    const submitBtn = screen.getByRole('button', { name: /Send reset link/i });
    await user.click(submitBtn);

    expect(screen.getByText('Enter your organization name.')).toBeInTheDocument();
  });

  it('submits reset request and displays generic email confirmation screen', async () => {
    const user = userEvent.setup();
    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      status: 'ok',
      message: 'If an account matches those details, a password reset link has been sent.',
    });

    render(
      <MemoryRouter initialEntries={['/reset-password']}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText(/Organization/i), 'Northwind Talent');
    await user.type(screen.getByLabelText(/Work email/i), 'recruiter@northwind.example');

    const submitBtn = screen.getByRole('button', { name: /Send reset link/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Check your email')).toBeInTheDocument();
    });

    expect(postSpy).toHaveBeenCalledWith('/auth/password/reset/request', {
      organization: 'Northwind Talent',
      email: 'recruiter@northwind.example',
    });
    expect(screen.getByRole('link', { name: /Return to sign in/i })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  it('renders confirmation mode when token is present, validates matching passwords', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/reset-password?token=test-reset-token-12345']}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: /Set new password/i })).toBeInTheDocument();

    const submitBtn = screen.getByRole('button', { name: /Update password/i });
    await user.click(submitBtn);

    expect(screen.getByText('Password must be at least 8 characters long.')).toBeInTheDocument();

    const newPassInput = screen.getByLabelText(/^New password/i);
    const confirmInput = screen.getByLabelText(/Confirm new password/i);

    await user.type(newPassInput, 'supersecret123');
    await user.type(confirmInput, 'different123');
    await user.click(submitBtn);

    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
  });

  it('successfully resets password and displays success screen with login link', async () => {
    const user = userEvent.setup();
    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      status: 'ok',
      message: 'Password has been reset successfully.',
    });

    render(
      <MemoryRouter initialEntries={['/reset-password?token=test-reset-token-12345']}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const newPassInput = screen.getByLabelText(/^New password/i);
    const confirmInput = screen.getByLabelText(/Confirm new password/i);

    await user.type(newPassInput, 'brand-new-password-123');
    await user.type(confirmInput, 'brand-new-password-123');

    const submitBtn = screen.getByRole('button', { name: /Update password/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Password updated')).toBeInTheDocument();
    });

    expect(postSpy).toHaveBeenCalledWith('/auth/password/reset/confirm', {
      token: 'test-reset-token-12345',
      newPassword: 'brand-new-password-123',
    });
    expect(screen.getByRole('link', { name: /Sign in with new password/i })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  it('displays alert when server rejects reset token as invalid or expired', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiClient, 'post').mockRejectedValueOnce(
      new ApiError({
        status: 400,
        code: 'invalid_token',
        message: 'Invalid or expired token',
      }),
    );

    render(
      <MemoryRouter initialEntries={['/reset-password?token=bad-token-12345']}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const newPassInput = screen.getByLabelText(/^New password/i);
    const confirmInput = screen.getByLabelText(/Confirm new password/i);

    await user.type(newPassInput, 'brand-new-password-123');
    await user.type(confirmInput, 'brand-new-password-123');

    const submitBtn = screen.getByRole('button', { name: /Update password/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /This password reset link is invalid, expired, or has already been used/i,
      );
    });
  });

  it('extracts reset token from URL fragment #token=... and sanitizes history immediately', async () => {
    const user = userEvent.setup();
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce({});

    window.location.hash = '#token=fragment-reset-token-777';

    render(
      <MemoryRouter initialEntries={['/reset-password']}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(replaceStateSpy).toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /Set new password/i })).toBeInTheDocument();

    const newPassInput = screen.getByLabelText(/^New password/i);
    const confirmInput = screen.getByLabelText(/Confirm new password/i);

    await user.type(newPassInput, 'brand-new-password-123');
    await user.type(confirmInput, 'brand-new-password-123');

    const submitBtn = screen.getByRole('button', { name: /Update password/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Password updated')).toBeInTheDocument();
    });

    expect(postSpy).toHaveBeenCalledWith('/auth/password/reset/confirm', {
      token: 'fragment-reset-token-777',
      newPassword: 'brand-new-password-123',
    });

    window.location.hash = '';
  });
});
