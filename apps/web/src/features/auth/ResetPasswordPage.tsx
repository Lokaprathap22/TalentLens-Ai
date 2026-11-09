import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound, Mail, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';

import { LogoMark, Wordmark } from '../../components/brand.js';
import { Button, Card, CardBody, Field, Icon, Input } from '../../components/ui/index.js';
import { apiClient, isApiError } from '../../lib/api-client.js';
import { usePageTitle } from '../../lib/use-page-title.js';

export function ResetPasswordPage(): React.JSX.Element {
  usePageTitle('Reset Password');
  const [searchParams] = useSearchParams();

  const [token] = useState<string>(() => {
    // 1. Preferred approach: URL fragment #token=...
    if (typeof window !== 'undefined' && window.location.hash) {
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const fragmentToken = hashParams.get('token');
      if (fragmentToken?.trim()) {
        return fragmentToken.trim();
      }
    }
    // 2. Backward compatibility: query parameter ?token=...
    return (searchParams.get('token') ?? '').trim();
  });

  // Scrub the token immediately from browser history and address bar
  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      (window.location.hash || window.location.search.includes('token='))
    ) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  // Request Mode state
  const [organization, setOrganization] = useState('');
  const [email, setEmail] = useState('');
  const [requestSent, setRequestSent] = useState(false);

  // Confirm Mode state
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);

  // Common form state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handleRequestSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(null);

    const errors: Record<string, string> = {};
    if (!organization.trim()) {
      errors['organization'] = 'Enter your organization name.';
    }
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors['email'] = 'Enter a valid work email address.';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setIsSubmitting(true);

    try {
      await apiClient.post('/auth/password/reset/request', {
        organization: organization.trim(),
        email: email.trim(),
      });
      setIsSubmitting(false);
      setRequestSent(true);
    } catch {
      // Anti-enumeration: still display generic requestSent confirmation
      setIsSubmitting(false);
      setRequestSent(true);
    }
  };

  const handleConfirmSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(null);

    const errors: Record<string, string> = {};
    if (!newPassword || newPassword.length < 8) {
      errors['newPassword'] = 'Password must be at least 8 characters long.';
    }
    if (newPassword !== confirmPassword) {
      errors['confirmPassword'] = 'Passwords do not match.';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setIsSubmitting(true);

    try {
      await apiClient.post('/auth/password/reset/confirm', {
        token,
        newPassword,
      });
      setIsSubmitting(false);
      setResetSuccess(true);
    } catch (err: unknown) {
      setIsSubmitting(false);
      if (isApiError(err)) {
        if (err.code === 'invalid_token') {
          setFormError(
            'This password reset link is invalid, expired, or has already been used. Please request a new link.',
          );
          return;
        }
        setFormError(err.message || 'Unable to reset password. Please try again.');
        return;
      }
      setFormError('An unexpected network error occurred. Please check your connection and retry.');
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-3 flex items-center gap-2.5">
            <LogoMark className="size-9" />
            <Wordmark className="text-xl text-fg" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-fg">
            {token ? 'Set new password' : 'Reset your password'}
          </h1>
          <p className="mt-1.5 text-sm text-fg-muted">
            {token
              ? 'Enter your new workspace credentials below.'
              : 'Enter your organization and work email to receive a secure reset link.'}
          </p>
        </div>

        <Card>
          <CardBody className="p-6 sm:p-8">
            {token ? (
              // Confirm Mode (token present in URL)
              resetSuccess ? (
                <div className="text-center space-y-4 py-2">
                  <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
                    <Icon icon={CheckCircle2} size="lg" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-fg">Password updated</h2>
                    <p className="mt-1 text-sm text-fg-muted">
                      Your password has been changed successfully. Any existing active sessions have
                      been signed out.
                    </p>
                  </div>
                  <div className="pt-2">
                    <Link
                      to="/login"
                      className="inline-flex w-full items-center justify-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-focus"
                    >
                      Sign in with new password
                    </Link>
                  </div>
                </div>
              ) : (
                <>
                  {formError ? (
                    <div
                      role="alert"
                      className="mb-5 flex items-start gap-2.5 rounded-md border border-danger-border bg-danger-soft px-3.5 py-3 text-sm text-danger"
                    >
                      <Icon icon={AlertCircle} size="md" className="mt-0.5 shrink-0" />
                      <span>{formError}</span>
                    </div>
                  ) : null}

                  <form
                    onSubmit={(event) => void handleConfirmSubmit(event)}
                    noValidate
                    className="space-y-4"
                  >
                    <Field
                      label="New password"
                      hint="At least 8 characters"
                      {...(fieldErrors['newPassword'] ? { error: fieldErrors['newPassword'] } : {})}
                    >
                      {({ id, describedBy, invalid }) => (
                        <div className="relative">
                          <Input
                            id={id}
                            name="newPassword"
                            type={showPassword ? 'text' : 'password'}
                            autoComplete="new-password"
                            placeholder="Enter new password"
                            value={newPassword}
                            disabled={isSubmitting}
                            aria-invalid={invalid || undefined}
                            aria-describedby={describedBy}
                            className="h-9 pr-9"
                            onChange={(e) => {
                              setNewPassword(e.target.value);
                              if (fieldErrors['newPassword']) {
                                setFieldErrors((prev) => ({ ...prev, newPassword: '' }));
                              }
                            }}
                          />
                          <button
                            type="button"
                            aria-label={showPassword ? 'Hide password' : 'Show password'}
                            aria-pressed={showPassword}
                            disabled={isSubmitting}
                            onClick={() => setShowPassword((v) => !v)}
                            className="absolute inset-y-0 right-1 flex w-8 items-center justify-center rounded-sm text-fg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Icon icon={showPassword ? EyeOff : Eye} size="sm" />
                          </button>
                        </div>
                      )}
                    </Field>

                    <Field
                      label="Confirm new password"
                      {...(fieldErrors['confirmPassword']
                        ? { error: fieldErrors['confirmPassword'] }
                        : {})}
                    >
                      {({ id, describedBy, invalid }) => (
                        <Input
                          id={id}
                          name="confirmPassword"
                          type={showPassword ? 'text' : 'password'}
                          autoComplete="new-password"
                          placeholder="Confirm new password"
                          value={confirmPassword}
                          disabled={isSubmitting}
                          aria-invalid={invalid || undefined}
                          aria-describedby={describedBy}
                          className="h-9"
                          onChange={(e) => {
                            setConfirmPassword(e.target.value);
                            if (fieldErrors['confirmPassword']) {
                              setFieldErrors((prev) => ({ ...prev, confirmPassword: '' }));
                            }
                          }}
                        />
                      )}
                    </Field>

                    <div className="pt-2">
                      <Button
                        type="submit"
                        variant="primary"
                        size="lg"
                        icon={KeyRound}
                        loading={isSubmitting}
                        className="w-full"
                      >
                        {isSubmitting ? 'Updating…' : 'Update password'}
                      </Button>
                    </div>
                  </form>
                </>
              )
            ) : // Request Mode (no token in URL)
            requestSent ? (
              <div className="text-center space-y-4 py-2">
                <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
                  <Icon icon={Mail} size="lg" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-fg">Check your email</h2>
                  <p className="mt-1 text-sm text-fg-muted">
                    If an account matches those details, a password reset link has been dispatched.
                    Please check your inbox and spam folder.
                  </p>
                </div>
                <div className="pt-2">
                  <Link
                    to="/login"
                    className="inline-flex w-full items-center justify-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-focus"
                  >
                    Return to sign in
                  </Link>
                </div>
              </div>
            ) : (
              <>
                {formError ? (
                  <div
                    role="alert"
                    className="mb-5 flex items-start gap-2.5 rounded-md border border-danger-border bg-danger-soft px-3.5 py-3 text-sm text-danger"
                  >
                    <Icon icon={AlertCircle} size="md" className="mt-0.5 shrink-0" />
                    <span>{formError}</span>
                  </div>
                ) : null}

                <form
                  onSubmit={(event) => void handleRequestSubmit(event)}
                  noValidate
                  className="space-y-4"
                >
                  <Field
                    label="Organization"
                    hint="Your workspace identifier"
                    {...(fieldErrors['organization'] ? { error: fieldErrors['organization'] } : {})}
                  >
                    {({ id, describedBy, invalid }) => (
                      <Input
                        id={id}
                        name="organization"
                        type="text"
                        autoComplete="organization"
                        placeholder="e.g. Northwind Talent"
                        value={organization}
                        disabled={isSubmitting}
                        aria-invalid={invalid || undefined}
                        aria-describedby={describedBy}
                        className="h-9"
                        onChange={(e) => {
                          setOrganization(e.target.value);
                          if (fieldErrors['organization']) {
                            setFieldErrors((prev) => ({ ...prev, organization: '' }));
                          }
                        }}
                      />
                    )}
                  </Field>

                  <Field
                    label="Work email"
                    {...(fieldErrors['email'] ? { error: fieldErrors['email'] } : {})}
                  >
                    {({ id, describedBy, invalid }) => (
                      <Input
                        id={id}
                        name="email"
                        type="email"
                        autoComplete="username"
                        placeholder="name@company.com"
                        value={email}
                        disabled={isSubmitting}
                        aria-invalid={invalid || undefined}
                        aria-describedby={describedBy}
                        className="h-9"
                        onChange={(e) => {
                          setEmail(e.target.value);
                          if (fieldErrors['email']) {
                            setFieldErrors((prev) => ({ ...prev, email: '' }));
                          }
                        }}
                      />
                    )}
                  </Field>

                  <div className="rounded-md border border-border bg-surface-muted/60 p-3 text-xs text-fg-muted space-y-1">
                    <div className="flex items-center gap-1.5 font-medium text-fg">
                      <Icon icon={ShieldCheck} size="sm" className="text-accent" />
                      <span>Anti-enumeration protected</span>
                    </div>
                    <p>
                      To protect account privacy, reset links are sent only to registered active
                      accounts without confirmation in the browser.
                    </p>
                  </div>

                  <div className="pt-2">
                    <Button
                      type="submit"
                      variant="primary"
                      size="lg"
                      icon={Mail}
                      loading={isSubmitting}
                      className="w-full"
                    >
                      {isSubmitting ? 'Sending…' : 'Send reset link'}
                    </Button>
                  </div>
                </form>
              </>
            )}
          </CardBody>
        </Card>

        <p className="mt-6 text-center text-xs text-fg-subtle">
          Remember your password?{' '}
          <Link to="/login" className="font-medium text-accent hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
