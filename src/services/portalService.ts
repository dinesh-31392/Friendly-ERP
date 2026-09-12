import { getAll, getByTenant, getById, create, update, logAudit } from './db';
import { isApiEnabled, apiPortalLogin, apiPortalInvite } from './apiClient';
import type { PortalUser, Tenant, Lead, Broker } from '../types';
import { BRAND, portalHost } from '../config/brand';

// Portal auth lives under its OWN key so a portal login can never leak into
// the internal CRM session (and vice versa).
const PORTAL_AUTH_KEY = 'friendly_crm_portal_auth';

export interface PortalSession {
  portalUserId: string;
  tenantId: string;
  role: 'customer' | 'partner';
  token: string;
  expiresAt: number;
  /**
   * API mode only. There is no local portalUsers/tenants table to look the
   * session up in, so the login response's snapshot rides along in the session
   * itself. `token` is then the server-issued portal JWT (realm-scoped
   * `portal_*`), not a locally generated one.
   */
  snapshot?: { portalUser: PortalUser; tenant: Tenant };
}

function generateToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function generatePassword(): string {
  // Readable 8-char temp password, e.g. "kv7m2xq9"
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
}

// ── Session ──────────────────────────────────────────────────────────────────

export function getPortalSession(): PortalSession | null {
  try {
    const raw = localStorage.getItem(PORTAL_AUTH_KEY);
    if (!raw) return null;
    const session: PortalSession = JSON.parse(raw);
    if (Date.now() > session.expiresAt) {
      localStorage.removeItem(PORTAL_AUTH_KEY);
      return null;
    }
    return session;
  } catch { return null; }
}

export function portalLogout(): void {
  localStorage.removeItem(PORTAL_AUTH_KEY);
}

export function getPortalUser(): { portalUser: PortalUser; tenant: Tenant } | null {
  const session = getPortalSession();
  if (!session) return null;
  // API mode: the server already authenticated this session; the snapshot is
  // the only local record of who it belongs to. Revocation is still enforced
  // server-side — /api/portal/overview 401s if the account was deactivated.
  if (session.snapshot) return session.snapshot;
  const portalUser = getById<PortalUser>('portalUsers', session.portalUserId);
  const tenant = getById<Tenant>('tenants', session.tenantId);
  if (!portalUser || !tenant || !portalUser.active) { portalLogout(); return null; }
  // Suspension must cut existing sessions off too, not just new logins
  if (tenant.status === 'suspended') { portalLogout(); return null; }
  return { portalUser, tenant };
}

/** Portal login. When `tenantSlug` is present (subdomain / ?builder= link),
 *  only that builder's portal accounts are considered. */
/** API-mode login: the server verifies the argon2 hash and issues a realm-scoped
 *  JWT. Demo mode keeps the local-store path below, untouched. */
export async function portalLoginApi(
  email: string, password: string, tenantSlug?: string
): Promise<{ portalUser: PortalUser; tenant: Tenant } | { error: string }> {
  try {
    const res = await apiPortalLogin(email, password, tenantSlug);
    const portalUser = {
      id: res.portalUser.id, tenantId: res.tenant.id, role: res.portalUser.role,
      email: res.portalUser.email, name: res.portalUser.name, password: '',
      leadId: res.portalUser.leadId ?? undefined, brokerId: res.portalUser.brokerId ?? undefined,
      active: true, createdAt: new Date().toISOString(),
    } as PortalUser;
    const tenant = {
      id: res.tenant.id, name: res.tenant.name, slug: res.tenant.slug,
      currency: res.tenant.currency ?? 'INR', primaryColor: res.tenant.primaryColor ?? '#6366f1',
      logo: res.tenant.logo ?? undefined, status: 'active',
    } as Tenant;
    const session: PortalSession = {
      portalUserId: portalUser.id, tenantId: tenant.id, role: portalUser.role,
      token: res.token,
      // Mirrors the server's 24h portal JWT lifetime.
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      snapshot: { portalUser, tenant },
    };
    localStorage.setItem(PORTAL_AUTH_KEY, JSON.stringify(session));
    return { portalUser, tenant };
  } catch (err) {
    // The server returns a constant-shape 401 for every miss — don't embellish it.
    return { error: err instanceof Error ? err.message : 'Invalid email or password.' };
  }
}

export function portalLogin(
  email: string, password: string, tenantSlug?: string
): { portalUser: PortalUser; tenant: Tenant } | { error: string } {
  let candidates = getAll<PortalUser>('portalUsers')
    .filter(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password && u.active);
  if (tenantSlug) {
    const tenant = getAll<Tenant>('tenants').find(t => t.slug === tenantSlug);
    if (!tenant) return { error: 'Unknown builder portal.' };
    candidates = candidates.filter(u => u.tenantId === tenant.id);
  }
  const portalUser = candidates[0];
  if (!portalUser) return { error: 'Invalid email or password.' };
  const tenant = getById<Tenant>('tenants', portalUser.tenantId);
  if (!tenant) return { error: 'This portal is unavailable.' };
  if (tenant.status === 'suspended') return { error: 'This builder\'s portal is currently unavailable.' };

  const session: PortalSession = {
    portalUserId: portalUser.id,
    tenantId: tenant.id,
    role: portalUser.role,
    token: generateToken(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  localStorage.setItem(PORTAL_AUTH_KEY, JSON.stringify(session));
  update<PortalUser>('portalUsers', portalUser.id, { lastLoginAt: new Date().toISOString() });
  return { portalUser, tenant };
}

// ── Account provisioning (called from the CRM by builder staff) ─────────────

export function findPortalAccount(tenantId: string, opts: { leadId?: string; brokerId?: string }): PortalUser | undefined {
  return getByTenant<PortalUser>('portalUsers', tenantId).find(u =>
    (opts.leadId && u.leadId === opts.leadId) || (opts.brokerId && u.brokerId === opts.brokerId)
  );
}

/** Create (or reset) a customer portal account for a lead. Returns the
 *  credentials so the builder can share them with the customer. */
export async function inviteCustomer(
  tenantId: string, lead: Lead, actor: { id: string; name: string }
): Promise<{ email: string; password: string; isNew: boolean }> {
  if (isApiEnabled()) {
    // The server generates the temp password, stores only its argon2 hash, and
    // returns the plaintext exactly once.
    const res = await apiPortalInvite({ leadId: lead.id, email: lead.email || undefined });
    return { email: res.email, password: res.tempPassword, isNew: res.isNew };
  }
  const email = lead.email.toLowerCase();
  const password = generatePassword();
  const existing = findPortalAccount(tenantId, { leadId: lead.id });
  if (existing) {
    update<PortalUser>('portalUsers', existing.id, { password, active: true, email });
    logAudit({ tenantId, userId: actor.id, userName: actor.name, action: 'update', entity: 'portal_user', entityId: existing.id, details: `Reset customer portal access for "${lead.name}"` });
    return { email, password, isNew: false };
  }
  const created = create<PortalUser>('portalUsers', {
    id: '', tenantId, role: 'customer', email, password,
    name: lead.name, leadId: lead.id, active: true,
    createdAt: new Date().toISOString(),
  });
  logAudit({ tenantId, userId: actor.id, userName: actor.name, action: 'create', entity: 'portal_user', entityId: created.id, details: `Invited customer "${lead.name}" to the portal` });
  return { email, password, isNew: true };
}

/** Create (or reset) a channel-partner portal account for a broker. */
export async function invitePartner(
  tenantId: string, broker: Broker, actor: { id: string; name: string }
): Promise<{ email: string; password: string; isNew: boolean }> {
  if (isApiEnabled()) {
    const res = await apiPortalInvite({ brokerId: broker.id, email: broker.email || undefined });
    return { email: res.email, password: res.tempPassword, isNew: res.isNew };
  }
  const email = broker.email.toLowerCase();
  const password = generatePassword();
  const existing = findPortalAccount(tenantId, { brokerId: broker.id });
  if (existing) {
    update<PortalUser>('portalUsers', existing.id, { password, active: true, email });
    logAudit({ tenantId, userId: actor.id, userName: actor.name, action: 'update', entity: 'portal_user', entityId: existing.id, details: `Reset partner portal access for "${broker.name}"` });
    return { email, password, isNew: false };
  }
  const created = create<PortalUser>('portalUsers', {
    id: '', tenantId, role: 'partner', email, password,
    name: broker.name, brokerId: broker.id, active: true,
    createdAt: new Date().toISOString(),
  });
  logAudit({ tenantId, userId: actor.id, userName: actor.name, action: 'create', entity: 'portal_user', entityId: created.id, details: `Invited channel partner "${broker.name}" to the portal` });
  return { email, password, isNew: true };
}

// ── Branding / subdomain helpers ─────────────────────────────────────────────

/**
 * The slug is an IDENTITY key, not a label: it resolves the portal login
 * (?builder=<slug>), the public microsite (/site/<slug>/<id>), and the
 * white-label branding. findTenantBySlug below takes the FIRST match, so a
 * duplicate silently routes one builder's customers into another builder's
 * workspace — wrong logo/name/colour, and a valid customer's credentials
 * rejected because the lookup landed on the wrong tenant. Every write site MUST
 * go through uniqueSlug() / isSlugAvailable().
 */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Is `slug` free? Pass `exceptTenantId` so a tenant can re-save its own slug. */
export function isSlugAvailable(slug: string, exceptTenantId?: string): boolean {
  return !getAll<Tenant>('tenants').some(t => t.slug === slug && t.id !== exceptTenantId);
}

/** First free slug in the `base`, `base-2`, `base-3`… sequence. */
export function uniqueSlug(base: string, exceptTenantId?: string): string {
  const root = slugify(base) || 'builder';
  let slug = root;
  for (let n = 2; !isSlugAvailable(slug, exceptTenantId); n++) slug = `${root}-${n}`;
  return slug;
}

export function findTenantBySlug(slug: string): Tenant | undefined {
  return getAll<Tenant>('tenants').find(t => t.slug === slug);
}

export function isPremium(tenant: Tenant | null): boolean {
  return tenant?.plan === 'Growth' || tenant?.plan === 'Enterprise';
}

/** The portal URL for a builder. Premium builders get their branded
 *  subdomain; others share the generic portal with a ?builder= link. */
export function portalUrl(tenant: Tenant): string {
  return isPremium(tenant)
    ? `https://${portalHost(tenant.slug)}/portal`
    : `https://app.${BRAND.portalDomain}/portal?builder=${tenant.slug}`;
}

/** In-app portal link (works in this demo build). */
export function portalPath(tenant: Tenant): string {
  return `/portal?builder=${tenant.slug}`;
}
