import { LEAD_STAGES } from '../types';
import type { LeadStage } from '../types';

/**
 * Metadata-driven core — the SPA counterpart of the `schema_definitions`
 * table in docs/backend/schema.sql. Pipeline stages, lead sources, and unit
 * configurations are per-tenant DATA, not compiled constants: builders can
 * rename, recolor, reorder, and add stages with zero code deploys.
 *
 * Rules that keep the rest of the app sound:
 *  - 'new', 'booked', and 'lost' are CORE stages: they anchor entry and the
 *    two terminal outcomes that reports, bookings, and at-risk logic rely on.
 *    Their keys can never change or be deleted (labels/colors can).
 *  - Custom stages get slug keys and sit between 'new' and 'booked'.
 *  - A stage that still has leads in it cannot be deleted.
 */

export interface StageDef {
  id: LeadStage;        // widened to string in types — custom keys allowed
  label: string;
  color: string;        // tailwind bg-* class for dots/columns
  core?: boolean;       // key locked (new / booked / lost)
}

export interface TenantMeta {
  stages: StageDef[];
  leadSources: string[];
  configurations: string[];
}

const META_KEY = (tenantId: string) => `friendly_crm_meta_${tenantId}`;

export const CORE_STAGE_IDS: LeadStage[] = ['new', 'booked', 'lost'];

export const DEFAULT_SOURCES = [
  'Website', 'Microsite', 'Google Ads', 'Facebook', 'WhatsApp', 'Chatbot', '99acres',
  'MagicBricks', 'Housing.com', 'Referral', 'Instagram', 'Walk-in',
  'Zapier', 'Pabbly', 'Manual',
];

export const DEFAULT_CONFIGURATIONS = ['1 BHK', '2 BHK', '3 BHK', '4 BHK', 'Villa', 'Plot'];

/** Palette offered in the stage editor (tailwind classes used across views). */
export const STAGE_COLORS = [
  'bg-blue-500', 'bg-purple-500', 'bg-indigo-500', 'bg-violet-500',
  'bg-amber-500', 'bg-orange-500', 'bg-emerald-500', 'bg-teal-500',
  'bg-pink-500', 'bg-cyan-500', 'bg-red-400', 'bg-zinc-500',
];

function defaults(): TenantMeta {
  return {
    stages: LEAD_STAGES.map(s => ({ ...s, core: CORE_STAGE_IDS.includes(s.id) })),
    leadSources: [...DEFAULT_SOURCES],
    configurations: [...DEFAULT_CONFIGURATIONS],
  };
}

export function getTenantMeta(tenantId: string): TenantMeta {
  try {
    const raw = localStorage.getItem(META_KEY(tenantId));
    if (raw) {
      const parsed: TenantMeta = JSON.parse(raw);
      // Self-heal: core stages must always exist, whatever was saved
      const d = defaults();
      for (const core of d.stages.filter(s => s.core)) {
        if (!parsed.stages.some(s => s.id === core.id)) {
          if (core.id === 'new') parsed.stages.unshift(core);
          else parsed.stages.push(core);
        }
      }
      return parsed;
    }
  } catch { /* corrupted meta — fall back to defaults */ }
  return defaults();
}

export function saveTenantMeta(tenantId: string, meta: TenantMeta): void {
  localStorage.setItem(META_KEY(tenantId), JSON.stringify(meta));
  // Same-page consumers (kanban, dropdowns) refresh through this event
  window.dispatchEvent(new Event('friendly_crm_meta_changed'));
}

export function resetTenantMeta(tenantId: string): TenantMeta {
  localStorage.removeItem(META_KEY(tenantId));
  window.dispatchEvent(new Event('friendly_crm_meta_changed'));
  return defaults();
}

/** Stages for a tenant — THE way to read the pipeline. Falls back to
 *  defaults so every legacy caller keeps working. */
export function getLeadStages(tenantId: string): StageDef[] {
  return getTenantMeta(tenantId).stages;
}

export function getLeadSources(tenantId: string): string[] {
  return getTenantMeta(tenantId).leadSources;
}

export function getConfigurations(tenantId: string): string[] {
  return getTenantMeta(tenantId).configurations;
}

/** Slugify a custom stage label into a stable key: "Site Revisit" → "site_revisit" */
export function stageKeyFromLabel(label: string): string {
  return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
