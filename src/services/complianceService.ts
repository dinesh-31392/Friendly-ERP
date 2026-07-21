import { getByTenant, create, update, logAudit } from './db';
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

export function nextDueDate(from: string, frequency: FilingFrequency): string | null {
  if (frequency === 'one_time') return null;
  const d = new Date(from);
  if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (frequency === 'quarterly') d.setMonth(d.getMonth() + 3);
  else d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
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
