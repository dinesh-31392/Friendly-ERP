import { getApiUrl, getApiToken, isApiEnabled } from './apiClient';

/**
 * Leasing, CAM billing and owner payouts — the client for migration 036.
 *
 * SERVER-ONLY BY DESIGN. Every other module in this SPA has a localStorage
 * twin so the browser-only demo build still works. Leasing deliberately does
 * not: rent generation is an idempotent `INSERT … ON CONFLICT` against a unique
 * key, escalation compounds in SQL, and an owner payout freezes on approval by
 * a database CHECK. A localStorage imitation would reproduce the screens while
 * quietly getting the arithmetic and the maker/checker rule wrong, which on
 * somebody's rent ledger is worse than not shipping the demo at all.
 *
 * So `isLeasingAvailable()` is false without a backend and the page says so,
 * rather than showing a convincing empty module.
 *
 * This file carries its own `request` (apiClient's is module-private) rather
 * than exporting a new one from that heavily-shared file.
 */

export function isLeasingAvailable(): boolean {
  return isApiEnabled();
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${getApiUrl()}${path}`, {
    ...init,
    headers: {
      // Only declare a JSON body when there is one — Fastify rejects an empty
      // body that claims application/json.
      ...(init.body !== undefined && init.body !== null ? { 'Content-Type': 'application/json' } : {}),
      ...(getApiToken() ? { Authorization: `Bearer ${getApiToken()}` } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `API error ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json().catch(() => {
    throw new Error('The API returned an unexpected (non-JSON) response');
  }) as Promise<T>;
}

const body = (v: unknown) => JSON.stringify(v);

// ── Occupants ────────────────────────────────────────────────────────────────

export interface Occupant {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  phone: string;
  occupantType: 'individual' | 'company';
  companyName: string;
  kycStatus: 'pending' | 'verified';
  leadId?: string;
  createdAt: string;
}

export async function fetchOccupants(): Promise<Occupant[]> {
  return (await request<{ occupants: Occupant[] }>('/api/occupants')).occupants;
}

export async function createOccupant(input: {
  name: string; email?: string; phone?: string;
  occupantType?: 'individual' | 'company'; companyName?: string;
  kycStatus?: 'pending' | 'verified';
}): Promise<Occupant> {
  return (await request<{ occupant: Occupant }>('/api/occupants', { method: 'POST', body: body(input) })).occupant;
}

// ── Leases ───────────────────────────────────────────────────────────────────

export type LeaseStatus = 'draft' | 'active' | 'terminated' | 'expired' | 'renewed';

export interface Lease {
  id: string;
  tenantId: string;
  unitId: string;
  occupantId: string;
  ownerCustomerId?: string;
  leaseCode: string;
  /** Plain 'YYYY-MM-DD'. The server maps DATE columns to calendar days so a
   *  timezone east of Greenwich cannot shift a rent period by a day. */
  startDate: string;
  endDate: string;
  rentAmount: number;
  depositAmount: number;
  escalationPercent: number;
  escalationMonths: number;
  camRatePerSqft: number;
  camBilledTo: 'occupant' | 'owner';
  managementFeePercent: number;
  noticePeriodDays: number;
  status: LeaseStatus;
  terminatedOn?: string;
  terminationReason?: string;
  renewedFromId?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export async function fetchLeases(params: { status?: LeaseStatus; unitId?: string; expiringInDays?: number } = {}): Promise<Lease[]> {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.unitId) q.set('unitId', params.unitId);
  if (params.expiringInDays) q.set('expiringInDays', String(params.expiringInDays));
  const qs = q.toString();
  return (await request<{ leases: Lease[] }>(`/api/leases${qs ? `?${qs}` : ''}`)).leases;
}

export async function createLease(input: {
  unitId: string; occupantId: string; ownerCustomerId?: string; leaseCode?: string;
  startDate: string; endDate: string; rentAmount: number; depositAmount?: number;
  escalationPercent?: number; escalationMonths?: number;
  camRatePerSqft?: number; camBilledTo?: 'occupant' | 'owner';
  managementFeePercent?: number; noticePeriodDays?: number; status?: LeaseStatus;
}): Promise<Lease> {
  return (await request<{ lease: Lease }>('/api/leases', { method: 'POST', body: body(input) })).lease;
}

export async function patchLease(id: string, patch: Partial<Lease>): Promise<Lease> {
  return (await request<{ lease: Lease }>(`/api/leases/${id}`, { method: 'PATCH', body: body(patch) })).lease;
}

// ── Rent invoices, receipts, CAM ─────────────────────────────────────────────

export interface LeaseInvoice {
  id: string;
  tenantId: string;
  leaseId: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  rentAmount: number;
  camAmount: number;
  otherCharges: number;
  totalAmount: number;
  amountPaid: number;
  status: 'pending' | 'partially_paid' | 'paid' | 'cancelled';
  createdAt: string;
}

export interface MaintenanceBill {
  id: string;
  tenantId: string;
  unitId: string;
  leaseId?: string;
  billTo: 'occupant' | 'owner';
  occupantId?: string;
  ownerCustomerId?: string;
  periodStart: string;
  periodEnd: string;
  ratePerSqft: number;
  amount: number;
  dueDate: string;
  amountPaid: number;
  status: 'pending' | 'partially_paid' | 'paid' | 'waived';
  notes: string;
  createdAt: string;
}

export interface BillingRun {
  rentInvoicesCreated: number;
  maintenanceBillsCreated: number;
  invoices: LeaseInvoice[];
  maintenanceBills: MaintenanceBill[];
}

export async function fetchLeaseInvoices(params: { leaseId?: string; status?: string; overdue?: boolean } = {}): Promise<LeaseInvoice[]> {
  const q = new URLSearchParams();
  if (params.leaseId) q.set('leaseId', params.leaseId);
  if (params.status) q.set('status', params.status);
  if (params.overdue) q.set('overdue', 'true');
  const qs = q.toString();
  return (await request<{ leaseInvoices: LeaseInvoice[] }>(`/api/lease-invoices${qs ? `?${qs}` : ''}`)).leaseInvoices;
}

/**
 * The whole-workspace monthly run. Safe to press twice: the server's unique
 * keys make a repeat a no-op, and the counts returned are only what was NEWLY
 * raised — which is why the toast can state a number without lying.
 */
export async function runBilling(through?: string): Promise<BillingRun> {
  return request<BillingRun>('/api/leasing/run-billing', {
    method: 'POST', body: body(through ? { through } : {}),
  });
}

export async function generateLeaseInvoices(leaseId: string, through?: string): Promise<{ created: number; invoices: LeaseInvoice[]; maintenanceBills: MaintenanceBill[] }> {
  return request(`/api/leases/${leaseId}/generate-invoices`, {
    method: 'POST', body: body(through ? { through } : {}),
  });
}

export async function recordReceipt(input: {
  leaseInvoiceId: string; amount: number; paymentDate?: string;
  mode?: 'cheque' | 'bank_transfer' | 'upi' | 'cash' | 'card'; referenceNo?: string;
}): Promise<{ leaseInvoice?: LeaseInvoice }> {
  return request('/api/lease-receipts', { method: 'POST', body: body(input) });
}

export async function fetchMaintenanceBills(params: { unitId?: string; leaseId?: string; status?: string } = {}): Promise<MaintenanceBill[]> {
  const q = new URLSearchParams();
  if (params.unitId) q.set('unitId', params.unitId);
  if (params.leaseId) q.set('leaseId', params.leaseId);
  if (params.status) q.set('status', params.status);
  const qs = q.toString();
  return (await request<{ maintenanceBills: MaintenanceBill[] }>(`/api/maintenance-bills${qs ? `?${qs}` : ''}`)).maintenanceBills;
}

// ── Owner payouts ────────────────────────────────────────────────────────────

export interface OwnerPayout {
  id: string;
  tenantId: string;
  leaseId: string;
  ownerCustomerId?: string;
  periodStart: string;
  periodEnd: string;
  grossCollected: number;
  managementFeePercent: number;
  managementFeeAmount: number;
  otherDeductions: number;
  netPayable: number;
  status: 'pending' | 'approved' | 'paid' | 'on_hold';
  approvedBy?: string;
  approvedAt?: string;
  paidAt?: string;
  paymentReference: string;
  createdAt: string;
}

export async function fetchOwnerPayouts(params: { status?: string; leaseId?: string } = {}): Promise<OwnerPayout[]> {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.leaseId) q.set('leaseId', params.leaseId);
  const qs = q.toString();
  return (await request<{ ownerPayouts: OwnerPayout[] }>(`/api/owner-payouts${qs ? `?${qs}` : ''}`)).ownerPayouts;
}

export async function generateOwnerPayouts(input: { through?: string; leaseId?: string } = {}): Promise<{ generated: number; ownerPayouts: OwnerPayout[] }> {
  return request('/api/owner-payouts/generate', { method: 'POST', body: body(input) });
}

export async function patchOwnerPayout(
  id: string,
  patch: { status?: OwnerPayout['status']; otherDeductions?: number; paymentReference?: string },
): Promise<OwnerPayout> {
  return (await request<{ ownerPayout: OwnerPayout }>(`/api/owner-payouts/${id}`, {
    method: 'PATCH', body: body(patch),
  })).ownerPayout;
}
