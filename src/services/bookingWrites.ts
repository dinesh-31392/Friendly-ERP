/**
 * Booking mutations — the single place that decides whether a write goes to the
 * Fastify/PostgreSQL backend or the localStorage demo store. Mirrors
 * leadWrites.ts / projectWrites.ts / inventoryWrites.ts.
 *
 * Scope: this dispatcher owns the `bookings` row only. A booking's unit and lead
 * side-effects are applied by the page through the already-server-backed units
 * (patchUnit) and leads (patchLead) dispatchers; the financial satellites a
 * booking spawns (payment schedule, token invoice, broker commission) still go
 * to localStorage until their own modules are cut over.
 */
import type { Booking } from '../types';
import { create, update, remove } from './db';
import { isApiEnabled, apiCreateBooking, apiUpdateBooking, apiDeleteBooking } from './apiClient';

/** Create a booking. Returns the stored record (server-assigned id in API mode). */
export async function createBooking(input: Partial<Booking> & { tenantId: string; leadId: string; unitId: string }): Promise<Booking> {
  if (isApiEnabled()) return apiCreateBooking(input);
  return create<Booking>('bookings', { id: '', ...input } as Booking);
}

/** Patch a booking (advance stage, set/clear cancel request). */
export async function patchBooking(id: string, patch: Partial<Booking>): Promise<void> {
  if (isApiEnabled()) {
    await apiUpdateBooking(id, patch);
    return;
  }
  update<Booking>('bookings', id, patch);
}

/** Delete (cancel) a booking. */
export async function deleteBooking(id: string): Promise<void> {
  if (isApiEnabled()) {
    await apiDeleteBooking(id);
    return;
  }
  remove('bookings', id);
}
