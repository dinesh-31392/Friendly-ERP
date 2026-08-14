import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import type { User, Tenant } from '../types';
import * as authService from '../services/authService';
import { isApiEnabled, apiLogin, apiVerifyLoginCode, isMfaChallenge, clearApiToken, apiLogout, getStoredApiSession } from '../services/apiClient';
import { hydrateLedger } from '../services/accountsService';
import { initializeDatabase } from '../services/db';
import { ensureBranchMigration } from '../services/branchService';
import { isTrialExpired } from '../services/planService';

interface AuthContextType {
  user: User | null;
  tenant: Tenant | null;
  users: User[];
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string, workspaceCode?: string) =>
    Promise<{ success: boolean; error?: string; mfa?: { challengeId: string; sentTo: string } }>;
  /** Second step of an MFA login — exchange the emailed code for a session. */
  verifyLoginCode: (challengeId: string, code: string) => Promise<{ success: boolean; error?: string }>;
  register: (name: string, email: string, password: string, phone: string, company: string, country?: string, currency?: string) => Promise<{ success: boolean; error?: string; pending?: boolean }>;
  resetPassword: (email: string, newPassword: string) => { success: boolean; error?: string };
  changeOwnPassword: (newPassword: string) => { success: boolean; error?: string };
  logout: () => void;
  /** Ends every session for this user, not just this device. */
  logoutEverywhere: () => void;
  hasPermission: (action: string) => boolean;
  refreshSession: () => void;
}

const AuthContext = createContext<AuthContextType>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // A fresh deployment ships with zero accounts (no seed data, no default
  // credentials), so the login page must offer setup rather than a sign-in form.

  // Initialize DB and restore session. API mode restores the JWT session
  // captured at login so a page refresh doesn't log the user out.
  useEffect(() => {
    initializeDatabase();
    ensureBranchMigration();   // non-destructive: legacy tenants → Head Office / approved
    const apiSession = getStoredApiSession();
    if (apiSession) {
      setUser(apiSession.user);
      setTenant(apiSession.tenant);
    } else {
      const session = authService.getCurrentUser();
      if (session) {
        setUser(session.user);
        setTenant(session.tenant);
        loadTenantUsers(session.tenant.id);
      }
    }
    // No browser-side first-run setup exists any more — the platform admin is
    // created server-side by the seed bootstrap.
    setIsLoading(false);
  }, []);

  // API mode: load the server ledger (chart of accounts + posted journal
  // entries) into the local read-cache whenever a tenant session is active, so
  // the synchronous finance statements (trial balance / P&L / fund flow, on
  // Accounts, Billing, Dashboard, Reports) fold over server-authoritative data.
  // Runs on login and on refresh-restored sessions. No-op in demo mode.
  useEffect(() => {
    if (!isApiEnabled() || !tenant?.id) return;
    hydrateLedger(tenant.id).catch(() => { /* pages fall back to whatever's cached */ });
  }, [tenant?.id]);

  const verifyLoginCode = useCallback(async (challengeId: string, code: string) => {
    try {
      const res = await apiVerifyLoginCode(challengeId, code);
      setUser(res.user);
      setTenant(res.tenant);
      authService.rememberAccount(res.user, res.tenant);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Could not verify the code' };
    }
  }, []);

  const loadTenantUsers = (tenantId: string) => {
    const tenantUsers = authService.getTenantUsers(tenantId);
    setUsers(tenantUsers);
  };

  const login = useCallback(async (email: string, password: string, workspaceCode?: string) => {
    // Feature flag: when an API URL is configured, authenticate against the
    // Fastify backend (JWT) instead of the localStorage demo store.
    if (isApiEnabled()) {
      try {
        // The workspace code IS the tenant slug the API disambiguates with.
        const apiResult = await apiLogin(email, password, workspaceCode?.trim() || undefined);
        // The password was right, but this account carries a second factor. No
        // session exists yet — the caller has to collect the emailed code.
        if (isMfaChallenge(apiResult)) {
          return { success: false, mfa: { challengeId: apiResult.challengeId, sentTo: apiResult.sentTo } };
        }
        setUser(apiResult.user);
        setTenant(apiResult.tenant);
        authService.rememberAccount(apiResult.user, apiResult.tenant);
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'API login failed' };
      }
    }

    const result = authService.login(email, password, workspaceCode);
    if (result && 'error' in result) {
      return { success: false, error: result.error };
    }
    if (!result) {
      return { success: false, error: 'Invalid email or password. Please try again.' };
    }
    // Suspended workspaces cannot sign in (super admins are never suspended)
    if (result.tenant.status === 'suspended' && result.user.role !== 'super_admin') {
      authService.logout();
      return { success: false, error: 'This workspace has been suspended. Please contact support.' };
    }
    // Approval gate: a builder workspace only opens once a super admin has
    // approved it. Platform staff (super_admin / tech_team) are never gated;
    // legacy tenants default to approved and are unaffected.
    const isPlatformStaff = result.user.role === 'super_admin' || result.user.role === 'tech_team';
    if (!isPlatformStaff && result.tenant.approvalStatus === 'pending') {
      authService.logout();
      return { success: false, error: 'Your workspace is pending approval. You\'ll be able to sign in once our team activates it.' };
    }
    if (!isPlatformStaff && result.tenant.approvalStatus === 'rejected') {
      authService.logout();
      return { success: false, error: 'This workspace application was not approved. Please contact support.' };
    }
    // Trial expiry is the revenue gate and was never enforced: isTrialExpired
    // had no call sites anywhere, so a lapsed 14-day trial kept full access
    // forever. getCurrentUser() re-checks this on every reload too.
    if (!isPlatformStaff && isTrialExpired(result.tenant)) {
      authService.logout();
      return { success: false, error: 'Your free trial has ended. Contact us to activate your workspace.' };
    }
    setUser(result.user);
    setTenant(result.tenant);
    loadTenantUsers(result.tenant.id);
    return { success: true };
  }, []);

  const register = useCallback(async (name: string, email: string, password: string, phone: string, company: string, country?: string, currency?: string) => {
    if (password.length < 6) {
      return { success: false, error: 'Password must be at least 6 characters.' };
    }
    const result = authService.register(name, email, password, phone, company, country, currency);
    if (!result) {
      return { success: false, error: 'An account with this email already exists.' };
    }
    // Self-serve signups are created PENDING and must be approved by a super
    // admin before they can sign in — never auto-login them. (A future
    // auto-approved path, e.g. super-admin-created, would fall through and log
    // in as before.)
    if (result.tenant.approvalStatus === 'pending') {
      return { success: true, pending: true };
    }
    setUser(result.user);
    setTenant(result.tenant);
    loadTenantUsers(result.tenant.id);
    return { success: true };
  }, []);

  const changeOwnPassword = useCallback((newPassword: string) => {
    if (!user) return { success: false, error: 'Not signed in.' };
    const res = authService.changeOwnPassword(user.id, newPassword);
    if (!res.ok) return { success: false, error: res.error };
    // Reflect the cleared flag + new password in the in-memory session at once.
    setUser({ ...user, password: newPassword, mustChangePassword: false });
    return { success: true };
  }, [user]);

  const resetPassword = useCallback((email: string, newPassword: string) => {
    // API mode delegates identity to the backend; local reset only applies to
    // the demo store.
    if (isApiEnabled()) {
      return { success: false, error: 'Password resets are handled by your administrator in this environment.' };
    }
    if (!email) {
      return { success: false, error: 'Please enter your account email.' };
    }
    if (newPassword.length < 6) {
      return { success: false, error: 'New password must be at least 6 characters.' };
    }
    const ok = authService.changePasswordByEmail(email, newPassword);
    if (!ok) {
      return { success: false, error: 'No active account was found with that email address.' };
    }
    return { success: true };
  }, []);

  // Deliberately takes no arguments. It is passed straight to onClick in a
  // couple of places, and a signature with an optional first parameter would
  // quietly receive a MouseEvent there — which typechecks as nothing useful and
  // reads as a scope. Signing out everywhere is its own function below.
  const endSession = useCallback((scope: 'this' | 'all') => {
    // Tell the server first, while the token is still usable — clearing it
    // locally would leave nothing to authenticate the revocation with. Not
    // awaited: the UI must sign out instantly and must still work offline, and
    // apiLogout is written never to throw.
    void apiLogout(scope);
    authService.logout();
    clearApiToken();
    setUser(null);
    setTenant(null);
    setUsers([]);
  }, []);

  const logout = useCallback(() => endSession('this'), [endSession]);
  const logoutEverywhere = useCallback(() => endSession('all'), [endSession]);

  const hasPermission = useCallback((action: string): boolean => {
    if (!user) return false;
    return authService.hasPermission(user, action);
  }, [user]);

  // Re-read user + tenant from storage so UI reflects saves immediately.
  // In API mode the JWT session is the identity source — a local re-read
  // would clobber it with stale demo data, so it is skipped.
  const refreshSession = useCallback(() => {
    if (getStoredApiSession()) return;
    const session = authService.getCurrentUser();
    if (session) {
      setUser(session.user);
      setTenant(session.tenant);
      loadTenantUsers(session.tenant.id);
    }
  }, []);

  return (
    <AuthContext.Provider value={{
      user, tenant, users, isAuthenticated: !!user, isLoading,
      login, verifyLoginCode, register, resetPassword, changeOwnPassword, logout, logoutEverywhere, hasPermission, refreshSession
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
