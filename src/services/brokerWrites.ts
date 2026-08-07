/**
 * Broker (channel-partner) mutations — the single place that decides whether a
 * write goes to the Fastify/PostgreSQL backend or the localStorage demo store.
 * Mirrors documentWrites.ts.
 *
 * leadsReferred/bookingsClosed are DERIVED server-side (from leads.broker_id +
 * bookings), so they are display-only here — never written. The commission
 * ledger and partner portal accounts remain localStorage satellites.
 */
import type { Broker } from '../types';
import { create, update, remove } from './db';
import { isApiEnabled, apiCreateBroker, apiUpdateBroker, apiDeleteBroker } from './apiClient';

/** Onboard a broker. Returns the stored record (server-assigned id in API mode). */
export async function createBroker(input: Partial<Broker> & { tenantId: string }): Promise<Broker> {
  if (isApiEnabled()) return apiCreateBroker(input);
  return create<Broker>('brokers', { id: '', ...input } as Broker);
}

/** Patch a broker (activate/deactivate, edit details). */
export async function patchBroker(id: string, patch: Partial<Broker>): Promise<void> {
  if (isApiEnabled()) {
    await apiUpdateBroker(id, patch);
    return;
  }
  update<Broker>('brokers', id, patch);
}

/** Remove a broker. */
export async function deleteBroker(id: string): Promise<void> {
  if (isApiEnabled()) {
    await apiDeleteBroker(id);
    return;
  }
  remove('brokers', id);
}
