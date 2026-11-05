import { AlertCircle, Eye, EyeOff, Lock, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';

import { useAuth } from '../../app/auth.js';
import { SessionInitializationErrorScreen } from '../../app/protected-route.js';
import { LogoMark, Wordmark } from '../../components/brand.js';
import { Badge, Button, Card, CardBody, Field, Icon, Input } from '../../components/ui/index.js';
import { isApiError } from '../../lib/api-client.js';
import { usePageTitle } from '../../lib/use-page-title.js';
import { resolveSafePostLoginRedirect } from './auth.types.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldErrors {
  organization?: string;
  email?: string;
  password?: string;
}

interface LocationRedirectState {
  from?: unknown;
}

function extractRequestedDestination(
  locationState: unknown,
  searchParams: URLSearchParams,
): unknown {
  if (typeof locationState === 'object' && locationState !== null && 'from' in locationState) {
    const stateFrom = (locationState as LocationRedirectState).from;
    if (typeof stateFrom === 'string' && stateFrom.trim().length > 0) {
      return stateFrom;
    }
  }
  const queryRedirect = searchParams.get('redirect');
  if (queryRedirect && queryRedirect.trim().length > 0) {
    return queryRedirect;
  }
  return undefined;
}

function mapLoginErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'invalid_credentials') {
      return 'The organization, email or password is incorrect.';
    }
    if (error.status === 401) {
      return 'Your session could not be verified. Please sign in again.';
    }
    if (error.status === 429 || error.code === 'too_many_requests') {
      return 'Too many sign-in attempts. Please wait a few minutes before trying again.';
    }
    if (error.status === 400 || error.code === 'invalid_request') {
      return 'Please check your organization name, work email, and password and try again.';
    }
    if (error.status === 0 || error.code === 'network_error') {
      return 'Unable to reach TalentLens AI. Please check your network connection and try again.';
    }
    if (error.status >= 500) {
      return 'Authentication is temporarily unavailable. Please try again shortly.';
    }
  }
  return 'Unable to complete sign-in. Please try again.';
}

export function LoginPage(): React.JSX.Element {
  usePageTitle('Sign in');

  const { state } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const requestedDestination = extractRequestedDestination(location.state, searchParams);

  if (state.status === 'loading') {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-live="polite"
        className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 text-center"
      >
        <LogoMark className="size-10 animate-pulse" />
        <p className="mt-3 text-sm font-medium text-fg">Verifying workspace session…</p>
      </div>
    );
  }

  if (state.status === 'initialization-error') {
    return <SessionInitializationErrorScreen />;
  }

  if (state.status === 'authenticated') {
    const destination = resolveSafePostLoginRedirect(requestedDestination, state.user.role);
    return <Navigate to={destination} replace />;
  }

  return <LoginSignInView requestedDestination={requestedDestination} />;
}

function LoginSignInView({
  requestedDestination,
}: {
  requestedDestination: unknown;
}): React.JSX.Element {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [organization, setOrganization] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const validateFields = (): FieldErrors => {
    const errors: FieldErrors = {};
    const trimmedOrg = organization.trim();
    const trimmedEmail = email.trim();

    if (!trimmedOrg) {
      errors.organization = 'Organization name is required.';
    } else if (trimmedOrg.length > 200) {
      errors.organization = 'Organization name must be 200 characters or fewer.';
    }

    if (!trimmedEmail) {
      errors.email = 'Work email is required.';
    } else if (trimmedEmail.length > 320 || !EMAIL_PATTERN.test(trimmedEmail)) {
      errors.email = 'Enter a valid work email address.';
    }

    if (!password) {
      errors.password = 'Password is required.';
    }

    return errors;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }

    setFormError(null);
    const errors = validateFields();
    setFieldErrors(errors);

    if (Object.keys(errors).length > 0) {
      return;
    }

    setIsSubmitting(true);
    try {
      const authenticatedUser = await login({
        organization: organization.trim(),
        email: email.trim(),
        password,
      });
      setPassword('');
      const targetPath = resolveSafePostLoginRedirect(requestedDestination, authenticatedUser.role);
      void navigate(targetPath, { replace: true });
    } catch (error) {
      setFormError(mapLoginErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-dvh grid-cols-1 bg-canvas lg:grid-cols-12">
      <aside
        aria-label="TalentLens platform overview"
        className="hidden flex-col justify-between bg-sidebar p-10 text-sidebar-fg lg:col-span-5 lg:flex xl:p-12"
      >
        <div>
          <div className="flex items-center gap-2.5">
            <LogoMark className="size-9" />
            <Wordmark className="text-xl text-sidebar-fg-strong" />
          </div>

          <div className="mt-12 max-w-md">
            <Badge tone="accent" className="mb-4">
              Enterprise Recruitment Intelligence
            </Badge>
            <h2 className="text-2xl leading-tight font-semibold tracking-tight text-sidebar-fg-strong">
              Evidence-first candidate evaluation with mandatory human governance.
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-sidebar-muted">
              TalentLens AI pairs structured requisition scorecards and quote-verified resume
              assessments with strict tenant isolation and requisition-scoped candidate consent.
            </p>
          </div>

          <dl className="mt-10 space-y-5 border-t border-sidebar-border pt-8">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-hover text-sidebar-indicator">
                <Icon icon={Sparkles} size="md" />
              </span>
              <div>
                <dt className="text-sm font-medium text-sidebar-fg-strong">
                  Quote-verified AI assessments
                </dt>
                <dd className="mt-0.5 text-xs leading-relaxed text-sidebar-muted">
                  Every criterion rating requires exact resume evidence or is flagged for manual
                  recruiter verification.
                </dd>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-hover text-sidebar-indicator">
                <Icon icon={Users} size="md" />
              </span>
              <div>
                <dt className="text-sm font-medium text-sidebar-fg-strong">
                  Recruiter-in-the-loop control
                </dt>
                <dd className="mt-0.5 text-xs leading-relaxed text-sidebar-muted">
                  Candidates are never auto-rejected. Recruiters inspect evidence before any
                  shortlist or client submission.
                </dd>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-hover text-sidebar-indicator">
                <Icon icon={ShieldCheck} size="md" />
              </span>
              <div>
                <dt className="text-sm font-medium text-sidebar-fg-strong">
                  Tenant-isolated sessions
                </dt>
                <dd className="mt-0.5 text-xs leading-relaxed text-sidebar-muted">
                  Protected by stateful HttpOnly cookies, same-origin enforcement, and session-bound
                  CSRF tokens.
                </dd>
              </div>
            </div>
          </dl>
        </div>

        <p className="text-xs text-sidebar-muted">
          © {new Date().getFullYear()} TalentLens AI · Auditable hiring workflows
        </p>
      </aside>

      <main className="flex flex-col justify-center px-4 py-10 sm:px-6 lg:col-span-7 lg:px-12 xl:px-16">
        <div className="mx-auto w-full max-w-md">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <LogoMark className="size-8" />
            <Wordmark className="text-lg text-fg" />
          </div>

          <div className="mb-6">
            <h1 className="text-2xl font-semibold tracking-tight text-fg">
              Sign in to your workspace
            </h1>
            <p className="mt-1.5 text-sm text-fg-muted">
              Enter your organization and work credentials to access your secure recruitment
              workspace.
            </p>
          </div>

          <Card>
            <CardBody className="p-6 sm:p-7">
              {formError ? (
                <div
                  role="alert"
                  className="mb-5 flex items-start gap-2.5 rounded-md border border-danger-border bg-danger-soft px-3.5 py-3 text-sm text-danger"
                >
                  <Icon icon={AlertCircle} size="md" className="mt-0.5 shrink-0" />
                  <span>{formError}</span>
                </div>
              ) : null}

              <form onSubmit={(event) => void handleSubmit(event)} noValidate className="space-y-4">
                <Field
                  label="Organization"
                  hint="Your company or agency workspace identifier"
                  {...(fieldErrors.organization ? { error: fieldErrors.organization } : {})}
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
                      onChange={(event) => {
                        setOrganization(event.target.value);
                        if (fieldErrors.organization) {
                          setFieldErrors((prev) => {
                            const next = { ...prev };
                            delete next.organization;
                            return next;
                          });
                        }
                      }}
                    />
                  )}
                </Field>

                <Field
                  label="Work email"
                  {...(fieldErrors.email ? { error: fieldErrors.email } : {})}
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
                      onChange={(event) => {
                        setEmail(event.target.value);
                        if (fieldErrors.email) {
                          setFieldErrors((prev) => {
                            const next = { ...prev };
                            delete next.email;
                            return next;
                          });
                        }
                      }}
                    />
                  )}
                </Field>

                <Field
                  label="Password"
                  {...(fieldErrors.password ? { error: fieldErrors.password } : {})}
                >
                  {({ id, describedBy, invalid }) => (
                    <div className="relative">
                      <Input
                        id={id}
                        name="password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        placeholder="Enter your password"
                        value={password}
                        disabled={isSubmitting}
                        aria-invalid={invalid || undefined}
                        aria-describedby={describedBy}
                        className="h-9 pr-9"
                        onChange={(event) => {
                          setPassword(event.target.value);
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
                        onClick={() => setShowPassword((visible) => !visible)}
                        className="absolute inset-y-0 right-1 flex w-8 items-center justify-center rounded-sm text-fg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Icon icon={showPassword ? EyeOff : Eye} size="sm" />
                      </button>
                    </div>
                  )}
                </Field>

                <div className="pt-2">
                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    icon={Lock}
                    loading={isSubmitting}
                    className="w-full"
                  >
                    {isSubmitting ? 'Signing in…' : 'Sign in'}
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>

          <p className="mt-5 text-center text-xs text-fg-subtle">
            Sessions remain active for 8 hours and are protected by organization-scoped access
            controls.
          </p>
        </div>
      </main>
    </div>
  );
}
