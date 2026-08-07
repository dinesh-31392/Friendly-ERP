/**
 * Campaign + template mutations — the single place that decides whether a write
 * goes to the Fastify/PostgreSQL backend or the localStorage demo store. Mirrors
 * leadWrites.ts / documentWrites.ts. Both are leaf entities managed on the same
 * marketing page.
 */
import type { Campaign, Template } from '../types';
import { create, update, remove } from './db';
import {
  isApiEnabled,
  apiCreateCampaign, apiUpdateCampaign, apiDeleteCampaign,
  apiCreateTemplate, apiDeleteTemplate,
} from './apiClient';

/** Create a campaign. Returns the stored record (server-assigned id in API mode). */
export async function createCampaign(input: Partial<Campaign> & { tenantId: string }): Promise<Campaign> {
  if (isApiEnabled()) return apiCreateCampaign(input);
  return create<Campaign>('campaigns', { id: '', ...input } as Campaign);
}

/** Patch a campaign (e.g. mark sent). */
export async function patchCampaign(id: string, patch: Partial<Campaign>): Promise<void> {
  if (isApiEnabled()) {
    await apiUpdateCampaign(id, patch);
    return;
  }
  update<Campaign>('campaigns', id, patch);
}

/** Delete a campaign. */
export async function deleteCampaign(id: string): Promise<void> {
  if (isApiEnabled()) {
    await apiDeleteCampaign(id);
    return;
  }
  remove('campaigns', id);
}

/** Create a message template. */
export async function createTemplate(input: Partial<Template> & { tenantId: string }): Promise<Template> {
  if (isApiEnabled()) return apiCreateTemplate(input);
  return create<Template>('templates', { id: '', ...input } as Template);
}

/** Delete a message template. */
export async function deleteTemplate(id: string): Promise<void> {
  if (isApiEnabled()) {
    await apiDeleteTemplate(id);
    return;
  }
  remove('templates', id);
}
