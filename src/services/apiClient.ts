import type { Lead, Tenant, User, Role } from '../types';

/**
 * Feature-flagged API client for the Fastify backend (server/).
 *
 * The flag is the presence of an API URL:
 *   localStorage.setItem('friendly_crm_api_url', 'http://localhost:4000')
 * Remove the key (or leave it unset) and the SPA runs 100% on localStorage
 * exactly as before — zero behavior change with the flag off.
 */
const API_URL_KEY = 'friendly_crm_api_url';
const TOKEN_KEY = 'friendly_crm_api_token';
const SESSION_KEY = 'friendly_crm_api_session';

/**
 * The build-time default. A production build made with VITE_API_URL set runs in
 * API mode automatically — the server-authoritative deployment where tenant
 * isolation and RBAC are enforced by Postgres, not the browser. An empty string
 * means same-origin (`/api` behind nginx), which is the recommended value; a
 * missing var means the localStorage demo. Trailing slashes are trimmed.
 */
const BUILD_API_URL =
  typeof import.meta.env.VITE_API_URL === 'string'
    ? import.meta.env.VITE_API_URL.replace(/\/+$/, '')
    : undefined;

export function getApiUrl(): string {
  // A localStorage override wins (handy for dev / pointing at a staging API);
  // otherwise fall back to the build-time value.
  const override = localStorage.getItem(API_URL_KEY);
  if (override !== null) return override.replace(/\/+$/, '');
  return BUILD_API_URL ?? '';
}

/**
 * Is the app talking to the real backend? True when a build-time VITE_API_URL
 * was provided OR a localStorage override is set. Note: same-origin API mode
 * uses an empty base URL, so we can't test "is the URL non-empty" — we test
 * whether either source was CONFIGURED.
 */
export function isApiEnabled(): boolean {
  return localStorage.getItem(API_URL_KEY) !== null || BUILD_API_URL !== undefined;
}

/** True only for the localStorage single-browser demo (no backend configured). */
export function isDemoMode(): boolean {
  return !isApiEnabled();
}

export function getApiToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function clearApiToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_KEY);
}

/** The user/tenant captured at API login — lets the session survive reloads
 *  without an extra round-trip. Cleared with the token. */
export function getStoredApiSession(): { user: User; tenant: Tenant } | null {
  if (!isApiEnabled() || !getApiToken()) return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${getApiUrl()}${path}`, {
    ...init,
    headers: {
      // Declare a JSON body ONLY when there is one. Fastify rejects a request
      // carrying `Content-Type: application/json` with an empty body
      // ("Body cannot be empty when content-type is set to 'application/json'"),
      // which made every bodyless DELETE fail with a 400.
      ...(init.body !== undefined && init.body !== null
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(getApiToken() ? { Authorization: `Bearer ${getApiToken()}` } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json().catch(() => {
    throw new Error('The API returned an unexpected (non-JSON) response');
  }) as Promise<T>;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

interface ApiLoginResponse {
  token: string;
  user: { id: string; name: string; email: string; role: string; mustChangePassword?: boolean };
  tenant: {
    id: string; name: string; company: string; slug: string;
    plan: string; status: string; currency: string; country: string;
    primaryColor: string | null; logoUrl: string | null;
  };
}

export async function apiLogin(
  email: string, password: string, tenantSlug?: string,
): Promise<{ user: User; tenant: Tenant }> {
  const res = await request<ApiLoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, tenantSlug }),
  });
  localStorage.setItem(TOKEN_KEY, res.token);

  // Map API shapes onto the SPA's existing types so no component changes
  const user: User = {
    id: res.user.id, tenantId: res.tenant.id, name: res.user.name,
    email: res.user.email, password: '', role: res.user.role as Role,
    avatar: '', phone: '', active: true, createdAt: new Date().toISOString(),
    // Drives the blocking ForcePasswordChange screen after an admin issues a
    // temporary password.
    mustChangePassword: res.user.mustChangePassword ?? false,
  };
  const tenant: Tenant = {
    id: res.tenant.id, name: res.tenant.name, company: res.tenant.company,
    logo: res.tenant.logoUrl || '', brandVoice: '', audience: '', channels: [],
    plan: res.tenant.plan, status: res.tenant.status as Tenant['status'],
    country: res.tenant.country, currency: res.tenant.currency,
    slug: res.tenant.slug, primaryColor: res.tenant.primaryColor || undefined,
    email: '', phone: '', address: '', createdAt: new Date().toISOString(),
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify({ user, tenant }));
  return { user, tenant };
}

// ── Leads (read API — phase 1 of the cutover) ────────────────────────────────

export async function apiGetLeads(params: { stage?: string; search?: string } = {}): Promise<Lead[]> {
  const qs = new URLSearchParams();
  if (params.stage) qs.set('stage', params.stage);
  if (params.search) qs.set('search', params.search);
  const res = await request<{ leads: Lead[] }>(`/api/leads${qs.size ? `?${qs}` : ''}`);
  return res.leads;
}

// ── Leads (write API — phase 2 of the cutover) ───────────────────────────────

/**
 * The only fields the write API accepts. The server sets
 * `additionalProperties: false`, so forwarding a whole `Lead` (with id,
 * tenantId, createdAt) would be rejected with a 400 — server-owned columns are
 * not the client's to set. Undefined values are dropped so a PATCH stays
 * genuinely partial.
 */
const WRITABLE_LEAD_FIELDS = [
  'name', 'email', 'phone', 'source', 'project', 'projectId', 'budget',
  'configuration', 'stage', 'priority', 'score', 'assignedTo', 'customFields',
  'lastContact',
] as const;

function toWritable(patch: Partial<Lead>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE_LEAD_FIELDS) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    // Form inputs hand back strings; the API schema wants real numbers.
    if (key === 'budget') out[key] = Number(value) || 0;
    else if (key === 'score') out[key] = Math.round(Number(value)) || 0;
    else out[key] = value;
  }
  return out;
}

export async function apiCreateLead(input: Partial<Lead>): Promise<Lead> {
  const res = await request<{ lead: Lead }>('/api/leads', {
    method: 'POST',
    body: JSON.stringify(toWritable(input)),
  });
  return res.lead;
}

export async function apiUpdateLead(id: string, patch: Partial<Lead>): Promise<Lead> {
  const res = await request<{ lead: Lead }>(`/api/leads/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(toWritable(patch)),
  });
  return res.lead;
}

export async function apiDeleteLead(id: string): Promise<void> {
  await request<void>(`/api/leads/${id}`, { method: 'DELETE' });
}

// ── Users (workspace directory) ──────────────────────────────────────────────

/** The tenant's users. Needed to resolve an `assignedTo` id to a person —
 *  without it the UI can only show "Unassigned". Never includes a password. */
export async function apiGetUsers(): Promise<User[]> {
  const res = await request<{ users: User[] }>('/api/users');
  return res.users;
}

export interface ApiRole {
  id: string;
  name: string;
  isSystem: boolean;
  /** False when the role grants permissions the caller doesn't hold, so the UI
   *  can disable it instead of offering a choice the server will reject. */
  assignable: boolean;
}

export async function apiGetRoles(): Promise<ApiRole[]> {
  const res = await request<{ roles: ApiRole[] }>('/api/roles');
  return res.roles;
}

/**
 * Create a colleague's account. The server generates the password and returns
 * it EXACTLY once — it is not stored in plain text and cannot be fetched again,
 * so the caller must show or copy it immediately.
 */
export async function apiCreateUser(input: {
  name: string; email: string; phone?: string; roleId: string;
}): Promise<{ user: User; temporaryPassword: string }> {
  return request<{ user: User; temporaryPassword: string }>('/api/users', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Rename, deactivate/reactivate, reassign a role, or issue a fresh temporary
 *  password. `temporaryPassword` comes back only when resetPassword was set. */
export async function apiUpdateUser(
  id: string,
  patch: { name?: string; phone?: string; active?: boolean; roleId?: string; resetPassword?: boolean },
): Promise<{ user: User; temporaryPassword?: string }> {
  return request<{ user: User; temporaryPassword?: string }>(`/api/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

// ── Metadata (dynamic forms / pipelines) ─────────────────────────────────────

export async function apiGetMeta(entity: string): Promise<Record<string, unknown>> {
  return request(`/api/meta/${entity}`);
}
