import { v4 as uuid } from 'uuid';
import { getByTenant, create, update, logAudit } from './db';
import type { PaymentPlan, Installment, PaymentPlanType } from '../types';
import {
  isApiEnabled, apiGetPaymentSchedules, apiCreatePaymentSchedule,
  apiRecordPayment, apiUpdatePaymentSchedule,
} from './apiClient';

/** Milestone templates per payment-plan label. Percentages must sum to 100.
 *  Offsets are days from the booking date. */
const PLAN_TEMPLATES: Record<string, { type: PaymentPlanType; milestones: { pct: number; days: number; label: string }[] }> = {
  '30-70': {
    type: 'down_payment',
    milestones: [
      { pct: 10, days: 7, label: 'Booking amount' },
      { pct: 20, days: 45, label: 'Agreement signing' },
      { pct: 70, days: 365, label: 'On possession' },
    ],
  },
  '20-80': {
    type: 'down_payment',
    milestones: [
      { pct: 10, days: 7, label: 'Booking amount' },
      { pct: 10, days: 45, label: 'Agreement signing' },
      { pct: 80, days: 365, label: 'On possession' },
    ],
  },
  '40-60': {
    type: 'down_payment',
    milestones: [
      { pct: 10, days: 7, label: 'Booking amount' },
      { pct: 30, days: 60, label: 'Agreement + registration' },
      { pct: 60, days: 270, label: 'On possession' },
    ],
  },
  'construction-linked': {
    type: 'construction_linked',
    milestones: [
      { pct: 10, days: 7, label: 'Booking amount' },
      { pct: 15, days: 60, label: 'Foundation complete' },
      { pct: 15, days: 150, label: 'Plinth level' },
      { pct: 20, days: 270, label: 'Superstructure complete' },
      { pct: 20, days: 390, label: 'Finishing works' },
      { pct: 20, days: 480, label: 'On possession' },
    ],
  },
};

const FLEXI: { type: PaymentPlanType; milestones: { pct: number; days: number; label: string }[] } = {
  type: 'flexi',
  milestones: [
    { pct: 25, days: 7, label: '1st quarter installment' },
    { pct: 25, days: 90, label: '2nd quarter installment' },
    { pct: 25, days: 180, label: '3rd quarter installment' },
    { pct: 25, days: 270, label: '4th quarter installment' },
  ],
};

/** The plan template a label resolves to (falls back to flexi). */
export function planTemplate(planLabel: string): { type: PaymentPlanType; milestones: { pct: number; days: number; label: string }[] } {
  return PLAN_TEMPLATES[planLabel] || FLEXI;
}

/** Pure builder: plan template → installment list (no persistence). For a
 *  construction-linked plan, every installment after the booking amount is
 *  released by a construction milestone (not a fixed date) — tagged so a
 *  completed site milestone can auto-raise its demand. The final installment
 *  absorbs the rounding remainder so the schedule sums to exactly totalValue. */
export function buildInstallments(planLabel: string, totalValue: number, bookingDate?: string): Installment[] {
  const template = planTemplate(planLabel);
  const start = bookingDate ? new Date(bookingDate).getTime() : Date.now();
  const isCLP = template.type === 'construction_linked';
  const installments: Installment[] = template.milestones.map((m, i) => ({
    id: uuid(),
    number: i + 1,
    amount: Math.round((totalValue * m.pct) / 100),
    dueDate: new Date(start + m.days * 86400000).toISOString(),
    status: 'pending',
    description: `${m.label} (${m.pct}%)`,
    ...(isCLP && i > 0
      ? { trigger: 'construction_milestone' as const, milestoneLabel: m.label }
      : { trigger: 'time' as const }),
  }));
  const roundedSum = installments.reduce((s, i) => s + i.amount, 0);
  installments[installments.length - 1].amount += totalValue - roundedSum;
  return installments;
}

/** Auto-generate the installment schedule for a booking — "bridges the gap
 *  between sales and cash flow". Idempotent per booking. */
export function generatePaymentSchedule(opts: {
  tenantId: string;
  bookingId: string;
  leadId: string;
  planLabel: string;      // '30-70' | '20-80' | '40-60' | 'construction-linked' | anything else → flexi
  totalValue: number;     // unit price (falls back to lead budget)
  bookingDate?: string;
  actor?: { id: string; name: string };
}): PaymentPlan | null {
  // Never persist a zero-value schedule — it would lock in all-zero
  // installments forever via the idempotency guard below
  if (!opts.totalValue || opts.totalValue <= 0) return null;

  const existing = getByTenant<PaymentPlan>('paymentPlans', opts.tenantId).find(p => p.bookingId === opts.bookingId);
  // Self-heal: a legacy zero-value plan gets regenerated now that a real
  // total is known; a valid plan is returned as-is (idempotent)
  const existingTotal = existing?.installments.reduce((s, i) => s + i.amount, 0) ?? 0;
  if (existing && existingTotal > 0) return existing;

  const template = PLAN_TEMPLATES[opts.planLabel] || FLEXI;
  const installments = buildInstallments(opts.planLabel, opts.totalValue, opts.bookingDate);

  if (existing) {
    // Replace the zero-value legacy plan's installments in place
    return update<PaymentPlan>('paymentPlans', existing.id, { installments, type: template.type })!;
  }

  const plan = create<PaymentPlan>('paymentPlans', {
    id: '', tenantId: opts.tenantId, bookingId: opts.bookingId, leadId: opts.leadId,
    type: template.type, installments, createdAt: new Date().toISOString(),
  });

  if (opts.actor) {
    logAudit({
      tenantId: opts.tenantId, userId: opts.actor.id, userName: opts.actor.name,
      action: 'create', entity: 'payment_plan', entityId: plan.id,
      details: `Auto-generated ${installments.length}-installment payment schedule (${opts.planLabel})`,
    });
  }
  return plan;
}

export function getScheduleForBooking(tenantId: string, bookingId: string): PaymentPlan | undefined {
  return getByTenant<PaymentPlan>('paymentPlans', tenantId).find(p => p.bookingId === bookingId);
}

export function getSchedulesForLead(tenantId: string, leadId: string): PaymentPlan[] {
  return getByTenant<PaymentPlan>('paymentPlans', tenantId).filter(p => p.leadId === leadId);
}

/** Mark one installment paid (or back to pending). */
export function setInstallmentStatus(
  plan: PaymentPlan, installmentId: string, status: 'paid' | 'pending',
  actor?: { id: string; name: string }
): void {
  const installments = plan.installments.map(i =>
    i.id === installmentId
      ? { ...i, status, paidDate: status === 'paid' ? new Date().toISOString() : undefined }
      : i
  );
  update<PaymentPlan>('paymentPlans', plan.id, { installments });
  if (actor) {
    const inst = plan.installments.find(i => i.id === installmentId);
    logAudit({
      tenantId: plan.tenantId, userId: actor.id, userName: actor.name,
      action: status === 'paid' ? 'payment' : 'update', entity: 'payment_plan', entityId: plan.id,
      details: `Installment #${inst?.number} marked ${status}`,
    });
  }
}

/** Overdue = pending and past due date. Used for alerts. */
export function isOverdue(inst: Installment): boolean {
  return inst.status === 'pending' && new Date(inst.dueDate).getTime() < Date.now();
}

// ── API mode: the server's payment_schedules are the source of truth ─────────

/**
 * Fetch a booking's schedule from the server, creating it from the plan
 * template on first open (mirror of generatePaymentSchedule's idempotency, but
 * server-side). Returns a synthetic PaymentPlan shaped for the existing UI —
 * each installment's id IS the server schedule-row id, so Mark Paid / Raise
 * Demand can address rows directly.
 */
export async function fetchApiSchedule(opts: {
  tenantId: string; bookingId: string; leadId: string;
  planLabel: string; totalValue: number; bookingDate?: string;
}): Promise<PaymentPlan | null> {
  if (!isApiEnabled() || !(opts.totalValue > 0)) return null;
  const template = planTemplate(opts.planLabel);
  let rows = await apiGetPaymentSchedules(opts.bookingId);
  if (rows.length === 0) {
    const drafts = buildInstallments(opts.planLabel, opts.totalValue, opts.bookingDate);
    rows = await apiCreatePaymentSchedule(opts.bookingId, drafts.map((d, i) => ({
      number: d.number,
      milestoneName: template.milestones[i]?.label ?? d.description,
      percentage: template.milestones[i]?.pct,
      amount: d.amount,
      dueDate: d.dueDate.slice(0, 10),
      status: 'pending',
      trigger: d.trigger,
    })));
  }
  const installments: Installment[] = rows.map(r => ({
    id: r.id || uuid(),
    number: r.number,
    amount: r.amount,
    dueDate: r.dueDate ? String(r.dueDate) : new Date().toISOString(),
    status: r.status,
    description: r.percentage ? `${r.milestoneName} (${r.percentage}%)` : r.milestoneName,
    trigger: r.trigger,
    milestoneLabel: r.trigger === 'construction_milestone' ? r.milestoneName : undefined,
  }));
  return {
    id: `api-${opts.bookingId}`, tenantId: opts.tenantId, bookingId: opts.bookingId,
    leadId: opts.leadId, type: template.type, installments, createdAt: new Date().toISOString(),
  };
}

/** API mode: collect an installment (server flips it to paid). */
export async function apiPayInstallment(inst: Installment): Promise<void> {
  await apiRecordPayment({ scheduleId: inst.id, amount: inst.amount });
}

/** API mode: raise the demand on a construction-linked installment. */
export async function apiDemandInstallment(inst: Installment): Promise<void> {
  await apiUpdatePaymentSchedule(inst.id, 'demanded');
}
