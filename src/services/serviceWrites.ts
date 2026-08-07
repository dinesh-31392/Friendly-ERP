/**
 * Service-ticket mutations — the single place that decides whether a write goes
 * to the Fastify/PostgreSQL backend or the localStorage demo store. Mirrors
 * documentWrites.ts. Tickets are a leaf entity (create + patch-status + delete);
 * `leadId`/`assignedTo` are loose display ids, not satellites.
 */
import type { Ticket } from '../types';
import { create, update, remove } from './db';
import { isApiEnabled, apiCreateTicket, apiUpdateTicket, apiDeleteTicket } from './apiClient';

/** Raise a ticket. Returns the stored record (server-assigned id in API mode). */
export async function createTicket(input: Partial<Ticket> & { tenantId: string }): Promise<Ticket> {
  if (isApiEnabled()) return apiCreateTicket(input);
  return create<Ticket>('tickets', { id: '', ...input } as Ticket);
}

/** Patch a ticket (status change, reassignment). */
export async function patchTicket(id: string, patch: Partial<Ticket>): Promise<void> {
  if (isApiEnabled()) {
    await apiUpdateTicket(id, patch);
    return;
  }
  update<Ticket>('tickets', id, patch);
}

/** Delete a ticket. */
export async function deleteTicket(id: string): Promise<void> {
  if (isApiEnabled()) {
    await apiDeleteTicket(id);
    return;
  }
  remove('tickets', id);
}
