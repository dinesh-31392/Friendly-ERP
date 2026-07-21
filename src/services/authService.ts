import { getAll, getByField, create, getById, update, logAudit } from './db';
import { getLegacyBranch } from './branchService';
import { uniqueSlug } from './portalService';
import { isTrialExpired } from './planService';
import type { User, Tenant, Role } from '../types';

const AUTH_KEY = 'friendly_crm_auth';

export interface AuthSession {
  userId: string;
  tenantId: string;
  token: string;
  expiresAt: number;
}

function generateToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

export function saveSession(session: AuthSession): void {
  localStorage.setItem(AUTH_KEY, JSON.stringify(session));
}

export function getSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const session: AuthSession = JSON.parse(raw);
    if (Date.now() > session.expiresAt) {
      localStorage.removeItem(AUTH_KEY);
      return null;
    }
    return session;
  } catch { return null; }
}

export function clearSession(): void {
  localStorage.removeItem(AUTH_KEY);
}

export function updateSessionUser(userId: string): void {
  const session = getSession();
  if (!session) return;
  saveSession({ ...session, userId });
}

export function login(email: string, password: string): { user: User; tenant: Tenant } | null {
  const users = getAll<User>('users');
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password && u.active);
  if (!user) return null;

  const tenant = getById<Tenant>('tenants', user.tenantId);
  if (!tenant) return null;

  const session: AuthSession = {
    userId: user.id,
    tenantId: user.tenantId,
    token: generateToken(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  };
  saveSession(session);
  return { user, tenant };
}

export function register(
  name: string, email: string, password: string, phone: string, company: string,
  country: string = 'India', currency: string = 'INR'
): { user: User; tenant: Tenant } | null {
  // Check if email already exists
  const existing = getAll<User>('users').find(u => u.email.toLowerCase() === email.toLowerCase());
  if (existing) return null;

  // Create a new tenant on a 14-day trial
  const tenant: Tenant = {
    id: '', name: company, company: company, logo: '',
    brandVoice: 'Professional, warm, and trustworthy.',
    audience: 'Home buyers',
    channels: ['WhatsApp', 'Email'], plan: 'Starter',
    status: 'trial',
    trialEndsAt: new Date(Date.now() + 14 * 86400000).toISOString(),
    // Self-serve signups now require super-admin approval before they can sign
    // in. The new workspace lands under Head Office in a 'pending' state and
    // appears in the platform "Pending Approvals" queue; the login gate blocks
    // access until a super admin activates it. (Tech-team onboarding is also
    // 'pending'; only a super admin onboarding directly is auto-approved.)
    branchId: getLegacyBranch()?.id,
    approvalStatus: 'pending',
    // Assign the slug HERE. register() used to omit it entirely and let
    // db.applyUpgrades() back-fill one from the company name on a later page
    // load — which had no uniqueness check, so two builders signing up with the
    // same company name silently collided on one subdomain.
    slug: uniqueSlug(company),
    country, currency,
    email, phone, address: '',
    createdAt: new Date().toISOString(),
  };
  const createdTenant = create<Tenant>('tenants', tenant);

  // Create user as builder_admin
  const user: User = {
    id: '', tenantId: createdTenant.id, name, email: email.toLowerCase(),
    password, role: 'builder_admin', avatar: '', phone, active: true,
    branchId: createdTenant.branchId,
    createdAt: new Date().toISOString(),
  };
  const createdUser = create<User>('users', user);

  // IMPORTANT: no session is created here. A pending signup must NOT be logged
  // in — the caller surfaces an "awaiting approval" message instead. The
  // session is only minted later, on a successful login after approval.
  logAudit({
    tenantId: createdTenant.id, userId: createdUser.id, userName: createdUser.name,
    action: 'submit', entity: 'tenant', entityId: createdTenant.id,
    details: `Self-serve signup "${company}" submitted — awaiting super-admin approval`,
  });
  return { user: createdUser, tenant: createdTenant };
}

/**
 * Forgot-password reset for the localStorage demo store (passwords are stored
 * in plain text here; the production Fastify backend uses argon2id). Finds an
 * active account by email and sets a new password. Returns false when no active
 * account matches — the UI surfaces a neutral message either way.
 */
export function changePasswordByEmail(email: string, newPassword: string): boolean {
  const user = getAll<User>('users').find(
    u => u.email.toLowerCase() === email.toLowerCase() && u.active
  );
  if (!user) return false;
  // Platform staff are NOT resettable from the public login screen. This flow
  // proves no identity (the demo store has no email token / OTP), so allowing it
  // would let any visitor seize the whole platform by resetting the super admin.
  // Their credentials are managed in Platform Control → Credentials & Access.
  // Returning false surfaces the same neutral "no account found" copy, so this
  // also avoids confirming that the address exists.
  if (user.role === 'super_admin' || user.role === 'tech_team') return false;
  // A self-service reset also clears any pending forced-change flag.
  update<User>('users', user.id, { password: newPassword, mustChangePassword: false });
  logAudit({
    tenantId: user.tenantId, userId: user.id, userName: user.name,
    action: 'update', entity: 'user', entityId: user.id,
    details: 'Password reset via forgot-password flow',
  });
  return true;
}

/**
 * Admin action: issue a TEMPORARY password for any account and flag it so the
 * user must choose a new one on next sign-in. This replaces the old
 * "reveal / copy the stored password" console: an admin can still grant access
 * to any account, but never sees a standing password, and the temp value is
 * useful exactly once. Returns the temp password to hand over (once), or null.
 */
export function setTemporaryPassword(userId: string, tempPassword: string): boolean {
  const user = getById<User>('users', userId);
  if (!user) return false;
  update<User>('users', userId, { password: tempPassword, mustChangePassword: true });
  logAudit({
    tenantId: 'platform', userId: user.id, userName: user.name,
    action: 'update', entity: 'user', entityId: user.id,
    details: `Issued a temporary password for ${user.email} (${user.role}) — user must reset on next login`,
  });
  return true;
}

/**
 * The user setting their own new password, e.g. after a forced reset. Clears the
 * mustChangePassword flag. Enforces a minimum length at the service layer too.
 */
export function changeOwnPassword(userId: string, newPassword: string): { ok: boolean; error?: string } {
  if (newPassword.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
  const user = getById<User>('users', userId);
  if (!user) return { ok: false, error: 'Account not found.' };
  update<User>('users', userId, { password: newPassword, mustChangePassword: false });
  logAudit({
    tenantId: user.tenantId, userId: user.id, userName: user.name,
    action: 'update', entity: 'user', entityId: user.id,
    details: 'User set a new password',
  });
  return { ok: true };
}

/**
 * True when this install has no accounts at all — i.e. a fresh deployment.
 * The build ships with NO seed data and NO default credentials, so the login
 * page uses this to run first-run setup instead of showing a sign-in form
 * nobody could possibly satisfy.
 */
export function needsSetup(): boolean {
  return getAll<User>('users').length === 0;
}

/**
 * Create the very first platform administrator, once, with a password the
 * operator chooses. Replaces the old seeded superadmin@friendlycrm.com /
 * password123 backdoor.
 *
 * Guarded by needsSetup(): the moment any account exists this is a no-op, so it
 * can never be replayed to mint a second super admin on a live install. The
 * super admin gets its own platform tenant (never a builder workspace) — the
 * old seed put it INSIDE the demo builder tenant, which is what let a workspace
 * user reach it via the role switcher.
 */
export function createPlatformAdmin(
  name: string, email: string, password: string,
): { user: User; tenant: Tenant } | null {
  if (!needsSetup()) return null;

  const tenant = create<Tenant>('tenants', {
    id: '', name: 'Platform', company: 'Platform', logo: '',
    brandVoice: '', audience: '', channels: [],
    plan: 'Enterprise', status: 'active',
    approvalStatus: 'approved',
    branchId: getLegacyBranch()?.id,
    slug: 'platform',
    country: 'India', currency: 'INR',
    email: email.toLowerCase(), phone: '', address: '',
    createdAt: new Date().toISOString(),
  });

  const user = create<User>('users', {
    id: '', tenantId: tenant.id, name, email: email.toLowerCase(),
    password, role: 'super_admin', avatar: '', phone: '', active: true,
    branchId: tenant.branchId,
    createdAt: new Date().toISOString(),
  });

  logAudit({
    tenantId: 'platform', userId: user.id, userName: user.name,
    action: 'create', entity: 'user', entityId: user.id,
    details: `First-run setup: platform administrator ${user.email} created`,
  });
  return { user, tenant };
}

export function logout(): void {
  clearSession();
}

export function getCurrentUser(): { user: User; tenant: Tenant } | null {
  const session = getSession();
  if (!session) return null;
  const user = getById<User>('users', session.userId);
  const tenant = getById<Tenant>('tenants', session.tenantId);
  if (!user || !tenant) { clearSession(); return null; }
  // Re-enforce lifecycle on every restore (page reload), not just fresh login:
  // suspension or approval revocation must cut off an existing session too.
  // Platform staff (super_admin / tech_team) are never gated; legacy
  // (undefined) approvalStatus counts as approved.
  const isPlatformStaff = user.role === 'super_admin' || user.role === 'tech_team';
  if (!isPlatformStaff && (
    tenant.status === 'suspended' ||
    tenant.approvalStatus === 'pending' ||
    tenant.approvalStatus === 'rejected' ||
    // An expired trial is a closed workspace until it's upgraded. This was
    // never enforced anywhere — isTrialExpired had zero call sites — so a
    // lapsed trial kept full access indefinitely. isTrialExpired only fires for
    // status==='trial' with a past trialEndsAt, so paid/active tenants and the
    // seeded demo workspace are unaffected.
    isTrialExpired(tenant)
  )) {
    clearSession();
    return null;
  }
  return { user, tenant };
}

export function getTenantUsers(tenantId: string): User[] {
  return getByField<User>('users', 'tenantId', tenantId).map(({ password, ...u }) => u as User);
}

export function getTenantUsersWithPasswords(tenantId: string): User[] {
  return getByField<User>('users', 'tenantId', tenantId);
}

export function hasPermission(user: User, action: string): boolean {
  const permissions: Record<Role, string[]> = {
    super_admin: ['*'],
    // Branch-scoped platform staff: reach the platform console and onboard
    // builders into their branch, but cannot approve, suspend, delete, or
    // change global settings (those stay platform_admin / super_admin only).
    tech_team: ['view_dashboard', 'view_platform', 'manage_branch'],
    builder_admin: [
      'view_dashboard', 'view_leads', 'manage_leads', 'manage_own_leads', 'assign_leads', 'add_notes',
      'view_inventory', 'manage_inventory', 'view_reports', 'manage_settings', 'manage_tenant',
      'manage_users', 'manage_projects', 'view_projects', 'view_sales_performance', 'approve_bookings', 'view_campaigns', 'manage_campaigns', 'view_finance',
      'manage_finance', 'view_messages', 'send_messages', 'view_documents', 'manage_documents',
      'view_service', 'manage_service', 'view_calendar', 'schedule_visits', 'use_ai_studio',
      'create_bookings', 'view_audit_log', 'view_bookings', 'manage_bookings',
      'view_brokers', 'manage_brokers',
      'view_execution', 'manage_execution', 'approve_change_orders',
      'view_procurement', 'manage_procurement', 'approve_purchase_orders',
    ],
    sales_manager: [
      'view_dashboard', 'view_leads', 'manage_leads', 'assign_leads', 'add_notes', 'manage_team',
      'view_reports', 'view_inventory', 'view_projects', 'view_sales_performance', 'view_finance', 'view_messages', 'send_messages',
      'view_documents', 'view_service', 'manage_service', 'view_calendar', 'schedule_visits',
      'use_ai_studio', 'create_bookings', 'approve_reminders', 'view_campaigns', 'manage_campaigns',
      'view_bookings', 'manage_bookings', 'view_brokers',
      // Read-only construction visibility so sales can answer "how far along is my flat?"
      'view_execution',
    ],
    sales_executive: [
      'view_dashboard', 'view_leads', 'manage_own_leads', 'add_notes',
      'view_inventory', 'view_projects', 'view_messages', 'send_messages', 'view_documents',
      'view_calendar', 'schedule_visits', 'use_ai_studio', 'create_bookings',
      'view_bookings',
    ],
    // Field staff: everything on the construction side, nothing on the sales
    // pipeline or finance. Raises POs / change orders but cannot approve them.
    site_engineer: [
      'view_dashboard', 'view_projects',
      'view_execution', 'manage_execution',
      'view_procurement', 'manage_procurement',
      'view_documents', 'view_calendar', 'view_messages', 'send_messages',
    ],
  };
  const perms = permissions[user.role];
  if (!perms) return false;
  if (perms.includes('*')) return true;
  return perms.includes(action);
}
