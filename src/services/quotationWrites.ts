/**
 * Quotation mutations — the single place that decides whether a write goes to
 * the Fastify/PostgreSQL backend or the localStorage demo store. Mirrors
 * bookingWrites.ts. Quotations map to an existing DB table (migration 003); no
 * satellites — an accepted quote is consumed by the booking flow, which is
 * already server-backed. The SPA never deletes a quotation, so there is no
 * delete dispatcher.
 */
import type { Quotation } from '../types';
import { create, update } from './db';
import { isApiEnabled, apiCreateQuotation, apiUpdateQuotation } from './apiClient';

/** Create a quotation. Returns the stored record (server-assigned id in API mode). */
export async function createQuotation(input: Partial<Quotation> & { tenantId: string; leadId: string; unitId: string }): Promise<Quotation> {
  if (isApiEnabled()) return apiCreateQuotation(input);
  return create<Quotation>('quotations', { id: '', ...input } as Quotation);
}

/** Patch a quotation (advance status, record discount approval). */
export async function patchQuotation(id: string, patch: Partial<Quotation>): Promise<void> {
  if (isApiEnabled()) {
    await apiUpdateQuotation(id, patch);
    return;
  }
  update<Quotation>('quotations', id, patch);
}
