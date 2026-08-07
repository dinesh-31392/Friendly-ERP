/**
 * Billing (AP + compliance + budgets) write dispatcher and shape mappers.
 * API mode talks to Fastify/Postgres (RLS+RBAC); demo mode keeps the exact
 * localStorage behavior.
 *
 * Status vocabularies differ by design and are translated at this boundary:
 * the SPA's bill status is pending/approved/paid; the DB adds draft/disputed
 * and calls the first state `submitted`.
 */
import { create, update, remove } from './db';
import type {
  VendorBill, VendorBillStatus, PaymentMade, ComplianceItem, ProjectBudget, FilingFrequency,
} from '../types';
import {
  isApiEnabled,
  apiGetVendorBills, apiCreateVendorBill, apiUpdateVendorBill, apiDeleteVendorBill,
  apiRecordApPayment,
  apiGetComplianceItems, apiCreateComplianceItem, apiUpdateComplianceItem, apiDeleteComplianceItem,
  apiGetBudgets, apiSetBudget,
  type ApiVendorBill, type ApiComplianceItem, type ApiBudget,
} from './apiClient';

const day = (v: unknown) => (v ? String(v).slice(0, 10) : '');

/** DB bill status → SPA. `submitted`/`draft` both read as pending. */
function billStatusToApp(s: string): VendorBillStatus {
  if (s === 'approved') return 'approved';
  if (s === 'paid') return 'paid';
  return 'pending';
}
/** SPA bill status → DB. */
function billStatusToDb(s: VendorBillStatus): string {
  return s === 'pending' ? 'submitted' : s;
}

// ── Server row → SPA shape ───────────────────────────────────────────────────

export function mapBill(r: ApiVendorBill, tenantId: string): VendorBill {
  return {
    id: r.id, tenantId, vendorId: r.vendorId,
    poId: r.poId || undefined, projectId: r.projectId || undefined,
    billNumber: r.billNo || '', category: r.category || '',
    // The SPA works in gross terms — total carries tax.
    amount: r.totalAmount ?? r.amount,
    billDate: day(r.billDate), dueDate: day(r.dueDate),
    status: billStatusToApp(r.status),
    paidAt: r.paidAt || undefined, notes: r.notes || undefined,
    createdAt: new Date().toISOString(),
  };
}

export function mapCompliance(r: ApiComplianceItem, tenantId: string): ComplianceItem {
  return {
    id: r.id, tenantId, title: r.title, authority: r.authority,
    dueDate: day(r.dueDate), frequency: r.frequency as FilingFrequency,
    projectId: r.projectId || undefined, amount: r.amount ?? undefined,
    notes: r.notes || undefined, status: r.status as ComplianceItem['status'],
    filedAt: r.filedAt || undefined, filedBy: r.filedBy || undefined,
    paidAt: r.paidAt || undefined, createdAt: new Date().toISOString(),
  };
}

export function mapBudget(r: ApiBudget, tenantId: string): ProjectBudget {
  return {
    id: r.id, tenantId, projectId: r.projectId, category: r.category,
    budgeted: r.allocatedAmount, createdAt: new Date().toISOString(),
  };
}

/** API mode: bills + compliance filings + budgets, mapped to SPA shapes. */
export async function fetchBillingData(tenantId: string): Promise<{
  bills: VendorBill[]; compliance: ComplianceItem[]; budgets: ProjectBudget[];
} | null> {
  if (!isApiEnabled()) return null;
  const [b, c, bu] = await Promise.all([apiGetVendorBills(), apiGetComplianceItems(), apiGetBudgets()]);
  return {
    bills: b.map(x => mapBill(x, tenantId)),
    compliance: c.map(x => mapCompliance(x, tenantId)),
    budgets: bu.map(x => mapBudget(x, tenantId)),
  };
}

// ── Mutations ────────────────────────────────────────────────────────────────

export async function createBill(data: VendorBill): Promise<VendorBill> {
  if (isApiEnabled()) {
    const r = await apiCreateVendorBill({
      vendorId: data.vendorId, projectId: data.projectId, poId: data.poId,
      billNo: data.billNumber, billDate: data.billDate, dueDate: data.dueDate,
      amount: data.amount, category: data.category, notes: data.notes,
    });
    return mapBill(r, data.tenantId);
  }
  return create<VendorBill>('vendorBills', data);
}

export async function setBillStatus(bill: VendorBill, status: VendorBillStatus): Promise<void> {
  if (isApiEnabled()) { await apiUpdateVendorBill(bill.id, billStatusToDb(status)); return; }
  update<VendorBill>('vendorBills', bill.id,
    status === 'paid' ? { status, paidAt: new Date().toISOString() } : { status });
}

export async function deleteBill(bill: VendorBill): Promise<void> {
  if (isApiEnabled()) { await apiDeleteVendorBill(bill.id); return; }
  remove('vendorBills', bill.id);
}

/** Record an AP payment; in API mode the server also flips the bill to paid. */
export async function recordApPayment(data: PaymentMade): Promise<PaymentMade> {
  if (isApiEnabled()) {
    const r = await apiRecordApPayment({
      vendorBillId: data.vendorBillId, raBillId: data.raBillId,
      amount: data.amount, mode: data.mode, referenceNo: data.reference,
    });
    return { ...data, id: r.id, date: day(r.date) || data.date };
  }
  return create<PaymentMade>('paymentsMade', data);
}

export async function createCompliance(data: ComplianceItem): Promise<ComplianceItem> {
  if (isApiEnabled()) {
    const r = await apiCreateComplianceItem({
      title: data.title, authority: data.authority, dueDate: data.dueDate,
      frequency: data.frequency, projectId: data.projectId, amount: data.amount, notes: data.notes,
    });
    return mapCompliance(r, data.tenantId);
  }
  return create<ComplianceItem>('complianceItems', data);
}

export async function setComplianceStatus(item: ComplianceItem, status: 'pending' | 'filed' | 'paid', userId: string): Promise<void> {
  if (isApiEnabled()) { await apiUpdateComplianceItem(item.id, status); return; }
  update<ComplianceItem>('complianceItems', item.id,
    status === 'paid'
      ? { status, paidAt: new Date().toISOString() }
      : { status, filedAt: new Date().toISOString(), filedBy: userId });
}

export async function deleteCompliance(item: ComplianceItem): Promise<void> {
  if (isApiEnabled()) { await apiDeleteComplianceItem(item.id); return; }
  remove('complianceItems', item.id);
}

/** Set one (project, category) budget cell; 0 clears it. */
export async function setBudget(
  tenantId: string, projectId: string, category: string, value: number, existing?: ProjectBudget,
): Promise<void> {
  if (isApiEnabled()) { await apiSetBudget({ projectId, category, allocatedAmount: value }); return; }
  if (existing) {
    if (value <= 0) remove('projectBudgets', existing.id);
    else update<ProjectBudget>('projectBudgets', existing.id, { budgeted: value });
  } else if (value > 0) {
    create<ProjectBudget>('projectBudgets', { id: '', tenantId, projectId, category, budgeted: value, createdAt: new Date().toISOString() });
  }
}
