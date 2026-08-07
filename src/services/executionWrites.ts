/**
 * Site-execution write dispatcher + API-shape mappers (leadWrites pattern).
 * API mode talks to Fastify/Postgres (RLS+RBAC); demo mode keeps the exact
 * localStorage behavior. Construction-linked demand automation stays in the
 * page — it fires after the status write succeeds, in either mode.
 */
import { create, update, remove } from './db';
import type {
  SiteTask, SiteTaskStatus, ProgressUpdate, Rfi, ChangeOrder, Inspection,
  InspectionItem, InspectionType,
} from '../types';
import {
  isApiEnabled,
  apiGetSiteTasks, apiCreateSiteTask, apiUpdateSiteTask, apiDeleteSiteTask,
  apiGetProgressUpdates, apiCreateProgressUpdate, apiDeleteProgressUpdate,
  apiGetRfis, apiCreateRfi, apiUpdateRfi,
  apiGetChangeOrders, apiCreateChangeOrder, apiDecideChangeOrder,
  apiGetInspections, apiCreateInspection, apiUpdateInspection, apiDeleteInspection,
  type ApiSiteTask, type ApiProgressUpdate, type ApiRfi, type ApiChangeOrder, type ApiInspection,
} from './apiClient';

const day = (v: unknown) => (v ? String(v).slice(0, 10) : undefined);

// ── Server row → SPA shape ───────────────────────────────────────────────────

export function mapSiteTask(r: ApiSiteTask, tenantId: string): SiteTask {
  return {
    id: r.id, tenantId, projectId: r.projectId, title: r.title,
    description: r.description || undefined, isMilestone: r.isMilestone,
    startDate: day(r.startDate), dueDate: day(r.dueDate) || '',
    completedAt: r.completedAt || undefined,
    status: r.status as SiteTaskStatus, progress: r.progress,
    assignedTo: r.assignedTo || undefined,
    dependsOn: (r.dependsOn as string[]) || [],
    createdAt: new Date().toISOString(),
  };
}

export function mapUpdate(r: ApiProgressUpdate, tenantId: string): ProgressUpdate {
  return {
    id: r.id, tenantId, projectId: r.projectId, userId: r.userId || '',
    date: day(r.date) || '', summary: r.summary,
    workforce: r.workforce ?? undefined, photos: (r.photos as string[]) || [],
    createdAt: new Date().toISOString(),
  };
}

export function mapRfi(r: ApiRfi, tenantId: string): Rfi {
  return {
    id: r.id, tenantId, projectId: r.projectId, number: r.number,
    subject: r.subject, question: r.question, raisedBy: r.raisedBy || '',
    assignedTo: r.assignedTo || undefined, status: r.status as Rfi['status'],
    answer: r.answer || undefined, answeredAt: r.answeredAt || undefined,
    dueDate: day(r.dueDate), createdAt: new Date().toISOString(),
  };
}

export function mapCo(r: ApiChangeOrder, tenantId: string): ChangeOrder {
  return {
    id: r.id, tenantId, projectId: r.projectId, number: r.number,
    title: r.title, reason: r.reason, costImpact: r.costImpact, timeImpactDays: r.timeImpactDays,
    status: r.status as ChangeOrder['status'], requestedBy: r.requestedBy || '',
    decidedBy: r.decidedBy || undefined, decidedAt: r.decidedAt || undefined,
    createdAt: new Date().toISOString(),
  };
}

export function mapInspection(r: ApiInspection, tenantId: string): Inspection {
  return {
    id: r.id, tenantId, projectId: r.projectId, type: r.type as InspectionType,
    title: r.title, date: day(r.date) || '', inspectorId: r.inspectorId || '',
    status: r.status as Inspection['status'], items: (r.items as InspectionItem[]) || [],
    notes: r.notes || undefined, createdAt: new Date().toISOString(),
  };
}

/** API mode: one round of all five execution datasets, mapped to SPA shapes. */
export async function fetchExecutionData(tenantId: string): Promise<{
  tasks: SiteTask[]; updates: ProgressUpdate[]; rfis: Rfi[]; changeOrders: ChangeOrder[]; inspections: Inspection[];
} | null> {
  if (!isApiEnabled()) return null;
  const [t, u, r, c, i] = await Promise.all([
    apiGetSiteTasks(), apiGetProgressUpdates(), apiGetRfis(), apiGetChangeOrders(), apiGetInspections(),
  ]);
  return {
    tasks: t.map(x => mapSiteTask(x, tenantId)),
    updates: u.map(x => mapUpdate(x, tenantId)),
    rfis: r.map(x => mapRfi(x, tenantId)),
    changeOrders: c.map(x => mapCo(x, tenantId)),
    inspections: i.map(x => mapInspection(x, tenantId)),
  };
}

// ── Mutations ────────────────────────────────────────────────────────────────

export async function createSiteTask(data: SiteTask): Promise<SiteTask> {
  if (isApiEnabled()) {
    const r = await apiCreateSiteTask({
      projectId: data.projectId, title: data.title, description: data.description,
      isMilestone: data.isMilestone, startDate: data.startDate || undefined,
      dueDate: data.dueDate, assignedTo: data.assignedTo, dependsOn: data.dependsOn,
    });
    return mapSiteTask(r, data.tenantId);
  }
  return create<SiteTask>('siteTasks', data);
}

export async function setTaskStatus(task: SiteTask, status: SiteTaskStatus): Promise<void> {
  if (isApiEnabled()) { await apiUpdateSiteTask(task.id, { status }); return; }
  update<SiteTask>('siteTasks', task.id, {
    status,
    progress: status === 'done' ? 100 : task.progress,
    completedAt: status === 'done' ? new Date().toISOString() : undefined,
  });
}

export async function setTaskProgress(task: SiteTask, progress: number): Promise<void> {
  if (isApiEnabled()) { await apiUpdateSiteTask(task.id, { progress }); return; }
  update<SiteTask>('siteTasks', task.id, {
    progress,
    status: progress >= 100 ? 'done' : task.status === 'not_started' && progress > 0 ? 'in_progress' : task.status,
    completedAt: progress >= 100 ? new Date().toISOString() : undefined,
  });
}

/** Delete a task; dependents are unlinked (server does this in-query). */
export async function deleteSiteTask(task: SiteTask, siblings: SiteTask[]): Promise<void> {
  if (isApiEnabled()) { await apiDeleteSiteTask(task.id); return; }
  siblings.filter(t => t.dependsOn.includes(task.id)).forEach(t =>
    update<SiteTask>('siteTasks', t.id, { dependsOn: t.dependsOn.filter(d => d !== task.id) }),
  );
  remove('siteTasks', task.id);
}

export async function createUpdate(data: ProgressUpdate): Promise<ProgressUpdate> {
  if (isApiEnabled()) {
    const r = await apiCreateProgressUpdate({
      projectId: data.projectId, summary: data.summary,
      workforce: data.workforce, photos: data.photos, date: data.date,
    });
    return mapUpdate(r, data.tenantId);
  }
  return create<ProgressUpdate>('progressUpdates', data);
}

export async function deleteUpdate(u: ProgressUpdate): Promise<void> {
  if (isApiEnabled()) { await apiDeleteProgressUpdate(u.id); return; }
  remove('progressUpdates', u.id);
}

export async function createRfi(data: Rfi): Promise<Rfi> {
  if (isApiEnabled()) {
    const r = await apiCreateRfi({
      projectId: data.projectId, subject: data.subject, question: data.question,
      assignedTo: data.assignedTo, dueDate: data.dueDate,
    });
    return mapRfi(r, data.tenantId);
  }
  return create<Rfi>('rfis', data);
}

export async function answerRfi(rfi: Rfi, answer: string): Promise<void> {
  if (isApiEnabled()) { await apiUpdateRfi(rfi.id, { answer }); return; }
  update<Rfi>('rfis', rfi.id, { answer, status: 'answered', answeredAt: new Date().toISOString() });
}

export async function closeRfi(rfi: Rfi): Promise<void> {
  if (isApiEnabled()) { await apiUpdateRfi(rfi.id, { status: 'closed' }); return; }
  update<Rfi>('rfis', rfi.id, { status: 'closed' });
}

export async function createChangeOrder(data: ChangeOrder): Promise<ChangeOrder> {
  if (isApiEnabled()) {
    const r = await apiCreateChangeOrder({
      projectId: data.projectId, title: data.title, reason: data.reason,
      costImpact: data.costImpact, timeImpactDays: data.timeImpactDays,
    });
    return mapCo(r, data.tenantId);
  }
  return create<ChangeOrder>('changeOrders', data);
}

export async function decideChangeOrder(co: ChangeOrder, approved: boolean, userId: string): Promise<void> {
  if (isApiEnabled()) { await apiDecideChangeOrder(co.id, approved ? 'approved' : 'rejected'); return; }
  update<ChangeOrder>('changeOrders', co.id, {
    status: approved ? 'approved' : 'rejected',
    decidedBy: userId, decidedAt: new Date().toISOString(),
  });
}

export async function createInspection(data: Inspection): Promise<Inspection> {
  if (isApiEnabled()) {
    const r = await apiCreateInspection({
      projectId: data.projectId, type: data.type, title: data.title,
      date: data.date, items: data.items, notes: data.notes,
    });
    return mapInspection(r, data.tenantId);
  }
  return create<Inspection>('inspections', data);
}

export async function setInspectionItems(insp: Inspection, items: InspectionItem[]): Promise<void> {
  if (isApiEnabled()) { await apiUpdateInspection(insp.id, { items }); return; }
  update<Inspection>('inspections', insp.id, { items });
}

export async function completeInspection(insp: Inspection, outcome: 'passed' | 'failed'): Promise<void> {
  if (isApiEnabled()) { await apiUpdateInspection(insp.id, { status: outcome }); return; }
  update<Inspection>('inspections', insp.id, { status: outcome });
}

export async function deleteInspection(insp: Inspection): Promise<void> {
  if (isApiEnabled()) { await apiDeleteInspection(insp.id); return; }
  remove('inspections', insp.id);
}
