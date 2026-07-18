import { v4 as uuid } from 'uuid';
import { getByTenant, create, update, logAudit } from './db';
import type { PaymentPlan, Installment, PaymentPlanType } from '../types';

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
  const start = opts.bookingDate ? new Date(opts.bookingDate).getTime() : Date.now();

  const installments: Installment[] = template.milestones.map((m, i) => ({
    id: uuid(),
    number: i + 1,
    amount: Math.round((opts.totalValue * m.pct) / 100),
    dueDate: new Date(start + m.days * 86400000).toISOString(),
    status: 'pending',
    description: `${m.label} (${m.pct}%)`,
  }));
  // Rounding reconciliation: the final installment absorbs the remainder so
  // the schedule sums to exactly totalValue
  const roundedSum = installments.reduce((s, i) => s + i.amount, 0);
  installments[installments.length - 1].amount += opts.totalValue - roundedSum;

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
