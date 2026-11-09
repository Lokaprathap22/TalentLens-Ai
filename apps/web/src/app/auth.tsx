import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import type {
  AuthInitializationStage,
  AuthState,
  AuthenticatedUser,
  AuthenticatedUserResponseDto,
  LoginInput,
  UserRole,
} from '../features/auth/auth.types.js';
import {
  ApiError,
  apiClient,
  clearCsrfToken,
  fetchCsrfToken,
  isApiError,
  onUnauthorized,
} from '../lib/api-client.js';

const VALID_ROLES: ReadonlySet<UserRole> = new Set([
  'RECRUITER',
  'CLIENT_HIRING_MANAGER',
  'DELIVERY_HEAD',
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidAuthenticatedUser(value: unknown): value is AuthenticatedUser {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['userId'] === 'string' &&
    record['userId'].trim().length > 0 &&
    typeof record['organizationId'] === 'string' &&
    record['organizationId'].trim().length > 0 &&
    typeof record['organizationName'] === 'string' &&
    record['organizationName'].trim().length > 0 &&
    typeof record['email'] === 'string' &&
    record['email'].trim().length > 0 &&
    typeof record['role'] === 'string' &&
    VALID_ROLES.has(record['role'] as UserRole)
  );
}

function resolveInitializationErrorMessage(error: unknown, stage: AuthInitializationStage): string {
  if (isApiError(error)) {
    if (error.status === 0 || error.code === 'network_error') {
      return stage === 'csrf'
        ? 'Unable to reach TalentLens AI to complete workspace security initialization. Check your connection and retry.'
        : 'Unable to reach TalentLens AI to verify your workspace session. Check your connection and retry.';
    }
    if (error.status >= 500) {
      return stage === 'csrf'
        ? 'Your account is verified, but workspace security initialization is temporarily unavailable. Please retry shortly.'
        : 'Workspace session verification is temporarily unavailable. Please retry shortly.';
    }
  }
  return stage === 'csrf'
    ? 'Your account is verified, but workspace security initialization could not be completed. Please retry.'
    : 'Unable to verify your workspace session right now. Please retry.';
}

export function validateLoginInput(input: LoginInput): {
  organization: string;
  email: string;
  password: string;
} {
  const organization = input.organization.trim();
  const email = input.email.trim();
  const password = input.password;

  if (!organization || organization.length > 200) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Enter your organization name (up to 200 characters).',
    });
  }

  if (!email || email.length > 320 || !EMAIL_PATTERN.test(email)) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Enter a valid work email address.',
    });
  }

  if (!password || password.length === 0) {
    throw new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'Enter your password.',
    });
  }

  return { organization, email, password };
}

export interface AuthContextValue {
  state: AuthState;
  isInitializing: boolean;
  isLoggingOut: boolean;
  logoutError: string | null;
  clearLogoutError: () => void;
  login: (input: LoginInput) => Promise<AuthenticatedUser>;
  logout: () => Promise<void>;
  retryInitialization: () => Promise<void>;
  updateUser: (user: AuthenticatedUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const [isInitializing, setIsInitializing] = useState(true);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const operationVersionRef = useRef(0);
  const pendingUserRef = useRef<AuthenticatedUser | null>(null);

  const clearLogoutError = useCallback(() => {
    setLogoutError(null);
  }, []);

  const updateUser = useCallback((updatedUser: AuthenticatedUser) => {
    setState((current) => {
      if (current.status === 'authenticated') {
        return {
          ...current,
          user: updatedUser,
        };
      }
      return current;
    });
  }, []);

  const initializeCsrfForUser = useCallback(
    async (user: AuthenticatedUser, version: number): Promise<void> => {
      pendingUserRef.current = user;

      try {
        await fetchCsrfToken();
      } catch (error) {
        clearCsrfToken();
        if (!mountedRef.current || operationVersionRef.current !== version) {
          throw error;
        }

        if (isApiError(error) && error.status === 401) {
          pendingUserRef.current = null;
          setIsInitializing(false);
          setState({ status: 'unauthenticated' });
          throw error;
        }

        setIsInitializing(false);
        setState({
          status: 'initialization-error',
          stage: 'csrf',
          message: resolveInitializationErrorMessage(error, 'csrf'),
          user,
        });
        throw error;
      }

      if (!mountedRef.current || operationVersionRef.current !== version) {
        clearCsrfToken();
        return;
      }

      pendingUserRef.current = null;
      setIsInitializing(false);
      setState({
        status: 'authenticated',
        user,
      });
    },
    [],
  );

  const runSessionRestore = useCallback(
    async (version: number): Promise<void> => {
      setIsInitializing(true);

      let verifiedUser: AuthenticatedUser;
      try {
        const meResponse = await apiClient.get<AuthenticatedUserResponseDto>('/auth/me');
        if (!mountedRef.current || operationVersionRef.current !== version) {
          return;
        }

        if (!meResponse || !isValidAuthenticatedUser(meResponse.user)) {
          pendingUserRef.current = null;
          clearCsrfToken();
          setIsInitializing(false);
          setState({
            status: 'initialization-error',
            stage: 'session',
            message: resolveInitializationErrorMessage(
              new ApiError({
                status: 502,
                code: 'invalid_response_format',
                message: 'Received an unexpected response from the server.',
              }),
              'session',
            ),
          });
          return;
        }

        verifiedUser = meResponse.user;
      } catch (error) {
        clearCsrfToken();
        if (!mountedRef.current || operationVersionRef.current !== version) {
          return;
        }

        pendingUserRef.current = null;
        setIsInitializing(false);

        if (isApiError(error) && error.status === 401) {
          setState({ status: 'unauthenticated' });
          return;
        }

        setState({
          status: 'initialization-error',
          stage: 'session',
          message: resolveInitializationErrorMessage(error, 'session'),
        });
        return;
      }

      try {
        await initializeCsrfForUser(verifiedUser, version);
      } catch {
        // State is updated inside initializeCsrfForUser
      }
    },
    [initializeCsrfForUser],
  );

  useEffect(() => {
    mountedRef.current = true;
    const bootVersion = ++operationVersionRef.current;

    const unsubscribeUnauthorized = onUnauthorized(() => {
      if (!mountedRef.current) {
        return;
      }
      operationVersionRef.current += 1;
      pendingUserRef.current = null;
      clearCsrfToken();
      setIsInitializing(false);
      setIsLoggingOut(false);
      setLogoutError(null);
      setState((previous) =>
        previous.status === 'unauthenticated' ? previous : { status: 'unauthenticated' },
      );
    });

    void runSessionRestore(bootVersion);

    return () => {
      mountedRef.current = false;
      operationVersionRef.current += 1;
      unsubscribeUnauthorized();
    };
  }, [runSessionRestore]);

  const retryInitialization = useCallback(async (): Promise<void> => {
    const retryVersion = ++operationVersionRef.current;
    setLogoutError(null);
    clearCsrfToken();

    const pendingUser = pendingUserRef.current;
    if (pendingUser) {
      setIsInitializing(true);
      try {
        await initializeCsrfForUser(pendingUser, retryVersion);
      } catch {
        // State is updated inside initializeCsrfForUser
      }
      return;
    }

    setState({ status: 'loading' });
    await runSessionRestore(retryVersion);
  }, [initializeCsrfForUser, runSessionRestore]);

  const login = useCallback(
    async (input: LoginInput): Promise<AuthenticatedUser> => {
      const validated = validateLoginInput(input);
      const loginVersion = ++operationVersionRef.current;

      pendingUserRef.current = null;
      setIsInitializing(false);
      setLogoutError(null);
      clearCsrfToken();

      const response = await apiClient.post<AuthenticatedUserResponseDto>('/auth/login', validated);

      if (!mountedRef.current || operationVersionRef.current !== loginVersion) {
        clearCsrfToken();
        throw new ApiError({
          status: 401,
          code: 'unauthenticated',
          message: 'Authentication request was superseded.',
        });
      }

      if (!response || !isValidAuthenticatedUser(response.user)) {
        clearCsrfToken();
        throw new ApiError({
          status: 502,
          code: 'invalid_response_format',
          message: 'Received an unexpected authentication response from the server.',
        });
      }

      await initializeCsrfForUser(response.user, loginVersion);

      return response.user;
    },
    [initializeCsrfForUser],
  );

  const logout = useCallback(async (): Promise<void> => {
    const logoutVersion = ++operationVersionRef.current;
    setIsLoggingOut(true);
    setLogoutError(null);

    try {
      await apiClient.post<{ status: 'ok' }>('/auth/logout');
    } catch (error) {
      // If the backend reports 401, the session is already expired/revoked on the server.
      if (isApiError(error) && error.status === 401) {
        pendingUserRef.current = null;
        clearCsrfToken();
        if (mountedRef.current) {
          setIsInitializing(false);
          setIsLoggingOut(false);
          setState({ status: 'unauthenticated' });
        }
        return;
      }

      const safeMessage = isApiError(error)
        ? error.message
        : 'Unable to sign out right now. Please check your connection and try again.';

      if (mountedRef.current && operationVersionRef.current === logoutVersion) {
        setIsLoggingOut(false);
        setLogoutError(safeMessage);
      }
      throw error;
    }

    pendingUserRef.current = null;
    clearCsrfToken();
    if (mountedRef.current) {
      setIsInitializing(false);
      setIsLoggingOut(false);
      setState({ status: 'unauthenticated' });
    }
  }, []);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      state,
      isInitializing,
      isLoggingOut,
      logoutError,
      clearLogoutError,
      login,
      logout,
      retryInitialization,
      updateUser,
    }),
    [
      state,
      isInitializing,
      isLoggingOut,
      logoutError,
      clearLogoutError,
      login,
      logout,
      retryInitialization,
      updateUser,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>.');
  }
  return context;
}

export function useAuthOptional(): AuthContextValue | null {
  return useContext(AuthContext);
}
