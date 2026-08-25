import type { Lead, Tenant, User, Role, Project, Tower, Unit, Booking, Document, Campaign, Template, Quotation, Ticket, Broker, Account, JournalEntry, JournalLine, Invoice, Task, AuditLog } from '../types';

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


export function getApiToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function clearApiToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_KEY);
}

/**
 * Tell the server this session is over, so the token stops working.
 *
 * Dropping the token locally was the whole of "logging out" before this, which
 * left it valid for the rest of its 24 hours in whoever's hands it was already
 * in — the shared site tablet being the case that matters.
 *
 * Never throws and never blocks the caller on the result. Signing out must
 * succeed with no network, an expired token, or a server that is down; the
 * local state is cleared either way. The worst case is a token that outlives
 * the click, which is exactly where we started.
 *
 * @param scope 'all' also ends every other session for this user — the honest
 *              answer to a lost phone.
 */
export async function apiLogout(scope: 'this' | 'all' = 'this'): Promise<void> {
  if (!isApiEnabled() || !getApiToken()) return;
  const path = scope === 'all' ? '/api/auth/logout-all' : '/api/auth/logout';
  try {
    await request<{ ok: boolean }>(path, { method: 'POST' });
  } catch {
    // Deliberately swallowed — see above.
  }
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

/** An account with a second factor gets this instead of a session. */
export interface MfaChallenge { mfaRequired: true; challengeId: string; sentTo: string }

export function isMfaChallenge(x: unknown): x is MfaChallenge {
  return !!x && typeof x === 'object' && (x as MfaChallenge).mfaRequired === true;
}

export async function apiLogin(
  email: string, password: string, tenantSlug?: string,
): Promise<{ user: User; tenant: Tenant } | MfaChallenge> {
  const res = await request<ApiLoginResponse & Partial<MfaChallenge>>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, tenantSlug }),
  });
  // No token yet — the password was right, but a code is required.
  if (isMfaChallenge(res)) return res;
  return establishSession(res);
}

/** Second step of an MFA login: trade the emailed code for a session. */
export async function apiVerifyLoginCode(
  challengeId: string, code: string,
): Promise<{ user: User; tenant: Tenant }> {
  const res = await request<ApiLoginResponse>('/api/auth/verify-code', {
    method: 'POST',
    body: JSON.stringify({ challengeId, code }),
  });
  return establishSession(res);
}

function establishSession(res: ApiLoginResponse): { user: User; tenant: Tenant } {
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
  'configuration', 'stage', 'priority', 'score', 'assignedTo', 'brokerId',
  'customFields', 'lastContact',
] as const;

function toWritable(patch: Partial<Lead>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE_LEAD_FIELDS) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    // Form inputs hand back strings; the API schema wants real numbers.
    if (key === 'budget') out[key] = Number(value) || 0;
    else if (key === 'score') out[key] = Math.round(Number(value)) || 0;
    // brokerId is a UUID or nothing — never send '' (fails the pattern → 400).
    else if (key === 'brokerId') { if (value) out[key] = value; }
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

// ── Projects (write API — server-backed module) ──────────────────────────────

/** Only fields the projects API accepts (additionalProperties:false on the
 *  server). id/tenantId/availableUnits/createdAt are server-owned. */
const WRITABLE_PROJECT_FIELDS = [
  'name', 'location', 'type', 'status', 'reraNumber', 'totalUnits', 'priceRange',
  'launchDate', 'completionDate', 'description', 'amenities', 'micrositePublished',
] as const;

function toWritableProject(patch: Partial<Project>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE_PROJECT_FIELDS) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === 'totalUnits') out[key] = Math.round(Number(value)) || 0;
    else out[key] = value;
  }
  return out;
}

export async function apiGetProjects(): Promise<Project[]> {
  const res = await request<{ projects: Project[] }>('/api/projects');
  return res.projects;
}

export async function apiCreateProject(input: Partial<Project>): Promise<Project> {
  const res = await request<{ project: Project }>('/api/projects', {
    method: 'POST', body: JSON.stringify(toWritableProject(input)),
  });
  return res.project;
}

export async function apiUpdateProject(id: string, patch: Partial<Project>): Promise<Project> {
  const res = await request<{ project: Project }>(`/api/projects/${id}`, {
    method: 'PATCH', body: JSON.stringify(toWritableProject(patch)),
  });
  return res.project;
}

export async function apiDeleteProject(id: string): Promise<void> {
  await request<void>(`/api/projects/${id}`, { method: 'DELETE' });
}

// ── Inventory: towers + units (server-backed module) ─────────────────────────

export async function apiGetTowers(): Promise<Tower[]> {
  const res = await request<{ towers: Tower[] }>('/api/towers');
  return res.towers;
}

export async function apiGetUnits(projectId?: string): Promise<Unit[]> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const res = await request<{ units: Unit[] }>(`/api/units${qs}`);
  return res.units;
}

/** Fields the units API accepts. id/tenantId/bookedBy are server-owned
 *  (bookedBy is derived from bookings); towerId is create-only. */
const WRITABLE_UNIT_FIELDS = [
  'number', 'type', 'configuration', 'floorNumber', 'area', 'price', 'status',
] as const;

function toWritableUnit(patch: Partial<Unit>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE_UNIT_FIELDS) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === 'floorNumber') out[key] = Math.round(Number(value)) || 0;
    else if (key === 'area' || key === 'price') out[key] = Number(value) || 0;
    else out[key] = value;
  }
  return out;
}

export async function apiCreateUnit(input: Partial<Unit>): Promise<Unit> {
  const res = await request<{ unit: Unit }>('/api/units', {
    method: 'POST',
    body: JSON.stringify({ towerId: input.towerId, ...toWritableUnit(input) }),
  });
  return res.unit;
}

export async function apiUpdateUnit(id: string, patch: Partial<Unit>): Promise<Unit> {
  const res = await request<{ unit: Unit }>(`/api/units/${id}`, {
    method: 'PATCH', body: JSON.stringify(toWritableUnit(patch)),
  });
  return res.unit;
}

export async function apiDeleteUnit(id: string): Promise<void> {
  await request<void>(`/api/units/${id}`, { method: 'DELETE' });
}

// ── Bookings (server-backed module) ──────────────────────────────────────────

export async function apiGetBookings(): Promise<Booking[]> {
  const res = await request<{ bookings: Booking[] }>('/api/bookings');
  return res.bookings;
}

/** Fields the bookings API accepts on update. id/tenantId/projectId/createdAt are
 *  server-owned; leadId/unitId are create-only. */
const WRITABLE_BOOKING_FIELDS = ['amount', 'value', 'paymentPlan', 'stage', 'cancelRequested'] as const;

function toWritableBooking(patch: Partial<Booking>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE_BOOKING_FIELDS) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === 'amount' || key === 'value') out[key] = Number(value) || 0;
    else out[key] = value;
  }
  return out;
}

export async function apiCreateBooking(input: Partial<Booking>): Promise<Booking> {
  const res = await request<{ booking: Booking }>('/api/bookings', {
    method: 'POST',
    body: JSON.stringify({ leadId: input.leadId, unitId: input.unitId, ...toWritableBooking(input) }),
  });
  return res.booking;
}

export async function apiUpdateBooking(id: string, patch: Partial<Booking>): Promise<Booking> {
  const res = await request<{ booking: Booking }>(`/api/bookings/${id}`, {
    method: 'PATCH', body: JSON.stringify(toWritableBooking(patch)),
  });
  return res.booking;
}

export async function apiDeleteBooking(id: string): Promise<void> {
  await request<void>(`/api/bookings/${id}`, { method: 'DELETE' });
}

// ── Documents (server-backed module) ─────────────────────────────────────────

export async function apiGetDocuments(): Promise<Document[]> {
  const res = await request<{ documents: Document[] }>('/api/documents');
  return res.documents;
}

/** Fields the documents API accepts. id/tenantId are server-owned. */
const WRITABLE_DOCUMENT_FIELDS = ['name', 'type', 'project', 'date', 'size', 'status', 'url'] as const;

function toWritableDocument(input: Partial<Document>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE_DOCUMENT_FIELDS) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

export async function apiCreateDocument(input: Partial<Document>): Promise<Document> {
  const res = await request<{ document: Document }>('/api/documents', {
    method: 'POST', body: JSON.stringify(toWritableDocument(input)),
  });
  return res.document;
}

export async function apiDeleteDocument(id: string): Promise<void> {
  await request<void>(`/api/documents/${id}`, { method: 'DELETE' });
}

// ── Campaigns + templates (server-backed module) ─────────────────────────────

export async function apiGetCampaigns(): Promise<Campaign[]> {
  const res = await request<{ campaigns: Campaign[] }>('/api/campaigns');
  return res.campaigns;
}

const WRITABLE_CAMPAIGN_FIELDS = ['name', 'type', 'status', 'audience', 'channel', 'content', 'scheduledAt', 'sentAt'] as const;

function toWritableCampaign(input: Partial<Campaign>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE_CAMPAIGN_FIELDS) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

export async function apiCreateCampaign(input: Partial<Campaign>): Promise<Campaign> {
  const res = await request<{ campaign: Campaign }>('/api/campaigns', {
    method: 'POST', body: JSON.stringify(toWritableCampaign(input)),
  });
  return res.campaign;
}

export async function apiUpdateCampaign(id: string, patch: Partial<Campaign>): Promise<Campaign> {
  const res = await request<{ campaign: Campaign }>(`/api/campaigns/${id}`, {
    method: 'PATCH', body: JSON.stringify(toWritableCampaign(patch)),
  });
  return res.campaign;
}

export async function apiDeleteCampaign(id: string): Promise<void> {
  await request<void>(`/api/campaigns/${id}`, { method: 'DELETE' });
}

export async function apiGetTemplates(): Promise<Template[]> {
  const res = await request<{ templates: Template[] }>('/api/templates');
  return res.templates;
}

export async function apiCreateTemplate(input: Partial<Template>): Promise<Template> {
  const body = {
    name: input.name, category: input.category, channel: input.channel, content: input.content,
  };
  const res = await request<{ template: Template }>('/api/templates', {
    method: 'POST', body: JSON.stringify(body),
  });
  return res.template;
}

export async function apiDeleteTemplate(id: string): Promise<void> {
  await request<void>(`/api/templates/${id}`, { method: 'DELETE' });
}

// ── Quotations (server-backed module — existing table) ───────────────────────

export async function apiGetQuotations(): Promise<Quotation[]> {
  const res = await request<{ quotations: Quotation[] }>('/api/quotations');
  return res.quotations;
}

/** Fields the quotations API accepts on update. id/tenantId/createdBy/createdAt
 *  are server-owned; leadId/unitId are create-only. */
const WRITABLE_QUOTATION_FIELDS = [
  'baseAmount', 'charges', 'discountAmount', 'discountApprovedBy', 'totalAmount', 'validUntil', 'status',
] as const;

function toWritableQuotation(patch: Partial<Quotation>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE_QUOTATION_FIELDS) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === 'baseAmount' || key === 'discountAmount' || key === 'totalAmount') out[key] = Number(value) || 0;
    else out[key] = value;
  }
  return out;
}

export async function apiCreateQuotation(input: Partial<Quotation>): Promise<Quotation> {
  const res = await request<{ quotation: Quotation }>('/api/quotations', {
    method: 'POST',
    body: JSON.stringify({ leadId: input.leadId, unitId: input.unitId, ...toWritableQuotation(input) }),
  });
  return res.quotation;
}

export async function apiUpdateQuotation(id: string, patch: Partial<Quotation>): Promise<Quotation> {
  const res = await request<{ quotation: Quotation }>(`/api/quotations/${id}`, {
    method: 'PATCH', body: JSON.stringify(toWritableQuotation(patch)),
  });
  return res.quotation;
}

// ── Service tickets (server-backed module) ───────────────────────────────────

export async function apiGetTickets(): Promise<Ticket[]> {
  const res = await request<{ tickets: Ticket[] }>('/api/tickets');
  return res.tickets;
}

/** Fields the tickets API accepts. id/tenantId/createdAt are server-owned. */
const WRITABLE_TICKET_FIELDS = ['title', 'leadId', 'customer', 'project', 'category', 'priority', 'status', 'assignedTo'] as const;

function toWritableTicket(input: Partial<Ticket>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE_TICKET_FIELDS) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

export async function apiCreateTicket(input: Partial<Ticket>): Promise<Ticket> {
  const res = await request<{ ticket: Ticket }>('/api/tickets', {
    method: 'POST', body: JSON.stringify(toWritableTicket(input)),
  });
  return res.ticket;
}

export async function apiUpdateTicket(id: string, patch: Partial<Ticket>): Promise<Ticket> {
  const res = await request<{ ticket: Ticket }>(`/api/tickets/${id}`, {
    method: 'PATCH', body: JSON.stringify(toWritableTicket(patch)),
  });
  return res.ticket;
}

export async function apiDeleteTicket(id: string): Promise<void> {
  await request<void>(`/api/tickets/${id}`, { method: 'DELETE' });
}

// ── Brokers (channel partners — server-backed module) ────────────────────────

export async function apiGetBrokers(): Promise<Broker[]> {
  const res = await request<{ brokers: Broker[] }>('/api/brokers');
  return res.brokers;
}

/** Fields the brokers API accepts. leadsReferred/bookingsClosed are derived
 *  server-side and never written; id/tenantId/createdAt are server-owned. */
const WRITABLE_BROKER_FIELDS = ['name', 'firm', 'phone', 'email', 'reraId', 'commissionRate', 'status'] as const;

function toWritableBroker(input: Partial<Broker>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE_BROKER_FIELDS) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === 'commissionRate') out[key] = Number(value) || 0;
    else out[key] = value;
  }
  return out;
}

export async function apiCreateBroker(input: Partial<Broker>): Promise<Broker> {
  const res = await request<{ broker: Broker }>('/api/brokers', {
    method: 'POST', body: JSON.stringify(toWritableBroker(input)),
  });
  return res.broker;
}

export async function apiUpdateBroker(id: string, patch: Partial<Broker>): Promise<Broker> {
  const res = await request<{ broker: Broker }>(`/api/brokers/${id}`, {
    method: 'PATCH', body: JSON.stringify(toWritableBroker(patch)),
  });
  return res.broker;
}

export async function apiDeleteBroker(id: string): Promise<void> {
  await request<void>(`/api/brokers/${id}`, { method: 'DELETE' });
}

// ── Finance: ledger (chart of accounts + journal entries) ────────────────────

export async function apiGetAccounts(): Promise<Account[]> {
  const res = await request<{ accounts: Account[] }>('/api/accounts');
  return res.accounts;
}

export async function apiCreateAccount(input: { code: string; name: string; type: string; isSystem?: boolean; active?: boolean }): Promise<Account> {
  const res = await request<{ account: Account }>('/api/accounts', { method: 'POST', body: JSON.stringify(input) });
  return res.account;
}

export async function apiUpdateAccount(id: string, patch: { name?: string; active?: boolean }): Promise<Account> {
  const res = await request<{ account: Account }>(`/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  return res.account;
}

export async function apiGetJournalEntries(): Promise<JournalEntry[]> {
  const res = await request<{ entries: JournalEntry[] }>('/api/journal-entries');
  return res.entries;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Post a balanced entry. The server re-validates Σdebit==Σcredit and inserts
 *  entry+lines in one transaction, so an imbalance can never persist. */
export async function apiPostJournalEntry(input: {
  date?: string; narration: string; reference?: string;
  sourceType?: string; sourceId?: string; projectId?: string; status?: string;
  lines: Pick<JournalLine, 'accountId' | 'debit' | 'credit' | 'note'>[];
}): Promise<JournalEntry> {
  const body: Record<string, unknown> = {
    narration: input.narration,
    lines: input.lines.map(l => ({
      accountId: l.accountId, debit: l.debit || 0, credit: l.credit || 0,
      ...(l.note ? { note: l.note } : {}),
    })),
  };
  if (input.date) body.date = input.date;
  if (input.reference) body.reference = input.reference;
  if (input.sourceType) body.sourceType = input.sourceType;
  // The API schema requires a UUID; drop non-uuid/absent source ids.
  if (input.sourceId && UUID_RE.test(input.sourceId)) body.sourceId = input.sourceId;
  if (input.projectId) body.projectId = input.projectId;
  if (input.status) body.status = input.status;
  const res = await request<{ entry: JournalEntry }>('/api/journal-entries', { method: 'POST', body: JSON.stringify(body) });
  return res.entry;
}

// ── WhatsApp channel (adapter: free click-to-chat / paid Meta Cloud API) ─────

export interface WhatsAppInstance {
  autoNewLeadEnabled?: boolean; autoNewLeadTemplate?: string;
  autoInboundEnabled?: boolean; autoInboundTemplate?: string;
  autoMinDelaySeconds?: number; autoMaxDelaySeconds?: number;
  autoDailyCap?: number; autoQuietFrom?: number; autoQuietTo?: number;
  chatVisibility?: 'private' | 'team';
  retentionDays?: number | null;
  provider: 'click_to_chat' | 'meta_cloud_waba';
  phoneNumberId: string;
  displayPhone: string;
  status: 'connected' | 'disconnected' | 'error';
  hasToken: boolean;   // whether a server-side token is set (the token itself never leaves the server)
  evolutionUrl?: string;
  hasEvolutionKey?: boolean;
}

export async function apiGetWhatsAppInstance(): Promise<WhatsAppInstance> {
  const res = await request<{ instance: WhatsAppInstance }>('/api/whatsapp/instance');
  return res.instance;
}

/** Save the provider + (for the paid path) Meta WABA creds. The token is stored
 *  server-side; omit it to keep the existing one. */
export async function apiSaveWhatsAppInstance(input: {
  provider: 'click_to_chat' | 'meta_cloud_waba' | 'evolution';
  phoneNumberId?: string; accessToken?: string; displayPhone?: string;
  evolutionUrl?: string; evolutionApiKey?: string;
  chatVisibility?: 'private' | 'team'; retentionDays?: number | null;
  autoNewLeadEnabled?: boolean; autoNewLeadTemplate?: string;
  autoInboundEnabled?: boolean; autoInboundTemplate?: string;
  autoMinDelaySeconds?: number; autoMaxDelaySeconds?: number;
  autoDailyCap?: number; autoQuietFrom?: number; autoQuietTo?: number;
}): Promise<WhatsAppInstance> {
  const res = await request<{ instance: WhatsAppInstance }>('/api/whatsapp/instance', { method: 'PUT', body: JSON.stringify(input) });
  return res.instance;
}

export interface WhatsAppSendResult {
  delivered: boolean;                 // true = sent server-side via Meta Cloud API
  provider: 'click_to_chat' | 'meta_cloud_waba' | 'evolution';
  link?: string;                      // present in free mode — the agent opens it
  messageId?: string;                 // present when delivered via the API
}

export async function apiSendWhatsApp(to: string, body: string, leadId?: string): Promise<WhatsAppSendResult> {
  return request<WhatsAppSendResult>('/api/whatsapp/send', { method: 'POST', body: JSON.stringify({ to, body, leadId }) });
}

// ── Per-rep Evolution sessions ───────────────────────────────────────────────

export interface WhatsAppSession { instanceName: string; status: 'connected' | 'connecting' | 'disconnected'; phone: string; lastConnectedAt?: string | null }

/** The CALLER's own session (live-refreshed from the gateway when reachable). */
export async function apiWhatsappSession(): Promise<WhatsAppSession> {
  return (await request<{ session: WhatsAppSession }>('/api/whatsapp/session')).session;
}
/** Link (or re-link) the caller's WhatsApp — returns the QR to scan. */
export async function apiWhatsappConnect(): Promise<{ session: WhatsAppSession; qrcode: string; pairingCode: string }> {
  return request('/api/whatsapp/connect', { method: 'POST', body: JSON.stringify({}) });
}
/** Send an attachment from the rep's own linked number. Evolution-only —
 *  the click-to-chat link cannot carry a file. `base64` is raw (no data: prefix). */
export async function apiSendWhatsAppMedia(input: {
  to: string; leadId?: string;
  mediatype: 'image' | 'document' | 'video' | 'audio';
  mimetype: string; fileName?: string; caption?: string; base64: string;
}): Promise<{ delivered: boolean; provider: string; messageId?: string; descriptor: string }> {
  return request('/api/whatsapp/send-media', { method: 'POST', body: JSON.stringify(input) });
}

// ── WhatsApp data storage ────────────────────────────────────────────────────

export interface WhatsAppStorageSummary {
  messages: number; conversations: number;
  oldest?: string | null; newest?: string | null; bytes: number;
  visibility: 'private' | 'team'; retentionDays: number | null; canManage: boolean;
}
export async function apiWhatsappStorageSummary(): Promise<WhatsAppStorageSummary> {
  return (await request<{ summary: WhatsAppStorageSummary }>('/api/whatsapp/storage/summary')).summary;
}

/**
 * Download the caller's chat export. A plain <a href> cannot carry the bearer
 * token, so this fetches with auth and hands back a Blob for the caller to
 * save. Returns the server-suggested filename when it sends one.
 */
export async function apiWhatsappExport(
  opts: { format: 'csv' | 'json'; leadId?: string; from?: string; to?: string },
): Promise<{ blob: Blob; filename: string }> {
  const p = new URLSearchParams({ format: opts.format });
  if (opts.leadId) p.set('leadId', opts.leadId);
  if (opts.from) p.set('from', opts.from);
  if (opts.to) p.set('to', opts.to);

  const res = await fetch(`${getApiUrl()}/api/whatsapp/storage/export?${p.toString()}`, {
    headers: { Authorization: `Bearer ${getApiToken()}` },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as { error?: string }).error ?? `Export failed (${res.status})`);
  }
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const named = disposition.match(/filename="([^"]+)"/)?.[1];
  return {
    blob: await res.blob(),
    filename: named ?? `whatsapp-chats.${opts.format}`,
  };
}

export async function apiWhatsappDeleteChats(input: { leadId?: string; olderThanDays?: number }): Promise<{ deleted: number }> {
  return request('/api/whatsapp/storage', { method: 'DELETE', body: JSON.stringify(input) });
}

export interface WhatsAppQueueItem {
  id: string; trigger: 'new_lead' | 'inbound';
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  leadName: string; phone: string; body: string;
  sendAfter: string; sentAt?: string | null; error?: string | null;
}
/** Reading the queue also drains it — there is no scheduler in this stack. */
export async function apiWhatsappQueue(): Promise<WhatsAppQueueItem[]> {
  return (await request<{ queue: WhatsAppQueueItem[] }>('/api/whatsapp/auto-reply/queue')).queue;
}
export async function apiWhatsappCancelQueued(id: string): Promise<void> {
  await request(`/api/whatsapp/auto-reply/queue/${id}`, { method: 'DELETE', body: JSON.stringify({}) });
}

/** One inbox row per lead with WhatsApp history, newest first. */
export interface WhatsAppConversation {
  leadId: string; name: string; phone: string; project: string; stage: string;
  lastMessage: string; lastAt: string;
  lastFromCustomer: boolean; awaitingReply: boolean; messageCount: number;
}
export async function apiWhatsappConversations(): Promise<WhatsAppConversation[]> {
  return (await request<{ conversations: WhatsAppConversation[] }>('/api/whatsapp/conversations')).conversations;
}

export async function apiWhatsappDisconnect(): Promise<WhatsAppSession> {
  return (await request<{ session: WhatsAppSession }>('/api/whatsapp/disconnect', { method: 'POST', body: JSON.stringify({}) })).session;
}

// ── Metadata (dynamic forms / pipelines) ─────────────────────────────────────

export async function apiGetMeta(entity: string): Promise<Record<string, unknown>> {
  return request(`/api/meta/${entity}`);
}

// ── Payments & collections ───────────────────────────────────────────────────

export interface ApiScheduleRow {
  id?: string; bookingId?: string; number: number; milestoneName: string;
  percentage?: number; amount: number; dueDate?: string | null;
  status: 'pending' | 'demanded' | 'paid' | 'overdue';
  trigger?: 'time' | 'construction_milestone';
}
export interface ApiPayment { id: string; scheduleId: string; amount: number; date: string; mode: string; referenceNo?: string }

export async function apiGetPaymentSchedules(bookingId?: string): Promise<ApiScheduleRow[]> {
  const q = bookingId ? `?bookingId=${encodeURIComponent(bookingId)}` : '';
  const r = await request<{ schedules: ApiScheduleRow[] }>(`/api/payment-schedules${q}`);
  return r.schedules;
}
export async function apiCreatePaymentSchedule(bookingId: string, installments: ApiScheduleRow[]): Promise<ApiScheduleRow[]> {
  const r = await request<{ schedules: ApiScheduleRow[] }>('/api/payment-schedules', { method: 'POST', body: JSON.stringify({ bookingId, installments }) });
  return r.schedules;
}
export async function apiUpdatePaymentSchedule(id: string, status: ApiScheduleRow['status']): Promise<ApiScheduleRow> {
  const r = await request<{ schedule: ApiScheduleRow }>(`/api/payment-schedules/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  return r.schedule;
}
export async function apiGetPayments(bookingId?: string): Promise<ApiPayment[]> {
  const q = bookingId ? `?bookingId=${encodeURIComponent(bookingId)}` : '';
  const r = await request<{ payments: ApiPayment[] }>(`/api/payments${q}`);
  return r.payments;
}
export async function apiRecordPayment(input: { scheduleId: string; amount: number; mode?: string; referenceNo?: string }): Promise<ApiPayment> {
  const r = await request<{ payment: ApiPayment }>('/api/payments', { method: 'POST', body: JSON.stringify(input) });
  return r.payment;
}

// ── Accounts Payable (vendors, vendor bills, RA bills, AP payments) ───────────

export interface ApiVendor {
  id: string; name: string; vendorType: string; taxId?: string | null; status: string;
  category?: string; contactPerson?: string | null; phone?: string; email?: string | null;
  address?: string | null; rating?: number | null;
}
export interface ApiVendorBillLine { id?: string; description: string; quantity?: number; unitRate?: number; amount: number; accountId?: string | null }
export interface ApiVendorBill {
  id: string; vendorId: string; projectId?: string | null; poId?: string | null; billNo: string; billDate?: string; dueDate?: string | null;
  amount: number; taxAmount: number; totalAmount: number; status: string; approvedBy?: string | null;
  category?: string; paidAt?: string | null; notes?: string | null; lineItems: ApiVendorBillLine[];
}
export interface ApiRaBill {
  id: string; vendorId: string; projectId: string; raNumber: number; workProgressPercentage: number;
  grossAmount: number; retentionAmount: number; deductions: { label: string; amount: number }[]; netPayable: number;
  status: string; pmcApprovedBy?: string | null; financeApprovedBy?: string | null;
  siteProgressPercentage?: number | null; overrideReason?: string | null; notes?: string | null;
  signedOffAt?: string | null; financeApprovedAt?: string | null; createdBy?: string | null; createdAt?: string;
}
export interface ApiApPayment { id: string; vendorBillId?: string | null; raBillId?: string | null; amount: number; date: string; mode: string; referenceNo?: string }

export async function apiGetVendors(): Promise<ApiVendor[]> {
  return (await request<{ vendors: ApiVendor[] }>('/api/vendors')).vendors;
}
export async function apiCreateVendor(input: Partial<ApiVendor> & { name: string }): Promise<ApiVendor> {
  return (await request<{ vendor: ApiVendor }>('/api/vendors', { method: 'POST', body: JSON.stringify(input) })).vendor;
}
export async function apiUpdateVendor(id: string, patch: Partial<Omit<ApiVendor, 'id'>>): Promise<ApiVendor> {
  return (await request<{ vendor: ApiVendor }>(`/api/vendors/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })).vendor;
}
export async function apiDeleteVendor(id: string): Promise<void> {
  await request<void>(`/api/vendors/${id}`, { method: 'DELETE' });
}
export async function apiDeleteMaterial(id: string): Promise<void> {
  await request<void>(`/api/materials/${id}`, { method: 'DELETE' });
}
export async function apiDeleteMachine(id: string): Promise<void> {
  await request<void>(`/api/machines/${id}`, { method: 'DELETE' });
}
export async function apiGetVendorBills(projectId?: string): Promise<ApiVendorBill[]> {
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return (await request<{ bills: ApiVendorBill[] }>(`/api/vendor-bills${q}`)).bills;
}
export async function apiCreateVendorBill(input: { vendorId: string; projectId?: string; poId?: string; billNo?: string; billDate?: string; dueDate?: string; amount: number; taxAmount?: number; category?: string; notes?: string; lineItems?: ApiVendorBillLine[] }): Promise<ApiVendorBill> {
  return (await request<{ bill: ApiVendorBill }>('/api/vendor-bills', { method: 'POST', body: JSON.stringify(input) })).bill;
}
export async function apiUpdateVendorBill(id: string, status: string): Promise<ApiVendorBill> {
  return (await request<{ bill: ApiVendorBill }>(`/api/vendor-bills/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })).bill;
}
export async function apiDeleteVendorBill(id: string): Promise<void> {
  await request<void>(`/api/vendor-bills/${id}`, { method: 'DELETE' });
}
export async function apiDeleteComplianceItem(id: string): Promise<void> {
  await request<void>(`/api/compliance-items/${id}`, { method: 'DELETE' });
}
/** Set one (project, category) budget cell; amount 0 clears it. */
export async function apiSetBudget(input: { projectId: string; category: string; allocatedAmount: number; fiscalYear?: string }): Promise<ApiBudget | null> {
  return (await request<{ budget: ApiBudget | null }>('/api/budgets', { method: 'PUT', body: JSON.stringify(input) })).budget;
}
export async function apiGetRaBills(): Promise<ApiRaBill[]> {
  return (await request<{ raBills: ApiRaBill[] }>('/api/ra-bills')).raBills;
}
export async function apiCreateRaBill(input: { vendorId: string; projectId: string; workProgressPercentage: number; grossAmount: number; retentionAmount?: number; deductions?: { label: string; amount: number }[]; siteProgressPercentage?: number | null; overrideReason?: string; notes?: string }): Promise<ApiRaBill> {
  return (await request<{ raBill: ApiRaBill }>('/api/ra-bills', { method: 'POST', body: JSON.stringify(input) })).raBill;
}
export async function apiUpdateRaBill(id: string, status: string): Promise<ApiRaBill> {
  return (await request<{ raBill: ApiRaBill }>(`/api/ra-bills/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })).raBill;
}
export async function apiGetApPayments(): Promise<ApiApPayment[]> {
  return (await request<{ payments: ApiApPayment[] }>('/api/ap-payments')).payments;
}
export async function apiRecordApPayment(input: { vendorBillId?: string; raBillId?: string; amount: number; mode?: string; referenceNo?: string }): Promise<ApiApPayment> {
  return (await request<{ payment: ApiApPayment }>('/api/ap-payments', { method: 'POST', body: JSON.stringify(input) })).payment;
}

// ── Banking, reconciliation & loans ──────────────────────────────────────────

export interface ApiBankAccount { id: string; accountName: string; accountNumber?: string | null; bankName?: string | null; openingBalance: number }
export interface ApiBankTxn { id: string; bankAccountId: string; date: string; description: string; amount: number; type: 'debit' | 'credit'; reconciled: boolean; matchedJournalEntryId?: string | null }
export interface ApiLoan { id: string; projectId?: string | null; lenderName: string; loanType: string; principalAmount: number; interestRate: number; startDate: string; status: string; tenureMonths: number; tdsPct: number }
export interface ApiLoanRepayment { id: string; loanId: string; installmentNo: number; dueDate: string; principalComponent: number; interestComponent: number; tdsDeducted: number; status: string }

export async function apiGetBankAccounts(): Promise<ApiBankAccount[]> {
  return (await request<{ accounts: ApiBankAccount[] }>('/api/bank-accounts')).accounts;
}
export async function apiCreateBankAccount(input: { accountName: string; accountNumber?: string; bankName?: string; openingBalance?: number }): Promise<ApiBankAccount> {
  return (await request<{ account: ApiBankAccount }>('/api/bank-accounts', { method: 'POST', body: JSON.stringify(input) })).account;
}
export async function apiGetBankTransactions(bankAccountId?: string): Promise<ApiBankTxn[]> {
  const q = bankAccountId ? `?bankAccountId=${encodeURIComponent(bankAccountId)}` : '';
  return (await request<{ transactions: ApiBankTxn[] }>(`/api/bank-transactions${q}`)).transactions;
}
export async function apiCreateBankTransaction(input: { bankAccountId: string; txnDate?: string; description?: string; amount: number; type: 'debit' | 'credit' }): Promise<ApiBankTxn> {
  return (await request<{ transaction: ApiBankTxn }>('/api/bank-transactions', { method: 'POST', body: JSON.stringify(input) })).transaction;
}
export async function apiReconcileBankTransaction(id: string, reconciled: boolean, matchedJournalEntryId?: string): Promise<ApiBankTxn> {
  return (await request<{ transaction: ApiBankTxn }>(`/api/bank-transactions/${id}`, { method: 'PATCH', body: JSON.stringify({ reconciled, matchedJournalEntryId }) })).transaction;
}
export async function apiGetLoans(): Promise<ApiLoan[]> {
  return (await request<{ loans: ApiLoan[] }>('/api/loans')).loans;
}
export async function apiCreateLoan(input: { lenderName: string; projectId?: string; loanType?: string; principalAmount: number; interestRate?: number; startDate?: string; tenureMonths?: number; tdsPct?: number }): Promise<ApiLoan> {
  return (await request<{ loan: ApiLoan }>('/api/loans', { method: 'POST', body: JSON.stringify(input) })).loan;
}
export async function apiGetLoanSchedule(loanId: string): Promise<ApiLoanRepayment[]> {
  return (await request<{ schedule: ApiLoanRepayment[] }>(`/api/loans/${loanId}/schedule`)).schedule;
}
export async function apiCreateLoanSchedule(loanId: string, installments: { installmentNo: number; dueDate: string; principalComponent?: number; interestComponent?: number; tdsDeducted?: number }[]): Promise<ApiLoanRepayment[]> {
  return (await request<{ schedule: ApiLoanRepayment[] }>(`/api/loans/${loanId}/schedule`, { method: 'POST', body: JSON.stringify({ installments }) })).schedule;
}
export async function apiUpdateLoanRepayment(id: string, status: string): Promise<ApiLoanRepayment> {
  return (await request<{ installment: ApiLoanRepayment }>(`/api/loan-repayments/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })).installment;
}

// ── Config: approval workflows + metadata write ──────────────────────────────

export interface ApiApprovalWorkflow { id: string; actionType: string; thresholdAmount: number | null; approverRoleId: string }

export async function apiGetApprovalWorkflows(): Promise<ApiApprovalWorkflow[]> {
  return (await request<{ workflows: ApiApprovalWorkflow[] }>('/api/approval-workflows')).workflows;
}
export async function apiSaveApprovalWorkflow(input: { actionType: string; thresholdAmount?: number | null; approverRoleId: string }): Promise<ApiApprovalWorkflow> {
  return (await request<{ workflow: ApiApprovalWorkflow }>('/api/approval-workflows', { method: 'PUT', body: JSON.stringify(input) })).workflow;
}
export async function apiDeleteApprovalWorkflow(actionType: string): Promise<void> {
  await request<void>(`/api/approval-workflows/${encodeURIComponent(actionType)}`, { method: 'DELETE' });
}
/** Persist a form/pipeline/etc metadata definition (versioned, server-side). */
export async function apiSaveMeta(entity: string, kind: string, definition: unknown): Promise<{ id: string; entity: string; kind: string; version: number }> {
  return (await request<{ definition: { id: string; entity: string; kind: string; version: number } }>(`/api/meta/${encodeURIComponent(entity)}`, { method: 'PUT', body: JSON.stringify({ kind, definition }) })).definition;
}

// ── CRM adjacents: customers, lead activities, commissions ───────────────────

export interface ApiCustomer { id: string; name: string; email?: string | null; phone: string; kycStatus: string; leadId?: string | null }
export interface ApiLeadActivity { id: string; leadId: string; userId?: string | null; type: string; notes: string; scheduledAt?: string | null; outcome?: string | null; createdAt: string }
export interface ApiCommission { id: string; brokerId: string; bookingId: string; amountEarned: number; amountPaid: number; status: string }

export async function apiGetCustomers(): Promise<ApiCustomer[]> {
  return (await request<{ customers: ApiCustomer[] }>('/api/customers')).customers;
}
export async function apiCreateCustomer(input: { name: string; email?: string; phone?: string; leadId?: string; kycStatus?: string }): Promise<ApiCustomer> {
  return (await request<{ customer: ApiCustomer }>('/api/customers', { method: 'POST', body: JSON.stringify(input) })).customer;
}
export async function apiUpdateCustomerKyc(id: string, kycStatus: string): Promise<ApiCustomer> {
  return (await request<{ customer: ApiCustomer }>(`/api/customers/${id}`, { method: 'PATCH', body: JSON.stringify({ kycStatus }) })).customer;
}
export async function apiGetLeadActivities(leadId?: string, type?: string): Promise<ApiLeadActivity[]> {
  const params = new URLSearchParams();
  if (leadId) params.set('leadId', leadId);
  if (type) params.set('type', type);
  const q = params.toString() ? `?${params.toString()}` : '';
  return (await request<{ activities: ApiLeadActivity[] }>(`/api/lead-activities${q}`)).activities;
}
export async function apiCreateLeadActivity(input: { leadId: string; type: string; notes?: string; scheduledAt?: string; outcome?: string }): Promise<ApiLeadActivity> {
  return (await request<{ activity: ApiLeadActivity }>('/api/lead-activities', { method: 'POST', body: JSON.stringify(input) })).activity;
}
export async function apiGetCommissions(): Promise<ApiCommission[]> {
  return (await request<{ commissions: ApiCommission[] }>('/api/commissions')).commissions;
}
export async function apiCreateCommission(input: { brokerId: string; bookingId: string; amountEarned: number }): Promise<ApiCommission> {
  return (await request<{ commission: ApiCommission }>('/api/commissions', { method: 'POST', body: JSON.stringify(input) })).commission;
}
export async function apiPayCommission(id: string, amountPaid: number): Promise<ApiCommission> {
  return (await request<{ commission: ApiCommission }>(`/api/commissions/${id}`, { method: 'PATCH', body: JSON.stringify({ amountPaid }) })).commission;
}

// ── Service requests, cost centers, budgets ──────────────────────────────────

export interface ApiServiceRequest { id: string; customerId: string; bookingId?: string | null; category: string; description: string; status: string; assignedTo?: string | null; resolvedAt?: string | null; createdAt: string }
export interface ApiCostCenter { id: string; projectId?: string | null; name: string }
export interface ApiBudget { id: string; projectId: string; budgetCode: string; category: string; fiscalYear: string; allocatedAmount: number; costCenterId?: string | null }

export async function apiGetServiceRequests(): Promise<ApiServiceRequest[]> {
  return (await request<{ requests: ApiServiceRequest[] }>('/api/service-requests')).requests;
}
export async function apiCreateServiceRequest(input: { customerId: string; bookingId?: string; category?: string; description?: string }): Promise<ApiServiceRequest> {
  return (await request<{ request: ApiServiceRequest }>('/api/service-requests', { method: 'POST', body: JSON.stringify(input) })).request;
}
export async function apiUpdateServiceRequest(id: string, patch: { status?: string; assignedTo?: string }): Promise<ApiServiceRequest> {
  return (await request<{ request: ApiServiceRequest }>(`/api/service-requests/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })).request;
}
export async function apiGetCostCenters(): Promise<ApiCostCenter[]> {
  return (await request<{ costCenters: ApiCostCenter[] }>('/api/cost-centers')).costCenters;
}
export async function apiCreateCostCenter(input: { name: string; projectId?: string }): Promise<ApiCostCenter> {
  return (await request<{ costCenter: ApiCostCenter }>('/api/cost-centers', { method: 'POST', body: JSON.stringify(input) })).costCenter;
}
export async function apiGetBudgets(projectId?: string): Promise<ApiBudget[]> {
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return (await request<{ budgets: ApiBudget[] }>(`/api/budgets${q}`)).budgets;
}
export async function apiCreateBudget(input: { projectId: string; category: string; allocatedAmount: number; budgetCode?: string; fiscalYear?: string; costCenterId?: string }): Promise<ApiBudget> {
  return (await request<{ budget: ApiBudget }>('/api/budgets', { method: 'POST', body: JSON.stringify(input) })).budget;
}

// ── HR & workforce ───────────────────────────────────────────────────────────

export interface ApiEmployee { id: string; name: string; phone: string; email?: string | null; designation: string; department: string; type: string; projectId?: string | null; monthlySalary?: number | null; dailyWage?: number | null; joinDate: string; active: boolean; userId?: string | null }
export interface ApiAttendance { id: string; employeeId: string; date: string; checkIn: string; checkOut?: string | null; projectId?: string | null; lat?: number | null; lng?: number | null; method: string }
export interface ApiLeaveRequest { id: string; employeeId: string; type: string; from: string; to: string; days: number; reason?: string | null; status: string; decidedBy?: string | null; decidedAt?: string | null }
export interface ApiPayrollRun { id: string; month: string; status: string; items: unknown[]; processedBy?: string | null; processedAt?: string | null }

export async function apiGetEmployees(): Promise<ApiEmployee[]> {
  return (await request<{ employees: ApiEmployee[] }>('/api/employees')).employees;
}
export async function apiCreateEmployee(input: Partial<ApiEmployee> & { name: string }): Promise<ApiEmployee> {
  return (await request<{ employee: ApiEmployee }>('/api/employees', { method: 'POST', body: JSON.stringify(input) })).employee;
}
export async function apiUpdateEmployee(id: string, patch: { active?: boolean; monthlySalary?: number; dailyWage?: number; designation?: string; department?: string }): Promise<ApiEmployee> {
  return (await request<{ employee: ApiEmployee }>(`/api/employees/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })).employee;
}
export async function apiDeleteEmployee(id: string): Promise<void> {
  await request<void>(`/api/employees/${id}`, { method: 'DELETE' });
}
export async function apiDeleteAttendance(id: string): Promise<void> {
  await request<void>(`/api/attendance/${id}`, { method: 'DELETE' });
}
export async function apiGetAttendance(date?: string): Promise<ApiAttendance[]> {
  const q = date ? `?date=${encodeURIComponent(date)}` : '';
  return (await request<{ attendance: ApiAttendance[] }>(`/api/attendance${q}`)).attendance;
}
export async function apiMarkAttendance(input: { employeeId: string; date?: string; checkIn?: string; checkOut?: string; projectId?: string; lat?: number; lng?: number; method?: string }): Promise<ApiAttendance> {
  return (await request<{ attendance: ApiAttendance }>('/api/attendance', { method: 'POST', body: JSON.stringify(input) })).attendance;
}
export async function apiGetLeaveRequests(): Promise<ApiLeaveRequest[]> {
  return (await request<{ leaveRequests: ApiLeaveRequest[] }>('/api/leave-requests')).leaveRequests;
}
export async function apiCreateLeaveRequest(input: { employeeId: string; type?: string; from: string; to: string; days?: number; reason?: string }): Promise<ApiLeaveRequest> {
  return (await request<{ leaveRequest: ApiLeaveRequest }>('/api/leave-requests', { method: 'POST', body: JSON.stringify(input) })).leaveRequest;
}
export async function apiDecideLeaveRequest(id: string, status: string): Promise<ApiLeaveRequest> {
  return (await request<{ leaveRequest: ApiLeaveRequest }>(`/api/leave-requests/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })).leaveRequest;
}
export async function apiGetPayrollRuns(): Promise<ApiPayrollRun[]> {
  return (await request<{ payrollRuns: ApiPayrollRun[] }>('/api/payroll-runs')).payrollRuns;
}
export async function apiCreatePayrollRun(month: string, items: unknown[]): Promise<ApiPayrollRun> {
  return (await request<{ payrollRun: ApiPayrollRun }>('/api/payroll-runs', { method: 'POST', body: JSON.stringify({ month, items }) })).payrollRun;
}
export async function apiProcessPayrollRun(id: string): Promise<ApiPayrollRun> {
  return (await request<{ payrollRun: ApiPayrollRun }>(`/api/payroll-runs/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'processed' }) })).payrollRun;
}

// ── Procurement (materials, POs, stock, machines) ────────────────────────────

export interface ApiMaterial { id: string; name: string; category: string; unit: string; reorderLevel: number }
export interface ApiPoLine { materialId?: string; description: string; unit: string; qty: number; rate: number; receivedQty: number }
export interface ApiPurchaseOrder { id: string; number: number; vendorId: string; projectId?: string | null; status: string; lines: ApiPoLine[]; expectedDate?: string | null; notes?: string | null; createdBy?: string | null; approvedBy?: string | null; approvedAt?: string | null }
export interface ApiStockTxn { id: string; materialId: string; projectId?: string | null; type: string; qty: number; rate?: number | null; vendorId?: string | null; poId?: string | null; reference?: string | null; notes?: string | null; date: string }
export interface ApiMachine { id: string; name: string; category: string; registrationNo?: string | null; ownership: string; projectId?: string | null; status: string; nextServiceDate?: string | null; notes?: string | null }

export async function apiGetMaterials(): Promise<ApiMaterial[]> {
  return (await request<{ materials: ApiMaterial[] }>('/api/materials')).materials;
}
export async function apiCreateMaterial(input: { name: string; category?: string; unit?: string; reorderLevel?: number }): Promise<ApiMaterial> {
  return (await request<{ material: ApiMaterial }>('/api/materials', { method: 'POST', body: JSON.stringify(input) })).material;
}
export async function apiGetPurchaseOrders(): Promise<ApiPurchaseOrder[]> {
  return (await request<{ purchaseOrders: ApiPurchaseOrder[] }>('/api/purchase-orders')).purchaseOrders;
}
export async function apiCreatePurchaseOrder(input: { vendorId: string; projectId?: string; lines: ApiPoLine[]; expectedDate?: string; notes?: string }): Promise<ApiPurchaseOrder> {
  return (await request<{ purchaseOrder: ApiPurchaseOrder }>('/api/purchase-orders', { method: 'POST', body: JSON.stringify(input) })).purchaseOrder;
}
export async function apiUpdatePurchaseOrder(id: string, status: 'approved' | 'cancelled'): Promise<ApiPurchaseOrder> {
  return (await request<{ purchaseOrder: ApiPurchaseOrder }>(`/api/purchase-orders/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })).purchaseOrder;
}
export async function apiReceivePurchaseOrder(id: string, receipts: { index: number; receivedQty: number }[]): Promise<ApiPurchaseOrder> {
  return (await request<{ purchaseOrder: ApiPurchaseOrder }>(`/api/purchase-orders/${id}/receive`, { method: 'POST', body: JSON.stringify({ receipts }) })).purchaseOrder;
}
export async function apiGetStockTxns(materialId?: string): Promise<ApiStockTxn[]> {
  const q = materialId ? `?materialId=${encodeURIComponent(materialId)}` : '';
  return (await request<{ stockTxns: ApiStockTxn[] }>(`/api/stock-txns${q}`)).stockTxns;
}
export async function apiCreateStockTxn(input: { materialId: string; type: 'inward' | 'outward'; qty: number; projectId?: string; rate?: number; vendorId?: string; poId?: string; reference?: string; notes?: string; date?: string }): Promise<ApiStockTxn> {
  return (await request<{ stockTxn: ApiStockTxn }>('/api/stock-txns', { method: 'POST', body: JSON.stringify(input) })).stockTxn;
}
export async function apiGetMachines(): Promise<ApiMachine[]> {
  return (await request<{ machines: ApiMachine[] }>('/api/machines')).machines;
}
export async function apiCreateMachine(input: Partial<ApiMachine> & { name: string }): Promise<ApiMachine> {
  return (await request<{ machine: ApiMachine }>('/api/machines', { method: 'POST', body: JSON.stringify(input) })).machine;
}
export async function apiUpdateMachine(id: string, patch: { status?: string; projectId?: string; nextServiceDate?: string }): Promise<ApiMachine> {
  return (await request<{ machine: ApiMachine }>(`/api/machines/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })).machine;
}

// ── Site execution (tasks, progress, RFIs, change orders, inspections) ───────

export interface ApiSiteTask { id: string; projectId: string; title: string; description?: string | null; isMilestone: boolean; startDate?: string | null; dueDate: string; completedAt?: string | null; status: string; progress: number; assignedTo?: string | null; dependsOn: string[] }
export interface ApiProgressUpdate { id: string; projectId: string; userId?: string | null; date: string; summary: string; workforce?: number | null; photos: string[] }
export interface ApiRfi { id: string; projectId: string; number: number; subject: string; question: string; raisedBy?: string | null; assignedTo?: string | null; status: string; answer?: string | null; answeredAt?: string | null; dueDate?: string | null }
export interface ApiChangeOrder { id: string; projectId: string; number: number; title: string; reason: string; costImpact: number; timeImpactDays: number; status: string; requestedBy?: string | null; decidedBy?: string | null; decidedAt?: string | null }
export interface ApiInspection { id: string; projectId: string; type: string; title: string; date: string; inspectorId?: string | null; status: string; items: unknown[]; notes?: string | null }

export async function apiGetSiteTasks(projectId?: string): Promise<ApiSiteTask[]> {
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return (await request<{ siteTasks: ApiSiteTask[] }>(`/api/site-tasks${q}`)).siteTasks;
}
export async function apiCreateSiteTask(input: { projectId: string; title: string; description?: string; isMilestone?: boolean; startDate?: string; dueDate?: string; assignedTo?: string; dependsOn?: string[] }): Promise<ApiSiteTask> {
  return (await request<{ siteTask: ApiSiteTask }>('/api/site-tasks', { method: 'POST', body: JSON.stringify(input) })).siteTask;
}
export async function apiUpdateSiteTask(id: string, patch: { status?: string; progress?: number }): Promise<ApiSiteTask> {
  return (await request<{ siteTask: ApiSiteTask }>(`/api/site-tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })).siteTask;
}
export async function apiDeleteSiteTask(id: string): Promise<void> {
  await request<void>(`/api/site-tasks/${id}`, { method: 'DELETE' });
}
export async function apiDeleteProgressUpdate(id: string): Promise<void> {
  await request<void>(`/api/progress-updates/${id}`, { method: 'DELETE' });
}
export async function apiDeleteInspection(id: string): Promise<void> {
  await request<void>(`/api/inspections/${id}`, { method: 'DELETE' });
}
export async function apiGetProgressUpdates(projectId?: string): Promise<ApiProgressUpdate[]> {
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return (await request<{ progressUpdates: ApiProgressUpdate[] }>(`/api/progress-updates${q}`)).progressUpdates;
}
export async function apiCreateProgressUpdate(input: { projectId: string; summary?: string; workforce?: number; photos?: string[]; date?: string }): Promise<ApiProgressUpdate> {
  return (await request<{ progressUpdate: ApiProgressUpdate }>('/api/progress-updates', { method: 'POST', body: JSON.stringify(input) })).progressUpdate;
}
export async function apiGetRfis(projectId?: string): Promise<ApiRfi[]> {
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return (await request<{ rfis: ApiRfi[] }>(`/api/rfis${q}`)).rfis;
}
export async function apiCreateRfi(input: { projectId: string; subject: string; question?: string; assignedTo?: string; dueDate?: string }): Promise<ApiRfi> {
  return (await request<{ rfi: ApiRfi }>('/api/rfis', { method: 'POST', body: JSON.stringify(input) })).rfi;
}
export async function apiUpdateRfi(id: string, patch: { status?: string; answer?: string }): Promise<ApiRfi> {
  return (await request<{ rfi: ApiRfi }>(`/api/rfis/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })).rfi;
}
export async function apiGetChangeOrders(projectId?: string): Promise<ApiChangeOrder[]> {
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return (await request<{ changeOrders: ApiChangeOrder[] }>(`/api/change-orders${q}`)).changeOrders;
}
export async function apiCreateChangeOrder(input: { projectId: string; title: string; reason?: string; costImpact?: number; timeImpactDays?: number }): Promise<ApiChangeOrder> {
  return (await request<{ changeOrder: ApiChangeOrder }>('/api/change-orders', { method: 'POST', body: JSON.stringify(input) })).changeOrder;
}
export async function apiDecideChangeOrder(id: string, status: 'approved' | 'rejected'): Promise<ApiChangeOrder> {
  return (await request<{ changeOrder: ApiChangeOrder }>(`/api/change-orders/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })).changeOrder;
}
export async function apiGetInspections(projectId?: string): Promise<ApiInspection[]> {
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return (await request<{ inspections: ApiInspection[] }>(`/api/inspections${q}`)).inspections;
}
export async function apiCreateInspection(input: { projectId: string; type?: string; title: string; date?: string; items?: unknown[]; notes?: string }): Promise<ApiInspection> {
  return (await request<{ inspection: ApiInspection }>('/api/inspections', { method: 'POST', body: JSON.stringify(input) })).inspection;
}
export async function apiUpdateInspection(id: string, patch: { status?: string; items?: unknown[]; notes?: string }): Promise<ApiInspection> {
  return (await request<{ inspection: ApiInspection }>(`/api/inspections/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })).inspection;
}

// ── Statutory compliance ─────────────────────────────────────────────────────

export interface ApiComplianceItem { id: string; title: string; authority: string; dueDate: string; frequency: string; projectId?: string | null; amount?: number | null; notes?: string | null; status: string; filedAt?: string | null; filedBy?: string | null; paidAt?: string | null }

export async function apiGetComplianceItems(): Promise<ApiComplianceItem[]> {
  return (await request<{ items: ApiComplianceItem[] }>('/api/compliance-items')).items;
}
export async function apiCreateComplianceItem(input: { title: string; authority?: string; dueDate: string; frequency?: string; projectId?: string; amount?: number; notes?: string }): Promise<ApiComplianceItem> {
  return (await request<{ item: ApiComplianceItem }>('/api/compliance-items', { method: 'POST', body: JSON.stringify(input) })).item;
}
export async function apiUpdateComplianceItem(id: string, status: 'pending' | 'filed' | 'paid'): Promise<ApiComplianceItem> {
  return (await request<{ item: ApiComplianceItem }>(`/api/compliance-items/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })).item;
}

// ── Land acquisition + Business development ───────────────────────────────────

export interface ApiLandLead { id: string; referenceSource: string; ownerName: string; ownerContact: string; location: string; city: string; state: string; pincode: string; surveyNumber: string; areaAcres: number; askingPrice: number; status: string; rejectionReason?: string | null; assignedTo?: string | null; ownershipType?: string | null; zoning?: string | null; fsiPermissible?: number | null; fsiConsumed?: number | null; roadWidthFt?: number | null; isEncumbered: boolean; encumbranceNotes?: string | null; litigationStatus: string; duplicateOf?: string | null; projectId?: string | null; latestScore?: number | null; createdBy?: string | null; createdAt?: string }
export interface ApiBdLead { id: string; opportunityType: string; source: string; counterpartyName: string; counterpartyContact: string; city: string; stage: string; estimatedDealValue: number; closedLostReason?: string | null; ownedBy?: string | null; jvStructure?: string | null; revenueSharePercent?: number | null; areaSharePercent?: number | null; jvNotes?: string | null; landLeadId?: string | null; createdBy?: string | null; createdAt?: string }

export interface ApiFeasibility { id: string; landLeadId: string; costPerSqft: number; saleableArea: number; estimatedRevenue: number; marginPercent: number; score: number; cappedByRisk: boolean; computedBy?: string | null; computedAt: string }
export interface ApiLandDocument { id: string; landLeadId: string; docType: string; version: number; fileName: string; verificationStatus: string; verifiedBy?: string | null; verifiedAt?: string | null; uploadedBy?: string | null; createdAt: string }
export interface ApiMarketReport { id: string; areaName: string; reportType: string; findings: string; dataSources?: string | null; createdBy?: string | null; createdAt: string }

export async function apiGetLandLeads(): Promise<ApiLandLead[]> {
  return (await request<{ landLeads: ApiLandLead[] }>('/api/land-leads')).landLeads;
}
export async function apiCreateLandLead(input: Partial<ApiLandLead> & { ownerName: string; surveyNumber: string }): Promise<ApiLandLead> {
  return (await request<{ landLead: ApiLandLead }>('/api/land-leads', { method: 'POST', body: JSON.stringify(input) })).landLead;
}
export async function apiUpdateLandLead(id: string, patch: { status?: string; assignedTo?: string; rejectionReason?: string; projectId?: string }): Promise<ApiLandLead> {
  return (await request<{ landLead: ApiLandLead }>(`/api/land-leads/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })).landLead;
}
export async function apiGetFeasibility(landLeadId?: string): Promise<ApiFeasibility[]> {
  const q = landLeadId ? `?landLeadId=${encodeURIComponent(landLeadId)}` : '';
  return (await request<{ feasibility: ApiFeasibility[] }>(`/api/feasibility${q}`)).feasibility;
}
export async function apiCreateFeasibility(input: { landLeadId: string; costPerSqft?: number; saleableArea?: number; estimatedRevenue?: number; marginPercent?: number; score: number; cappedByRisk?: boolean }): Promise<ApiFeasibility> {
  return (await request<{ feasibility: ApiFeasibility }>('/api/feasibility', { method: 'POST', body: JSON.stringify(input) })).feasibility;
}
export async function apiGetLandDocuments(landLeadId?: string): Promise<ApiLandDocument[]> {
  const q = landLeadId ? `?landLeadId=${encodeURIComponent(landLeadId)}` : '';
  return (await request<{ documents: ApiLandDocument[] }>(`/api/land-documents${q}`)).documents;
}
export async function apiCreateLandDocument(input: { landLeadId: string; docType: string; fileName: string; version?: number }): Promise<ApiLandDocument> {
  return (await request<{ document: ApiLandDocument }>('/api/land-documents', { method: 'POST', body: JSON.stringify(input) })).document;
}
export async function apiVerifyLandDocument(id: string, verificationStatus: 'pending' | 'verified' | 'rejected'): Promise<ApiLandDocument> {
  return (await request<{ document: ApiLandDocument }>(`/api/land-documents/${id}`, { method: 'PATCH', body: JSON.stringify({ verificationStatus }) })).document;
}
export async function apiGetBdLeads(): Promise<ApiBdLead[]> {
  return (await request<{ bdLeads: ApiBdLead[] }>('/api/bd-leads')).bdLeads;
}
export async function apiCreateBdLead(input: Partial<ApiBdLead> & { counterpartyName: string }): Promise<ApiBdLead> {
  return (await request<{ bdLead: ApiBdLead }>('/api/bd-leads', { method: 'POST', body: JSON.stringify(input) })).bdLead;
}
export async function apiUpdateBdLead(id: string, patch: { stage?: string; closedLostReason?: string; landLeadId?: string }): Promise<ApiBdLead> {
  return (await request<{ bdLead: ApiBdLead }>(`/api/bd-leads/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })).bdLead;
}
export async function apiGetMarketReports(): Promise<ApiMarketReport[]> {
  return (await request<{ reports: ApiMarketReport[] }>('/api/market-reports')).reports;
}
export async function apiCreateMarketReport(input: { areaName: string; reportType?: string; findings?: string; dataSources?: string }): Promise<ApiMarketReport> {
  return (await request<{ report: ApiMarketReport }>('/api/market-reports', { method: 'POST', body: JSON.stringify(input) })).report;
}

// ── Platform branches + telephony call logs ──────────────────────────────────

export interface ApiBranch { id: string; name: string; managerId?: string | null; createdAt: string }
export interface ApiCallLog { id: string; leadId: string; userId?: string | null; mode: string; status: string; durationSeconds: number; notes?: string | null; recordingUrl?: string | null; createdAt: string }

export async function apiGetBranches(): Promise<ApiBranch[]> {
  return (await request<{ branches: ApiBranch[] }>('/api/branches')).branches;
}
export async function apiCreateBranch(input: { name: string; managerId?: string }): Promise<ApiBranch> {
  return (await request<{ branch: ApiBranch }>('/api/branches', { method: 'POST', body: JSON.stringify(input) })).branch;
}
export async function apiAssignTenantBranch(tenantId: string, branchId: string | null): Promise<{ id: string; name: string; branchId: string | null }> {
  return (await request<{ tenant: { id: string; name: string; branchId: string | null } }>('/api/branches/assign-tenant', { method: 'PUT', body: JSON.stringify({ tenantId, branchId }) })).tenant;
}
export async function apiGetCallLogs(leadId?: string): Promise<ApiCallLog[]> {
  const q = leadId ? `?leadId=${encodeURIComponent(leadId)}` : '';
  return (await request<{ callLogs: ApiCallLog[] }>(`/api/call-logs${q}`)).callLogs;
}
export async function apiCreateCallLog(input: { leadId: string; mode?: string; status: string; durationSeconds?: number; notes?: string; recordingUrl?: string }): Promise<ApiCallLog> {
  return (await request<{ callLog: ApiCallLog }>('/api/call-logs', { method: 'POST', body: JSON.stringify(input) })).callLog;
}

// ── Portal (separate auth realm) ─────────────────────────────────────────────

/** Staff: invite a buyer (leadId) or channel partner (brokerId) to the portal.
 *  Returns the temp password EXACTLY once — only its hash is stored. */
export async function apiPortalInvite(input: { leadId?: string; brokerId?: string; email?: string }): Promise<{ email: string; tempPassword: string; isNew: boolean }> {
  return request('/api/portal/invites', { method: 'POST', body: JSON.stringify(input) });
}
/** Public portal login. The returned token is realm-scoped (`portal_*`) —
 *  store it separately from the staff token; it is useless on staff routes. */
export async function apiPortalLogin(email: string, password: string, tenantSlug?: string): Promise<{
  token: string;
  portalUser: { id: string; name: string; email: string; role: 'customer' | 'partner'; leadId?: string | null; brokerId?: string | null };
  tenant: { id: string; name: string; slug: string; currency?: string | null; primaryColor?: string | null; logo?: string | null };
}> {
  return request('/api/portal/login', { method: 'POST', body: JSON.stringify({ email, password, tenantSlug }) });
}
/** The portal overview payload — the caller's OWN data and nothing else.
 *  Which half is populated depends on `role`. */
export interface ApiPortalOverview {
  role: 'customer' | 'partner';
  profile: { name: string; email: string };
  // customer
  lead?: { id: string; name: string; project: string; stage: string } | null;
  bookings?: { id: string; unitId?: string | null; bookingAmount: number; totalConsideration: number; status: string; stage?: string; paymentPlan?: string | null }[];
  schedule?: { id: string; bookingId: string; milestoneName: string; sequence: number; amount: number; dueDate: string; status: string }[];
  receipts?: { id: string; scheduleId: string; amount: number; date: string; mode: string }[];
  units?: { id: string; towerId?: string | null; projectId?: string | null; unitCode: string; configuration: string; floor: number; areaSqft: number; status: string }[];
  towers?: { id: string; name: string; projectId?: string | null }[];
  tickets?: { id: string; title: string; category: string; priority: string; status: string; project: string; createdAt: string }[];
  documents?: { id: string; name: string; type: string; project: string; docDate: string; size: string; status: string; url?: string | null }[];
  // partner
  broker?: {
    id: string; name: string; phone: string; email: string;
    agencyName?: string | null;
    // null when the deal is not a percentage one — there is no single rate to
    // quote for a flat or slab arrangement.
    commissionRate?: number | null;
    leadsReferred?: number; bookingsClosed?: number;
  } | null;
  commissions?: {
    id: string; bookingId?: string | null; amountEarned: number; amountPaid: number; status: string;
    // What earned the line. Null when the booking behind it no longer exists —
    // the money is still owed, so the row is still returned.
    leadName?: string | null; project?: string | null;
    bookingValue?: number; rate?: number | null;
  }[];
  referredLeads?: { id: string; name: string; phone: string; project: string; stage: string; budget: number; createdAt: string }[];
  projects?: { id: string; name: string; location: string }[];
}

/** Portal: the caller's own data (bookings+schedule+receipts, or commissions). */
export async function apiPortalOverview(portalToken: string): Promise<ApiPortalOverview> {
  return request('/api/portal/overview', { headers: { Authorization: `Bearer ${portalToken}` } });
}

/** Portal (customer): raise a support ticket against their own booking. */
export async function apiPortalRaiseTicket(portalToken: string, input: { title: string; category?: string }): Promise<{ ticket: { id: string; title: string; category: string; priority: string; status: string; project: string; createdAt: string } }> {
  return request('/api/portal/tickets', { method: 'POST', body: JSON.stringify(input), headers: { Authorization: `Bearer ${portalToken}` } });
}

/** Portal (partner): refer a lead. Attribution is pinned to the caller's own
 *  broker record server-side — the body cannot name a different broker. */
export async function apiPortalSubmitLead(portalToken: string, input: { name: string; phone: string; email?: string; project?: string; budget?: number }): Promise<{ lead: { id: string; name: string; phone: string; project: string; stage: string; budget: number; createdAt: string } }> {
  return request('/api/portal/leads', { method: 'POST', body: JSON.stringify(input), headers: { Authorization: `Bearer ${portalToken}` } });
}
/** Portal (customer): raise a service request. */
export async function apiPortalRaiseServiceRequest(portalToken: string, input: { category?: string; description: string }): Promise<Record<string, unknown>> {
  return request('/api/portal/service-requests', { method: 'POST', body: JSON.stringify(input), headers: { Authorization: `Bearer ${portalToken}` } });
}

// ── Chatbot ──────────────────────────────────────────────────────────────────

/** The chatbot config shape shared by the admin routes and the public widget.
 *  Mirrors ChatbotConfig in services/chatbotService. */
export interface ApiChatbotConfig {
  enabled: boolean;
  greeting: string;
  accentColor: string;
  projectMode: 'all' | 'selected';
  projectIds: string[];
  timelineOptions: string[];
  customFields: unknown[];
  hotMin: number;
  warmMin: number;
  qualifyMin: number;
}

export interface PublicChatbotResponse {
  tenant: { name: string; currency: string; primaryColor: string | null };
  config: ApiChatbotConfig;
  projects: { id: string; name: string; location: string; priceMin: number; priceMax: number }[];
}

/** PUBLIC (no auth) — everything the embedded widget needs for a given builder. */
export async function apiGetPublicChatbot(slug: string): Promise<PublicChatbotResponse> {
  return request<PublicChatbotResponse>(`/api/public/chatbot/${encodeURIComponent(slug)}`);
}

export interface PublicLeadInput {
  slug: string; name: string; phone: string; email?: string; projectId?: string;
  budget?: number; configuration?: string; timeline?: string;
  customFields?: Record<string, string>;
  qualification?: { status: string; score: number; reasons?: string[] };
  hp?: string;
}

/** PUBLIC (no auth) — create a chatbot lead for a builder. */
export async function apiCreatePublicLead(input: PublicLeadInput): Promise<{ ok: boolean; leadId?: string; stage?: string; status?: string | null }> {
  return request('/api/public/leads', { method: 'POST', body: JSON.stringify(input) });
}

/** Admin (auth) — load the tenant's chatbot config; null when never configured. */
export async function apiGetChatbotConfig(): Promise<ApiChatbotConfig | null> {
  const r = await request<{ config: ApiChatbotConfig | null }>('/api/chatbot/config');
  return r.config;
}

/** Admin (auth) — save the tenant's chatbot config. */
export async function apiSaveChatbotConfig(cfg: Partial<ApiChatbotConfig>): Promise<ApiChatbotConfig | null> {
  const r = await request<{ config: ApiChatbotConfig | null }>('/api/chatbot/config', { method: 'PUT', body: JSON.stringify(cfg) });
  return r.config;
}

// ── Invoices, CRM tasks, audit trail, tenant provisioning ──────────────────
// The endpoints added in migration 030 / a76f369. These replace the last of
// the localStorage-only tables.

export async function apiGetInvoices(): Promise<Invoice[]> {
  const res = await request<{ invoices: Invoice[] }>('/api/invoices');
  return res.invoices;
}

export async function apiCreateInvoice(input: Partial<Invoice>): Promise<Invoice> {
  const res = await request<{ invoice: Invoice }>('/api/invoices', {
    method: 'POST', body: JSON.stringify(invoiceBody(input)),
  });
  return res.invoice;
}

export async function apiUpdateInvoice(id: string, patch: Partial<Invoice>): Promise<Invoice> {
  const res = await request<{ invoice: Invoice }>(`/api/invoices/${id}`, {
    method: 'PATCH', body: JSON.stringify(invoiceBody(patch)),
  });
  return res.invoice;
}

export async function apiDeleteInvoice(id: string): Promise<void> {
  await request<void>(`/api/invoices/${id}`, { method: 'DELETE' });
}

/** id/tenantId are server-owned; only send what the route accepts. */
function invoiceBody(i: Partial<Invoice>): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (i.leadId) b.leadId = i.leadId;
  if (i.leadName !== undefined) b.leadName = i.leadName;
  if (i.project !== undefined) b.project = i.project;
  if (i.type !== undefined) b.type = i.type;
  if (i.amount !== undefined) b.amount = i.amount;
  // The API takes plain dates; the SPA carries ISO timestamps.
  if (i.date) b.date = String(i.date).slice(0, 10);
  if (i.dueDate) b.dueDate = String(i.dueDate).slice(0, 10);
  if (i.status !== undefined) b.status = i.status;
  return b;
}

export async function apiGetTasks(): Promise<Task[]> {
  const res = await request<{ tasks: Task[] }>('/api/crm-tasks');
  return res.tasks;
}

export async function apiCreateTask(input: Partial<Task>): Promise<Task> {
  const res = await request<{ task: Task }>('/api/crm-tasks', {
    method: 'POST', body: JSON.stringify(taskBody(input)),
  });
  return res.task;
}

export async function apiUpdateTask(id: string, patch: Partial<Task>): Promise<Task> {
  const res = await request<{ task: Task }>(`/api/crm-tasks/${id}`, {
    method: 'PATCH', body: JSON.stringify(taskBody(patch)),
  });
  return res.task;
}

export async function apiDeleteTask(id: string): Promise<void> {
  await request<void>(`/api/crm-tasks/${id}`, { method: 'DELETE' });
}

function taskBody(t: Partial<Task>): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (t.userId) b.userId = t.userId;
  if (t.title !== undefined) b.title = t.title;
  if (t.description !== undefined) b.description = t.description;
  if (t.dueDate) b.dueDate = t.dueDate;
  if (t.priority !== undefined) b.priority = t.priority;
  if (t.status !== undefined) b.status = t.status;
  if (t.category !== undefined) b.category = t.category;
  return b;
}

export async function apiGetAuditLogs(limit = 200): Promise<AuditLog[]> {
  const res = await request<{ auditLogs: AuditLog[] }>(`/api/audit-logs?limit=${limit}`);
  return res.auditLogs;
}

export async function apiGetTenants(): Promise<Tenant[]> {
  const res = await request<{ tenants: Tenant[] }>('/api/tenants');
  return res.tenants;
}

/** The temp password comes back exactly once — it is never readable again. */
export async function apiCreateTenant(input: {
  name: string; company?: string; slug: string; email: string;
  adminName: string; adminEmail: string; plan?: string; country?: string; currency?: string; phone?: string;
}): Promise<{ tenant: Tenant; admin: { id: string; email: string }; tempPassword: string }> {
  return request('/api/tenants', { method: 'POST', body: JSON.stringify(input) });
}

export async function apiUpdateTenant(
  id: string,
  patch: { plan?: string; status?: string; branchId?: string | null; name?: string; phone?: string },
): Promise<Tenant> {
  const res = await request<{ tenant: Tenant }>(`/api/tenants/${id}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
  return res.tenant;
}

/** Per-tenant usage for the platform console's "tenant health" panel. Counted
 *  by the SERVER — RLS means the browser can never count another tenant's rows,
 *  which is why the panel used to report zero for every workspace. */
export interface TenantUsage {
  per: Record<string, number>;
  totalRows: number;
  storageKb: number | null;
  users: number;
  userTotal: number;
  leads: number;
  booked: number;
  revenue: number;
  lastActivity: string | null;
}

export async function apiGetTenantUsage(id: string): Promise<TenantUsage> {
  const res = await request<{ usage: TenantUsage }>(`/api/tenants/${id}/usage`);
  return res.usage;
}

/**
 * Open a support session inside a customer workspace.
 *
 * The platform token is stashed first so the "Return to admin" banner can put
 * it back; the support token deliberately expires in 30 minutes, so a forgotten
 * session closes itself.
 */
export async function apiImpersonateTenant(
  tenantId: string,
  userId?: string,
): Promise<{ user: { id: string; name: string; email: string; role: string }; expiresInMinutes: number }> {
  const res = await request<{
    token: string;
    expiresInMinutes: number;
    user: { id: string; name: string; email: string; role: string };
    tenant: { id: string; name: string; company: string; slug: string; plan: string;
              status: string; country: string; currency: string };
  }>(`/api/tenants/${tenantId}/impersonate`, {
    method: 'POST', body: JSON.stringify(userId ? { userId } : {}),
  });
  // Back up BOTH halves of the platform session. Restoring the token alone
  // lands "Return to admin" on /login, because identity is hydrated from the
  // stored session object, not from the token.
  const current = localStorage.getItem(TOKEN_KEY);
  if (current) localStorage.setItem('friendly_crm_api_token_admin_backup', current);
  const currentSession = localStorage.getItem(SESSION_KEY);
  if (currentSession) localStorage.setItem('friendly_crm_api_session_admin_backup', currentSession);
  localStorage.setItem(TOKEN_KEY, res.token);

  // The SPA hydrates identity from the stored session, not from the token, so
  // swapping the token alone lands on /login. The impersonate response carries
  // both halves precisely so no extra round-trip is needed here.
  const user: User = {
    id: res.user.id, tenantId: res.tenant.id, name: res.user.name,
    email: res.user.email, password: '', role: res.user.role as Role,
    avatar: '', phone: '', active: true, createdAt: new Date().toISOString(),
    mustChangePassword: false,
  };
  const tenant: Tenant = {
    id: res.tenant.id, name: res.tenant.name, company: res.tenant.company,
    logo: '', brandVoice: '', audience: '', channels: [],
    plan: res.tenant.plan, status: res.tenant.status as Tenant['status'],
    country: res.tenant.country, currency: res.tenant.currency,
    slug: res.tenant.slug,
    email: '', phone: '', address: '', createdAt: new Date().toISOString(),
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify({ user, tenant }));
  return { user: res.user, expiresInMinutes: res.expiresInMinutes };
}

/** Move a lead's activity timeline to another lead (duplicate merge). */
export async function apiReassignLeadActivities(fromLeadId: string, toLeadId: string): Promise<number> {
  const res = await request<{ moved: number }>('/api/lead-activities/reassign', {
    method: 'POST', body: JSON.stringify({ fromLeadId, toLeadId }),
  });
  return res.moved;
}

// ── Notifications (migration 040) ────────────────────────────────────────────
//
// These replace eight toggles that lived in localStorage and were read by
// nothing. Every call is scoped server-side to the caller — there is no user id
// in any signature, deliberately, because an inbox belongs to one person and
// passing an id would be a second way to address it.

export interface ApiNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  readAt: string | null;
  createdAt: string;
}

export async function apiGetNotifications(unreadOnly = false):
  Promise<{ notifications: ApiNotification[]; unreadCount: number }> {
  return request<{ notifications: ApiNotification[]; unreadCount: number }>(
    `/api/notifications${unreadOnly ? '?unreadOnly=true' : ''}`);
}

export async function apiMarkNotificationRead(id: string): Promise<void> {
  await request<{ notification: ApiNotification }>(`/api/notifications/${id}`, { method: 'PATCH' });
}

export async function apiMarkAllNotificationsRead(): Promise<number> {
  const res = await request<{ marked: number }>('/api/notifications/read-all', { method: 'POST' });
  return res.marked;
}

export async function apiGetNotificationPrefs(): Promise<Record<string, boolean>> {
  const res = await request<{ prefs: Record<string, boolean> }>('/api/notification-prefs');
  return res.prefs;
}

export async function apiSetNotificationPref(kind: string, enabled: boolean): Promise<void> {
  await request<{ kind: string; enabled: boolean }>(`/api/notification-prefs/${kind}`, {
    method: 'PUT', body: JSON.stringify({ enabled }),
  });
}

// ── Site visits (migration 043) ──────────────────────────────────────────────
//
// The conversion event in this industry, and previously unmeasurable: a visit
// could be logged as an activity but not scheduled, reassigned, rescheduled or
// counted. Scoping is server-side — a rep restricted to their own leads sees
// only visits assigned to them, so there is no filter to get wrong here.

export interface ApiSiteVisit {
  id: string;
  leadId: string;
  leadName?: string;
  projectId?: string;
  unitId?: string;
  assignedTo: string;
  assigneeName?: string;
  scheduledAt: string;
  durationMinutes: number;
  status: 'scheduled' | 'confirmed' | 'completed' | 'no_show' | 'cancelled';
  outcome?: 'interested' | 'not_interested' | 'needs_followup' | 'booked';
  feedback: string;
  rescheduledFrom?: string;
  completedAt: string | null;
  createdAt: string;
}

export async function apiGetSiteVisits(q: {
  from?: string; to?: string; status?: string; leadId?: string;
} = {}): Promise<ApiSiteVisit[]> {
  const qs = new URLSearchParams(
    Object.entries(q).filter(([, v]) => v !== undefined) as [string, string][]).toString();
  const res = await request<{ siteVisits: ApiSiteVisit[] }>(`/api/site-visits${qs ? '?' + qs : ''}`);
  return res.siteVisits;
}

export async function apiGetSiteVisitFunnel(from?: string, to?: string):
  Promise<{ scheduled: number; completed: number; noShow: number; booked: number }> {
  const qs = new URLSearchParams(
    Object.entries({ from, to }).filter(([, v]) => v !== undefined) as [string, string][]).toString();
  const res = await request<{ funnel: { scheduled: number; completed: number; noShow: number; booked: number } }>(
    `/api/site-visits/funnel${qs ? '?' + qs : ''}`);
  return res.funnel;
}

export async function apiScheduleSiteVisit(input: {
  leadId: string; assignedTo: string; scheduledAt: string;
  projectId?: string; unitId?: string; durationMinutes?: number;
}): Promise<ApiSiteVisit> {
  const res = await request<{ siteVisit: ApiSiteVisit }>('/api/site-visits', {
    method: 'POST', body: JSON.stringify(input),
  });
  return res.siteVisit;
}

/** Moving a visit creates a NEW one linked to the old — the slip stays visible. */
export async function apiRescheduleSiteVisit(id: string, scheduledAt: string, assignedTo?: string): Promise<ApiSiteVisit> {
  const res = await request<{ siteVisit: ApiSiteVisit }>(`/api/site-visits/${id}/reschedule`, {
    method: 'POST', body: JSON.stringify({ scheduledAt, assignedTo }),
  });
  return res.siteVisit;
}

/** `completed` requires an outcome; anything else must not carry one. */
export async function apiCloseSiteVisit(
  id: string,
  status: 'confirmed' | 'completed' | 'no_show' | 'cancelled',
  outcome?: ApiSiteVisit['outcome'],
  feedback?: string,
): Promise<ApiSiteVisit> {
  const res = await request<{ siteVisit: ApiSiteVisit }>(`/api/site-visits/${id}`, {
    method: 'PATCH', body: JSON.stringify({ status, outcome, feedback }),
  });
  return res.siteVisit;
}

// ── Demand letters (migration 041) ───────────────────────────────────────────
//
// Dunning: the letter that turns an overdue milestone into a demand carrying
// delay interest. Amounts are FROZEN by the server when the letter is issued —
// the client never recomputes them, because a letter that quotes a different
// figure to the one the customer received is worse than no letter.

export interface ApiDemandLetter {
  id: string;
  bookingId: string;
  paymentScheduleId: string;
  letterNo: string;
  issuedOn: string;
  dueOn: string;
  principalAmount: number;
  interestAmount: number;
  totalAmount: number;
  interestPct: number;
  daysOverdue: number;
  status: 'issued' | 'paid' | 'cancelled';
  reminderCount: number;
  lastReminderAt?: string | null;
  milestoneName?: string;
  customerName?: string;
}

/** A milestone that COULD be demanded, with what the demand would be worth
 *  today — so the decision is made with the number visible. */
export interface ApiDemandDue {
  paymentScheduleId: string;
  bookingId: string;
  milestoneName: string;
  dueDate: string;
  customerName?: string;
  daysOverdue: number;
  outstanding: number;
  interest: number;
  interestPct: number;
  total: number;
}

export async function apiGetDemandLetters(status?: string): Promise<ApiDemandLetter[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await request<{ demandLetters: ApiDemandLetter[] }>(`/api/demand-letters${q}`);
  return res.demandLetters;
}

export async function apiGetDemandsDue(): Promise<ApiDemandDue[]> {
  const res = await request<{ due: ApiDemandDue[] }>('/api/demand-letters/due');
  return res.due;
}

export async function apiIssueDemandLetter(paymentScheduleId: string, dueInDays?: number): Promise<ApiDemandLetter> {
  const res = await request<{ demandLetter: ApiDemandLetter }>('/api/demand-letters', {
    method: 'POST', body: JSON.stringify({ paymentScheduleId, ...(dueInDays ? { dueInDays } : {}) }),
  });
  return res.demandLetter;
}

export async function apiSettleDemandLetter(id: string, status: 'paid' | 'cancelled'): Promise<ApiDemandLetter> {
  const res = await request<{ demandLetter: ApiDemandLetter }>(`/api/demand-letters/${id}`, {
    method: 'PATCH', body: JSON.stringify({ status }),
  });
  return res.demandLetter;
}

export async function apiRemindDemandLetter(id: string): Promise<ApiDemandLetter> {
  const res = await request<{ demandLetter: ApiDemandLetter }>(`/api/demand-letters/${id}/remind`, { method: 'POST' });
  return res.demandLetter;
}

// ── RERA & escrow (migration 042) ────────────────────────────────────────────
//
// The seventy per cent designated-account obligation, made countable. This
// MEASURES; it does not move money and posts no journals — `inAccount` is only
// as good as the bank transactions that have been entered, which is why a
// project whose designated account was never reconciled shows its whole
// obligation as a shortfall.

export interface ApiReraRegistration {
  id: string;
  projectId: string;
  projectName: string;
  registrationNo?: string;
  registeredOn?: string | null;
  validUntil?: string | null;
  escrowPct: number;
  designatedBankAccountId?: string;
  designatedAccountName?: string;
  designatedBankName?: string;
  status: string;
}

export interface ApiReraPosition {
  projectId: string;
  projectName: string;
  registrationNo?: string;
  escrowPct: number;
  collected: number;
  required: number;
  inAccount: number;
  shortfall: number;
  hasDesignatedAccount: boolean;
}

export async function apiGetReraRegistrations(): Promise<ApiReraRegistration[]> {
  const res = await request<{ registrations: ApiReraRegistration[] }>('/api/rera/registrations');
  return res.registrations;
}

export async function apiGetReraPosition(): Promise<ApiReraPosition[]> {
  const res = await request<{ position: ApiReraPosition[] }>('/api/rera/position');
  return res.position;
}

export async function apiRegisterProjectRera(input: {
  projectId: string; registeredOn?: string; validUntil?: string;
  escrowPct?: number; designatedBankAccountId?: string;
}): Promise<{ id: string; projectId: string; escrowPct: number }> {
  const res = await request<{ registration: { id: string; projectId: string; escrowPct: number } }>(
    '/api/rera/registrations', { method: 'POST', body: JSON.stringify(input) });
  return res.registration;
}

/** Idempotent by construction — one allocation per payment, enforced by a
 *  unique index. Pressing it twice must not double the obligation. */
export async function apiAllocateEscrow(projectId?: string): Promise<number> {
  const res = await request<{ allocated: number }>('/api/rera/allocate', {
    method: 'POST', body: JSON.stringify(projectId ? { projectId } : {}),
  });
  return res.allocated;
}
