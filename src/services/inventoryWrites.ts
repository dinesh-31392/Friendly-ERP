/**
 * Unit mutations — the single place that decides whether a write goes to the
 * Fastify/PostgreSQL backend or the localStorage demo store. Mirrors
 * leadWrites.ts / projectWrites.ts; see those for the full rationale.
 *
 * Towers are read-only from the SPA today (seeded, or cascaded on project
 * delete), so only unit writes need a dispatcher.
 */
import type { Unit } from '../types';
import { create, update, remove } from './db';
import { isApiEnabled, apiCreateUnit, apiUpdateUnit, apiDeleteUnit } from './apiClient';

/** Create a unit. Returns the stored record (server-assigned id in API mode). */
export async function createUnit(input: Partial<Unit> & { tenantId: string; towerId: string }): Promise<Unit> {
  if (isApiEnabled()) return apiCreateUnit(input);
  return create<Unit>('units', { id: '', ...input } as Unit);
}

/** Patch a unit (status, price, configuration, …). Only supplied fields are sent. */
export async function patchUnit(id: string, patch: Partial<Unit>): Promise<void> {
  if (isApiEnabled()) {
    await apiUpdateUnit(id, patch);
    return;
  }
  update<Unit>('units', id, patch);
}

/** Delete a unit. */
export async function deleteUnit(id: string): Promise<void> {
  if (isApiEnabled()) {
    await apiDeleteUnit(id);
    return;
  }
  remove('units', id);
}
