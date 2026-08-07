/**
 * Construction-linked demand automation + buyer ledger.
 *
 * In real-estate ERP the flagship feature (In4Velocity / Farvision) is that
 * completing a construction milestone automatically RAISES the matching payment
 * demand on every buyer in that project: the installment flips pending→demanded,
 * a demand letter is generated, and the amount posts to the buyer's ledger.
 *
 * A demand (debit) and a receipt (credit) are both written to
 * `customerLedger`, which powers the per-buyer Statement of Account.
 */
import { getByTenant, getById, create, update, logAudit } from './db';
import type { PaymentPlan, Installment, Booking, Lead, Tower, Document, CustomerLedgerEntry } from '../types';

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Resolve the project a booking belongs to (explicit field, else unit→tower). */
function bookingProjectId(booking: Booking): string | undefined {
  if (booking.projectId) return booking.projectId;
  const unit = getById<{ id: string; towerId: string }>('units', booking.unitId);
  if (!unit) return undefined;
  return getById<Tower>('towers', unit.towerId)?.projectId;
}

interface Actor { id: string; name: string }

/**
 * Raise the demand for one installment: mark it demanded, post a debit to the
 * buyer ledger, and generate a demand-letter document. No-op (returns null) if
 * the installment isn't pending.
 */
export function raiseDemand(tenantId: string, plan: PaymentPlan, installmentId: string, actor?: Actor, reason?: string): PaymentPlan | null {
  const inst = plan.installments.find(i => i.id === installmentId);
  if (!inst || inst.status !== 'pending') return null;

  const now = new Date().toISOString();
  const installments = plan.installments.map(i =>
    i.id === installmentId ? { ...i, status: 'demanded' as const, demandedDate: now } : i,
  );
  const updated = update<PaymentPlan>('paymentPlans', plan.id, { installments })!;

  const lead = getById<Lead>('leads', plan.leadId);
  const booking = getById<Booking>('bookings', plan.bookingId);
  const projectName = lead?.project || 'Project';
  const buyer = lead?.name || 'Customer';

  // Buyer-ledger debit (feeds the Statement of Account).
  create<CustomerLedgerEntry>('customerLedger', {
    id: '', tenantId, leadId: plan.leadId, bookingId: plan.bookingId,
    date: now, type: 'demand',
    description: `Demand: ${inst.description}${reason ? ` — ${reason}` : ''}`,
    debit: inst.amount, credit: 0,
  });

  // Demand-letter document in the register.
  create<Document>('documents', {
    id: '', tenantId,
    name: `Demand Letter — ${buyer} · Inst #${inst.number}`,
    type: 'Demand Letter', project: projectName,
    date: now, size: '—', status: 'Raised', url: '',
  });

  if (actor) {
    logAudit({
      tenantId, userId: actor.id, userName: actor.name,
      action: 'create', entity: 'payment_plan', entityId: plan.id,
      details: `Raised demand for ${buyer} — ${inst.description}${reason ? ` (${reason})` : ''}`,
    });
  }
  void booking;
  return updated;
}

/**
 * A construction milestone completed → auto-raise every matching construction-
 * linked demand across that project's buyers. Returns how many demands fired
 * and their total value.
 */
export function raiseConstructionDemands(tenantId: string, projectId: string, milestoneTitle: string, actor?: Actor): { count: number; total: number } {
  const bookings = getByTenant<Booking>('bookings', tenantId).filter(b => bookingProjectId(b) === projectId);
  const bookingIds = new Set(bookings.map(b => b.id));
  const plans = getByTenant<PaymentPlan>('paymentPlans', tenantId).filter(p => bookingIds.has(p.bookingId));
  const mt = norm(milestoneTitle);

  let count = 0, total = 0;
  for (const plan of plans) {
    // Re-read the plan each iteration isn't needed; raiseDemand persists per call.
    let current: PaymentPlan | undefined = plan;
    for (const inst of plan.installments) {
      if (inst.trigger !== 'construction_milestone' || inst.status !== 'pending' || !inst.milestoneLabel) continue;
      const ml = norm(inst.milestoneLabel);
      if (!(mt.includes(ml) || ml.includes(mt))) continue;
      const next: PaymentPlan | null = raiseDemand(tenantId, current!, inst.id, actor, `Milestone reached: ${milestoneTitle}`);
      if (next) { current = next; count++; total += inst.amount; }
    }
  }
  return { count, total };
}

/** Post a receipt (credit) to the buyer ledger when an installment is paid. */
export function recordReceipt(tenantId: string, plan: PaymentPlan, inst: Installment): void {
  create<CustomerLedgerEntry>('customerLedger', {
    id: '', tenantId, leadId: plan.leadId, bookingId: plan.bookingId,
    date: new Date().toISOString(), type: 'receipt',
    description: `Receipt: ${inst.description}`,
    debit: 0, credit: inst.amount,
  });
}

export interface LedgerRow extends CustomerLedgerEntry { balance: number }

/** A buyer's Statement of Account: ledger entries (by lead or booking) sorted
 *  oldest-first with a running balance. */
export function getCustomerLedger(tenantId: string, filter: { leadId?: string; bookingId?: string }): { rows: LedgerRow[]; demanded: number; received: number; balance: number } {
  const entries = getByTenant<CustomerLedgerEntry>('customerLedger', tenantId)
    .filter(e => (filter.leadId ? e.leadId === filter.leadId : true) && (filter.bookingId ? e.bookingId === filter.bookingId : true))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  let balance = 0, demanded = 0, received = 0;
  const rows: LedgerRow[] = entries.map(e => {
    balance += e.debit - e.credit;
    demanded += e.debit;
    received += e.credit;
    return { ...e, balance };
  });
  return { rows, demanded, received, balance };
}
