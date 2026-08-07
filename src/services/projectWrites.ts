/**
 * Project mutations — the single place that decides whether a write goes to the
 * Fastify/PostgreSQL backend or the localStorage demo store. Mirrors
 * leadWrites.ts; see that file for the full rationale.
 *
 * In API mode the server owns `availableUnits` (computed from live unit
 * inventory) and `createdAt`; the demo store fills them in itself. Both paths
 * return the stored `Project` so callers have one shape regardless of mode.
 */
import type { Project } from '../types';
import { create, update, remove, getByTenant } from './db';
import type { Unit, Tower } from '../types';
import { isApiEnabled, apiCreateProject, apiUpdateProject, apiDeleteProject } from './apiClient';

/** Create a project. Returns the stored record (server-assigned id in API mode). */
export async function createProject(input: Partial<Project> & { tenantId: string }): Promise<Project> {
  if (isApiEnabled()) return apiCreateProject(input);
  return create<Project>('projects', { id: '', ...input } as Project);
}

/** Patch a project. Only the supplied fields are sent. */
export async function patchProject(id: string, patch: Partial<Project>): Promise<void> {
  if (isApiEnabled()) {
    await apiUpdateProject(id, patch);
    return;
  }
  update<Project>('projects', id, patch);
}

/**
 * Delete a project. In API mode the server cascades to towers/units/leads via
 * FKs, so the client only issues one DELETE. In demo mode there are no FKs, so
 * we cascade by hand exactly as the page did before — otherwise towers and
 * units would be orphaned in localStorage.
 */
export async function deleteProject(id: string, tenantId: string): Promise<void> {
  if (isApiEnabled()) {
    await apiDeleteProject(id);
    return;
  }
  const towers = getByTenant<Tower>('towers', tenantId).filter(t => t.projectId === id);
  const towerIds = new Set(towers.map(t => t.id));
  getByTenant<Unit>('units', tenantId)
    .filter(u => towerIds.has(u.towerId))
    .forEach(u => remove('units', u.id));
  towers.forEach(t => remove('towers', t.id));
  remove('projects', id);
}
