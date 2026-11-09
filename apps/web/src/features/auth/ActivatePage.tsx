import { AlertCircle, CheckCircle2, Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { LogoMark, Wordmark } from '../../components/brand.js';
import { Button, Card, CardBody, Field, Icon, Input } from '../../components/ui/index.js';
import { apiClient, fetchCsrfToken, isApiError } from '../../lib/api-client.js';
import type { AuthenticatedUserResponseDto } from '../../lib/api-client.js';
import { usePageTitle } from '../../lib/use-page-title.js';
import { defaultLandingPathForRole } from './auth.types.js';

export function ActivatePage(): React.JSX.Element {
  usePageTitle('Account Activation');
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

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

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ password?: string; confirmPassword?: string }>(
    {},
  );
  const [isSuccess, setIsSuccess] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(null);

    const errors: { password?: string; confirmPassword?: string } = {};
    if (!password || password.length < 8) {
      errors.password = 'Password must be at least 8 characters long.';
    }
    if (password !== confirmPassword) {
      errors.confirmPassword = 'Passwords do not match.';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setIsSubmitting(true);

    try {
      const response = await apiClient.post<AuthenticatedUserResponseDto>('/auth/activate', {
        token,
        password,
      });

      try {
        await fetchCsrfToken();
      } catch {
        // CSRF initialization fallback
      }

      setIsSuccess(true);
      const landingPath = defaultLandingPathForRole(response.user.role);
      setTimeout(() => {
        void navigate(landingPath, { replace: true });
      }, 1500);
    } catch (err: unknown) {
      setIsSubmitting(false);
      if (isApiError(err)) {
        if (err.code === 'invalid_token') {
          setFormError(
            'This activation link is invalid, expired, or has already been used. Please contact your administrator.',
          );
          return;
        }
        setFormError(err.message || 'Unable to complete activation. Please try again.');
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
          <h1 className="text-2xl font-bold tracking-tight text-fg">Activate your account</h1>
          <p className="mt-1.5 text-sm text-fg-muted">
            Create your permanent password to activate your recruitment workspace.
          </p>
        </div>

        <Card>
          <CardBody className="p-6 sm:p-8">
            {!token ? (
              <div className="text-center space-y-4">
                <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger">
                  <Icon icon={AlertCircle} size="lg" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-fg">Activation link missing</h2>
                  <p className="mt-1 text-sm text-fg-muted">
                    No activation token was provided. Please verify the URL or use the activation
                    link sent by your administrator.
                  </p>
                </div>
                <div className="pt-2">
                  <Link
                    to="/login"
                    className="inline-flex items-center justify-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-focus"
                  >
                    Return to sign in
                  </Link>
                </div>
              </div>
            ) : isSuccess ? (
              <div className="text-center space-y-4 py-2">
                <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
                  <Icon icon={CheckCircle2} size="lg" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-fg">Account activated!</h2>
                  <p className="mt-1 text-sm text-fg-muted">
                    Your password has been saved securely. Redirecting to your workspace…
                  </p>
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
                  onSubmit={(event) => void handleSubmit(event)}
                  noValidate
                  className="space-y-4"
                >
                  <Field
                    label="Choose password"
                    hint="At least 8 characters"
                    {...(fieldErrors.password ? { error: fieldErrors.password } : {})}
                  >
                    {({ id, describedBy, invalid }) => (
                      <div className="relative">
                        <Input
                          id={id}
                          name="password"
                          type={showPassword ? 'text' : 'password'}
                          autoComplete="new-password"
                          placeholder="Enter new password"
                          value={password}
                          disabled={isSubmitting}
                          aria-invalid={invalid || undefined}
                          aria-describedby={describedBy}
                          className="h-9 pr-9"
                          onChange={(e) => {
                            setPassword(e.target.value);
                            if (fieldErrors.password) {
                              setFieldErrors((prev) => {
                                const next = { ...prev };
                                delete next.password;
                                return next;
                              });
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
                    label="Confirm password"
                    {...(fieldErrors.confirmPassword ? { error: fieldErrors.confirmPassword } : {})}
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
                          if (fieldErrors.confirmPassword) {
                            setFieldErrors((prev) => {
                              const next = { ...prev };
                              delete next.confirmPassword;
                              return next;
                            });
                          }
                        }}
                      />
                    )}
                  </Field>

                  <div className="rounded-md border border-border bg-surface-muted/60 p-3 text-xs text-fg-muted space-y-1">
                    <div className="flex items-center gap-1.5 font-medium text-fg">
                      <Icon icon={ShieldCheck} size="sm" className="text-accent" />
                      <span>Security requirement</span>
                    </div>
                    <p>
                      Passwords are hashed with memory-hard Argon2id and never stored in plaintext.
                    </p>
                  </div>

                  <div className="pt-2">
                    <Button
                      type="submit"
                      variant="primary"
                      size="lg"
                      icon={Lock}
                      loading={isSubmitting}
                      className="w-full"
                    >
                      {isSubmitting ? 'Activating…' : 'Activate account'}
                    </Button>
                  </div>
                </form>
              </>
            )}
          </CardBody>
        </Card>

        <p className="mt-6 text-center text-xs text-fg-subtle">
          Already have an active account?{' '}
          <Link to="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
