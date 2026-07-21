import { getByTenant } from './db';
import type { SiteTask, Rfi, ChangeOrder, Inspection, InspectionItem } from '../types';
import { v4 as uuid } from 'uuid';

/**
 * Derived execution metrics for the Project Execution module. Everything here
 * is computed from site tasks / inspections on read — no stored rollups to
 * drift out of sync.
 */

/** % complete for a project = mean progress across its site tasks.
 *  null when the project has no tasks yet (render as "—", not 0%). */
export function projectProgress(tenantId: string, projectId: string): number | null {
  const tasks = getByTenant<SiteTask>('siteTasks', tenantId).filter(t => t.projectId === projectId);
  if (tasks.length === 0) return null;
  return Math.round(tasks.reduce((s, t) => s + (t.status === 'done' ? 100 : t.progress), 0) / tasks.length);
}

/** The nearest upcoming (or most overdue) unfinished milestone. */
export function nextMilestone(tenantId: string, projectId: string): SiteTask | null {
  const milestones = getByTenant<SiteTask>('siteTasks', tenantId)
    .filter(t => t.projectId === projectId && t.isMilestone && t.status !== 'done')
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
  return milestones[0] ?? null;
}

export type ProjectHealth = 'on_track' | 'at_risk' | 'delayed';

/**
 * Status flag per the dashboard spec (on track / at risk / delayed), with an
 * explainable rule rather than a score: an overdue MILESTONE means the
 * schedule itself has slipped → delayed; an overdue ordinary task or any
 * blocked task is a warning sign → at risk.
 */
export function projectHealth(tenantId: string, projectId: string): ProjectHealth {
  const tasks = getByTenant<SiteTask>('siteTasks', tenantId).filter(t => t.projectId === projectId);
  const now = Date.now();
  const overdue = (t: SiteTask) => t.status !== 'done' && new Date(t.dueDate).getTime() < now;
  if (tasks.some(t => t.isMilestone && overdue(t))) return 'delayed';
  if (tasks.some(t => overdue(t) || t.status === 'blocked')) return 'at_risk';
  return 'on_track';
}

export const HEALTH_META: Record<ProjectHealth, { label: string; badge: string; dot: string }> = {
  on_track: { label: 'On Track', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
  at_risk: { label: 'At Risk', badge: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500' },
  delayed: { label: 'Delayed', badge: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500' },
};

/** Dependencies gate starting: every prerequisite must be done. */
export function unmetDependencies(task: SiteTask, all: SiteTask[]): SiteTask[] {
  const byId = new Map(all.map(t => [t.id, t]));
  return task.dependsOn
    .map(id => byId.get(id))
    .filter((t): t is SiteTask => !!t && t.status !== 'done');
}

/** Sequential per-project display numbers: RFI-004, CO-002. */
export function nextRfiNumber(tenantId: string, projectId: string): number {
  const rfis = getByTenant<Rfi>('rfis', tenantId).filter(r => r.projectId === projectId);
  return rfis.reduce((max, r) => Math.max(max, r.number), 0) + 1;
}

export function nextChangeOrderNumber(tenantId: string, projectId: string): number {
  const cos = getByTenant<ChangeOrder>('changeOrders', tenantId).filter(c => c.projectId === projectId);
  return cos.reduce((max, c) => Math.max(max, c.number), 0) + 1;
}

/** Net approved impact of change orders on a project. */
export function changeOrderImpact(tenantId: string, projectId: string): { cost: number; days: number } {
  return getByTenant<ChangeOrder>('changeOrders', tenantId)
    .filter(c => c.projectId === projectId && c.status === 'approved')
    .reduce((acc, c) => ({ cost: acc.cost + c.costImpact, days: acc.days + c.timeImpactDays }), { cost: 0, days: 0 });
}

/** Instantiate a checklist template into editable inspection items. */
export function buildChecklistItems(labels: string[]): InspectionItem[] {
  return labels.map(label => ({ id: uuid(), label, result: 'pending' as const }));
}

/** An inspection's outcome from its items: any fail → failed. Only meaningful
 *  once every item has been marked (no 'pending' left). */
export function inspectionOutcome(items: InspectionItem[]): 'passed' | 'failed' | null {
  if (items.some(i => i.result === 'pending')) return null;
  return items.some(i => i.result === 'fail') ? 'failed' : 'passed';
}

export function openInspectionFailures(tenantId: string): Inspection[] {
  return getByTenant<Inspection>('inspections', tenantId).filter(i => i.status === 'failed');
}
