import { getByTenant, create, update, logAudit } from './db';
import { addMonthsISO } from '../utils/format';
import type { ComplianceItem, FilingFrequency } from '../types';

export function isFilingOverdue(item: ComplianceItem): boolean {
  return item.status === 'pending' && new Date(item.dueDate).getTime() < Date.now();
}

/** Pending filings due within the next `days` (or already overdue). */
export function filingsDueSoon(tenantId: string, days = 14): ComplianceItem[] {
  const horizon = Date.now() + days * 86400000;
  return getByTenant<ComplianceItem>('complianceItems', tenantId)
    .filter(i => i.status === 'pending' && new Date(i.dueDate).getTime() <= horizon)
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
}

/**
 * The next occurrence of a recurring filing.
 *
 * Months are added with clamping (addMonthsISO), not with setMonth. A GST
 * return due on the 31st used to roll to 3 March — skipping February — and
 * because markFiled() computes the next date from the last one, the deadline
 * then drifted to the 3rd of every following month. Yearly is 12 months for
 * the same reason: 29 Feb + 1 year has to land on 28 Feb, not 1 March.
 */
export function nextDueDate(from: string, frequency: FilingFrequency): string | null {
  if (frequency === 'one_time') return null;
  const months = frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : 12;
  return addMonthsISO(from, months);
}

/**
 * Mark filed; for a recurring filing, immediately create the next occurrence
 * so the deadline never silently falls off the radar. Returns the next item
 * (or null for one-time filings).
 */
export function markFiled(item: ComplianceItem, actor: { id: string; name: string }): ComplianceItem | null {
  update<ComplianceItem>('complianceItems', item.id, {
    status: 'filed', filedAt: new Date().toISOString(), filedBy: actor.id,
  });
  logAudit({
    tenantId: item.tenantId, userId: actor.id, userName: actor.name,
    action: 'update', entity: 'compliance_item', entityId: item.id,
    details: `Filed "${item.title}" (${item.authority})`,
  });
  const next = nextDueDate(item.dueDate, item.frequency);
  if (!next) return null;
  return create<ComplianceItem>('complianceItems', {
    id: '', tenantId: item.tenantId, title: item.title, authority: item.authority,
    dueDate: next, frequency: item.frequency, projectId: item.projectId,
    notes: item.notes, status: 'pending', createdAt: new Date().toISOString(),
  });
}
