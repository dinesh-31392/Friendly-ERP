import { v4 as uuid } from 'uuid';
// Only Tenant is needed now: the demo seed that referenced every entity type
// has been removed, so this module is a pure storage layer again.
import type { Tenant } from '../types';

const DB_PREFIX = 'friendly_crm_';

type TableName = 'tenants' | 'users' | 'projects' | 'towers' | 'units' | 'leads' | 'notes' |
  'activities' | 'reminders' | 'tasks' | 'bookings' | 'invoices' | 'tickets' |
  'campaigns' | 'documents' | 'conversations' | 'chatMessages' | 'auditLogs' |
  'templates' | 'agreements' | 'brokers' | 'commissions' | 'integrations' | 'portalUsers' | 'paymentPlans' | 'branches' |
  // ERP modules: project execution, procurement & materials, AP/budgets
  'siteTasks' | 'progressUpdates' | 'rfis' | 'changeOrders' | 'inspections' |
  'vendors' | 'purchaseOrders' | 'materials' | 'stockTxns' | 'machines' |
  'vendorBills' | 'projectBudgets' |
  // ERP: HR & workforce, statutory compliance, signed-in device sessions
  'employees' | 'attendance' | 'leaveRequests' | 'payrollRuns' |
  'complianceItems' | 'sessions' |
  // ERP: double-entry ledger, RA billing, AP payments, quotations, approvals
  'accounts' | 'journalEntries' | 'raBills' | 'paymentsMade' |
  'quotations' | 'approvalRules' |
  // ERP: banking & reconciliation, loans
  'bankAccounts' | 'bankTransactions' | 'loans' |
  // ERP: land acquisition (deal → feasibility → convert-to-project)
  'landLeads' | 'feasibilityRecords' | 'landDocuments' |
  // ERP: business development (deal sourcing → hand-off into land)
  'bdLeads' | 'marketReports' |
  // Sales: buyer Statement of Account (construction-linked demands + receipts)
  'customerLedger';

function readTable<T>(table: TableName): T[] {
  try {
    const raw = localStorage.getItem(DB_PREFIX + table);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

/** @returns true when the write actually landed. Callers MUST honour false. */
function writeTable<T>(table: TableName, data: T[]): boolean {
  try {
    localStorage.setItem(DB_PREFIX + table, JSON.stringify(data));
    return true;
  } catch (err) {
    // QuotaExceededError: surface it instead of crashing the save silently
    console.error(`Failed to write table "${table}"`, err);
    import('react-hot-toast').then(({ default: toast }) =>
      toast.error('Browser storage is full — the last change was NOT saved. Free space in Settings → Data & Privacy (large logos are a common cause).', { id: 'quota' })
    );
    return false;
  }
}

export function getAll<T>(table: TableName): T[] {
  return readTable<T>(table);
}

export function getById<T extends { id: string }>(table: TableName, id: string): T | undefined {
  return readTable<T>(table).find(r => r.id === id);
}

export function getByTenant<T extends { tenantId: string }>(table: TableName, tenantId: string): T[] {
  return readTable<T>(table).filter(r => r.tenantId === tenantId);
}

export function getByField<T>(table: TableName, field: string, value: unknown): T[] {
  return readTable<T>(table).filter(r => (r as Record<string, unknown>)[field] === value);
}

export function create<T extends { id?: string }>(table: TableName, record: T): T {
  const rows = readTable<T>(table);
  const newRecord = { ...record, id: (record as { id?: string }).id || uuid() } as T;
  rows.push(newRecord);
  // THROW when the write didn't land. Returning the record as though it saved
  // let callers march on through a multi-write cascade: Bookings creates the
  // booking, then marks the unit + lead 'booked' and writes an invoice and a
  // payment plan keyed to booking.id. If only the first write hit the quota the
  // end state was a locked unit, a lead moved to booked, and an invoice
  // pointing at a booking that does not exist — silent, permanent corruption.
  // Failing here stops the cascade before it can build orphans; the toast in
  // writeTable has already told the user why.
  if (!writeTable(table, rows)) throw new Error(`Storage full — "${table}" was not saved`);
  return newRecord;
}

export function update<T extends { id: string }>(table: TableName, id: string, updates: Partial<T>): T | undefined {
  const rows = readTable<T>(table);
  const idx = rows.findIndex(r => r.id === id);
  if (idx === -1) return undefined;
  rows[idx] = { ...rows[idx], ...updates };
  // The signature is already `T | undefined`. Returning undefined on a failed
  // write stops the UI from rendering a change that a reload silently reverts.
  if (!writeTable(table, rows)) return undefined;
  return rows[idx];
}

export function remove(table: TableName, id: string): boolean {
  const rows = readTable<{ id: string }>(table);
  const filtered = rows.filter(r => r.id !== id);
  if (filtered.length === rows.length) return false;
  writeTable(table, filtered);
  return true;
}

export function removeByTenant(table: TableName, tenantId: string): number {
  const rows = readTable<{ tenantId: string }>(table);
  const filtered = rows.filter(r => r.tenantId !== tenantId);
  const removed = rows.length - filtered.length;
  writeTable(table, filtered);
  return removed;
}

export function query<T>(
  table: TableName,
  filters: { tenantId?: string; [key: string]: unknown } = {},
  search?: { field: string; query: string }
): T[] {
  let rows = readTable<T>(table);
  const filterEntries = Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== 'all');
  for (const [key, value] of filterEntries) {
    rows = rows.filter(r => (r as Record<string, unknown>)[key] === value);
  }
  if (search && search.query) {
    const q = search.query.toLowerCase();
    rows = rows.filter(r => {
      const val = (r as Record<string, unknown>)[search.field];
      return typeof val === 'string' && val.toLowerCase().includes(q);
    });
  }
  return rows;
}

// Count helper
export function count(table: TableName, filters: Record<string, unknown> = {}): number {
  let rows = readTable<Record<string, unknown>>(table);
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null) {
      rows = rows.filter(r => r[key] === value);
    }
  }
  return rows.length;
}

// Upgrade existing installs with newly added seed entities
function applyUpgrades(): void {
  // v3: SaaS fields on tenants (status / currency / country)
  // v4: white-label fields (slug / primaryColor)
  const existingTenants = readTable<Tenant>('tenants');
  if (existingTenants.some(t => !t.status || !t.slug)) {
    // Back-fill slugs WITHOUT collisions. On legacy installs whose tenants
    // predate the slug field, two builders with the same company name both
    // derived the SAME subdomain here and silently hijacked each other's portal
    // login, microsite, and branding. db.ts is the storage layer and cannot
    // import portalService (that would cycle), so the dedup is inlined.
    const taken = new Set(existingTenants.map(t => t.slug).filter(Boolean) as string[]);
    const backfill = (name: string): string => {
      const root = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'builder';
      let slug = root;
      for (let n = 2; taken.has(slug); n++) slug = `${root}-${n}`;
      taken.add(slug);
      return slug;
    };
    writeTable('tenants', existingTenants.map(t => ({
      status: 'active' as const, currency: 'INR', country: 'India',
      slug: t.slug || backfill(t.name),
      primaryColor: '#6366f1',
      ...t,
    })));
  }

  // NOTE: the demo super_admin (superadmin@friendlycrm.com / password123) and
  // the demo brokers + commissions that used to be injected here have been
  // removed for production. Injecting a known-password platform admin into any
  // install that lacked one was a backdoor: it re-created itself on every load,
  // so deleting the account did not get rid of it. The first platform admin is
  // now created once, by the operator, through first-run setup on the login
  // page (authService.createPlatformAdmin).
}

// Initialize with seed data if first run
/**
 * Production initializer. Ships EMPTY: no demo tenant, no demo users, no demo
 * leads/projects/bookings, no hardcoded passwords. A fresh install has zero
 * accounts, and the login page detects that and runs first-run setup, where the
 * operator creates the platform admin with a password they choose
 * (authService.needsSetup / createPlatformAdmin).
 *
 * applyUpgrades() still runs so existing installs keep their non-destructive
 * migrations (slug/status back-fill).
 */
export function initializeDatabase(): void {
  applyUpgrades();
}

// Audit log helper — records sensitive actions
export function logAudit(entry: {
  tenantId: string;
  userId: string;
  userName: string;
  action: string;
  entity: string;
  entityId: string;
  details: string;
}): void {
  type AuditRow = { id: string; tenantId: string; [k: string]: unknown };
  const logs = readTable<AuditRow>('auditLogs');
  logs.push({ ...entry, id: uuid(), createdAt: new Date().toISOString() });
  // Trim to the last 500 entries PER TENANT. A global slice(-500) let a busy
  // tenant silently evict a quieter tenant's trail (readers are tenant-scoped,
  // so entries just vanished from their Audit Log with no warning) — and it
  // evicted the platform's own governance records (approve / reject /
  // impersonate / credential reveals, written under the 'platform'
  // pseudo-tenant), which are the most security-sensitive rows here.
  const keep = new Set(
    logs.filter(l => l.tenantId === entry.tenantId).slice(-500).map(l => l.id),
  );
  writeTable('auditLogs', logs.filter(l => l.tenantId !== entry.tenantId || keep.has(l.id)));
}

// Utility to clear all data (for reset)
export function clearDatabase(): void {
  const keys = Object.keys(localStorage).filter(k => k.startsWith(DB_PREFIX));
  keys.forEach(k => localStorage.removeItem(k));
}
