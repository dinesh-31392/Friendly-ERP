/**
 * Lead mutations — the single place that decides whether a write goes to the
 * Fastify/PostgreSQL backend or the localStorage demo store.
 *
 * Why this exists: the SPA had ~15 direct `create/update/remove('leads', …)`
 * call sites. In API mode a write that only touched localStorage was worse than
 * useless — the next `apiGetLeads()` refetch overwrote it, so edits silently
 * reverted and "deleted" leads came back. Centralising the branch here means a
 * call site cannot forget it.
 *
 * Everything is async so callers have ONE shape regardless of mode; the demo
 * path just resolves immediately. Errors propagate — callers surface them to
 * the user rather than pretending the write happened.
 */
import type { Lead } from '../types';
import { create, update, remove } from './db';
import { isApiEnabled, apiCreateLead, apiUpdateLead, apiDeleteLead } from './apiClient';

/** Create a lead. Returns the stored record (server-assigned id in API mode). */
export async function createLead(input: Partial<Lead> & { tenantId: string }): Promise<Lead> {
  if (isApiEnabled()) return apiCreateLead(input);
  return create<Lead>('leads', { id: '', ...input } as Lead);
}

/** Patch a lead. Only the supplied fields are sent. */
export async function patchLead(id: string, patch: Partial<Lead>): Promise<void> {
  if (isApiEnabled()) {
    await apiUpdateLead(id, patch);
    return;
  }
  update<Lead>('leads', id, patch);
}

/** Delete a lead. */
export async function deleteLead(id: string): Promise<void> {
  if (isApiEnabled()) {
    await apiDeleteLead(id);
    return;
  }
  remove('leads', id);
}

/**
 * Apply the same patch to many leads. Sequential on purpose: the API rate-limits
 * per IP, and a burst of parallel PATCHes from a bulk action on a few hundred
 * rows is exactly the shape that trips it. Returns how many succeeded so the
 * caller can report partial failure honestly instead of claiming success.
 */
export async function patchLeads(
  ids: string[],
  patch: Partial<Lead>,
): Promise<{ ok: number; failed: number }> {
  let ok = 0, failed = 0;
  for (const id of ids) {
    try { await patchLead(id, patch); ok++; } catch { failed++; }
  }
  return { ok, failed };
}

/** Delete many leads. Same sequential rationale as patchLeads. */
export async function deleteLeads(ids: string[]): Promise<{ ok: number; failed: number }> {
  let ok = 0, failed = 0;
  for (const id of ids) {
    try { await deleteLead(id); ok++; } catch { failed++; }
  }
  return { ok, failed };
}
