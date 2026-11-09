import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Mail,
  Save,
} from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { useAuth } from '../../app/auth.js';
import { useWorkspace } from '../../app/workspace.js';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Icon,
  Input,
} from '../../components/ui/index.js';
import { apiClient, isApiError } from '../../lib/api-client.js';
import type { AuthenticatedUserResponseDto } from '../../lib/api-client.js';
import { PageHeader } from '../../layouts/PageHeader.js';

export function SettingsPage(): React.JSX.Element {
  const { user, organization } = useWorkspace();
  const auth = useAuth();

  // Profile section state
  const initialName = user.name !== user.email ? user.name : '';
  const [displayName, setDisplayName] = useState(initialName);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  // Security section state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordFieldErrors, setPasswordFieldErrors] = useState<Record<string, string>>({});

  const handleProfileSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setProfileSuccess(null);
    setProfileError(null);

    const trimmed = displayName.trim();
    if (!trimmed) {
      setProfileError('Display name cannot be blank.');
      return;
    }

    setIsSavingProfile(true);
    try {
      const response = await apiClient.patch<AuthenticatedUserResponseDto>('/auth/profile', {
        name: trimmed,
      });
      auth.updateUser(response.user);
      setIsSavingProfile(false);
      setProfileSuccess('Profile display name updated successfully.');
    } catch (err: unknown) {
      setIsSavingProfile(false);
      if (isApiError(err)) {
        setProfileError(err.message || 'Unable to update profile name.');
        return;
      }
      setProfileError('Network error while updating profile. Please try again.');
    }
  };

  const handlePasswordSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPasswordSuccess(null);
    setPasswordError(null);

    const errors: Record<string, string> = {};
    if (!currentPassword) {
      errors['currentPassword'] = 'Current password is required.';
    }
    if (!newPassword || newPassword.length < 8) {
      errors['newPassword'] = 'New password must be at least 8 characters long.';
    }
    if (newPassword !== confirmPassword) {
      errors['confirmPassword'] = 'New passwords do not match.';
    }

    if (Object.keys(errors).length > 0) {
      setPasswordFieldErrors(errors);
      return;
    }
    setPasswordFieldErrors({});
    setIsChangingPassword(true);

    try {
      await apiClient.post('/auth/password/change', {
        currentPassword,
        newPassword,
      });

      setIsChangingPassword(false);
      setPasswordSuccess('Password updated successfully. Other active sessions have been revoked.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: unknown) {
      setIsChangingPassword(false);
      if (isApiError(err)) {
        if (err.code === 'current_password_incorrect') {
          setPasswordError('Current password is incorrect. Please verify and try again.');
          return;
        }
        setPasswordError(err.message || 'Failed to update password.');
        return;
      }
      setPasswordError('Network error while changing password. Please try again.');
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Account Settings"
        description="Manage your recruiter profile identity, organization workspace details, and security credentials."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Profile Card */}
        <Card>
          <CardHeader
            title="Profile Identity"
            description="Your name and contact details visible across candidate evaluations and client submissions."
          />
          <CardBody className="p-6">
            {profileSuccess ? (
              <div
                role="status"
                className="mb-4 flex items-start gap-2.5 rounded-md border border-accent-border bg-accent-soft px-3.5 py-3 text-sm text-accent"
              >
                <Icon icon={CheckCircle2} size="md" className="mt-0.5 shrink-0" />
                <span>{profileSuccess}</span>
              </div>
            ) : null}

            {profileError ? (
              <div
                role="alert"
                className="mb-4 flex items-start gap-2.5 rounded-md border border-danger-border bg-danger-soft px-3.5 py-3 text-sm text-danger"
              >
                <Icon icon={AlertCircle} size="md" className="mt-0.5 shrink-0" />
                <span>{profileError}</span>
              </div>
            ) : null}

            <form
              onSubmit={(event) => void handleProfileSubmit(event)}
              noValidate
              className="space-y-4"
            >
              <Field label="Display name" hint="Your preferred public recruiter name">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    name="displayName"
                    type="text"
                    placeholder="e.g. Jane Doe"
                    value={displayName}
                    disabled={isSavingProfile}
                    aria-describedby={describedBy}
                    className="h-9"
                    onChange={(e) => {
                      setDisplayName(e.target.value);
                      if (profileSuccess) setProfileSuccess(null);
                    }}
                  />
                )}
              </Field>

              <Field label="Work email" hint="Unique login identifier (managed by organization)">
                {({ id, describedBy }) => (
                  <div className="relative">
                    <Input
                      id={id}
                      name="email"
                      type="email"
                      value={user.email}
                      readOnly
                      disabled
                      aria-describedby={describedBy}
                      className="h-9 cursor-not-allowed bg-surface-muted pr-9 text-fg-muted"
                    />
                    <span className="absolute inset-y-0 right-3 flex items-center text-fg-subtle">
                      <Icon icon={Mail} size="sm" />
                    </span>
                  </div>
                )}
              </Field>

              <div className="rounded-md border border-border bg-surface-muted/50 p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
                    <Icon icon={Building2} size="sm" className="text-fg-subtle" />
                    Organization
                  </span>
                  <span className="text-xs font-semibold text-fg">{organization.name}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-fg-muted">Workspace Role</span>
                  <Badge tone="accent">{user.roleLabel}</Badge>
                </div>
              </div>

              <div className="pt-2">
                <Button
                  type="submit"
                  variant="primary"
                  icon={Save}
                  loading={isSavingProfile}
                  disabled={!displayName.trim()}
                >
                  {isSavingProfile ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        {/* Security & Credentials Card */}
        <Card>
          <CardHeader
            title="Security & Password"
            description="Update your workspace password. Changing credentials revokes any other active sessions."
          />
          <CardBody className="p-6">
            {passwordSuccess ? (
              <div
                role="status"
                className="mb-4 flex items-start gap-2.5 rounded-md border border-accent-border bg-accent-soft px-3.5 py-3 text-sm text-accent"
              >
                <Icon icon={CheckCircle2} size="md" className="mt-0.5 shrink-0" />
                <span>{passwordSuccess}</span>
              </div>
            ) : null}

            {passwordError ? (
              <div
                role="alert"
                className="mb-4 flex items-start gap-2.5 rounded-md border border-danger-border bg-danger-soft px-3.5 py-3 text-sm text-danger"
              >
                <Icon icon={AlertCircle} size="md" className="mt-0.5 shrink-0" />
                <span>{passwordError}</span>
              </div>
            ) : null}

            <form
              onSubmit={(event) => void handlePasswordSubmit(event)}
              noValidate
              className="space-y-4"
            >
              <Field
                label="Current password"
                {...(passwordFieldErrors['currentPassword']
                  ? { error: passwordFieldErrors['currentPassword'] }
                  : {})}
              >
                {({ id, describedBy, invalid }) => (
                  <div className="relative">
                    <Input
                      id={id}
                      name="currentPassword"
                      type={showCurrentPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      placeholder="Enter current password"
                      value={currentPassword}
                      disabled={isChangingPassword}
                      aria-invalid={invalid || undefined}
                      aria-describedby={describedBy}
                      className="h-9 pr-9"
                      onChange={(e) => {
                        setCurrentPassword(e.target.value);
                        if (passwordFieldErrors['currentPassword']) {
                          setPasswordFieldErrors((prev) => ({ ...prev, currentPassword: '' }));
                        }
                      }}
                    />
                    <button
                      type="button"
                      aria-label={
                        showCurrentPassword ? 'Hide current password' : 'Show current password'
                      }
                      aria-pressed={showCurrentPassword}
                      disabled={isChangingPassword}
                      onClick={() => setShowCurrentPassword((v) => !v)}
                      className="absolute inset-y-0 right-1 flex w-8 items-center justify-center rounded-sm text-fg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Icon icon={showCurrentPassword ? EyeOff : Eye} size="sm" />
                    </button>
                  </div>
                )}
              </Field>

              <Field
                label="New password"
                hint="At least 8 characters"
                {...(passwordFieldErrors['newPassword']
                  ? { error: passwordFieldErrors['newPassword'] }
                  : {})}
              >
                {({ id, describedBy, invalid }) => (
                  <div className="relative">
                    <Input
                      id={id}
                      name="newPassword"
                      type={showNewPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      placeholder="Enter new password"
                      value={newPassword}
                      disabled={isChangingPassword}
                      aria-invalid={invalid || undefined}
                      aria-describedby={describedBy}
                      className="h-9 pr-9"
                      onChange={(e) => {
                        setNewPassword(e.target.value);
                        if (passwordFieldErrors['newPassword']) {
                          setPasswordFieldErrors((prev) => ({ ...prev, newPassword: '' }));
                        }
                      }}
                    />
                    <button
                      type="button"
                      aria-label={showNewPassword ? 'Hide new password' : 'Show new password'}
                      aria-pressed={showNewPassword}
                      disabled={isChangingPassword}
                      onClick={() => setShowNewPassword((v) => !v)}
                      className="absolute inset-y-0 right-1 flex w-8 items-center justify-center rounded-sm text-fg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Icon icon={showNewPassword ? EyeOff : Eye} size="sm" />
                    </button>
                  </div>
                )}
              </Field>

              <Field
                label="Confirm new password"
                {...(passwordFieldErrors['confirmPassword']
                  ? { error: passwordFieldErrors['confirmPassword'] }
                  : {})}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    name="confirmPassword"
                    type={showNewPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="Confirm new password"
                    value={confirmPassword}
                    disabled={isChangingPassword}
                    aria-invalid={invalid || undefined}
                    aria-describedby={describedBy}
                    className="h-9"
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      if (passwordFieldErrors['confirmPassword']) {
                        setPasswordFieldErrors((prev) => ({ ...prev, confirmPassword: '' }));
                      }
                    }}
                  />
                )}
              </Field>

              <div className="pt-2">
                <Button
                  type="submit"
                  variant="primary"
                  icon={KeyRound}
                  loading={isChangingPassword}
                  disabled={!currentPassword || !newPassword || !confirmPassword}
                >
                  {isChangingPassword ? 'Updating…' : 'Change password'}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
