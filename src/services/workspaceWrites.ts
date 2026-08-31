/**
 * The workspace's own profile — the single place that decides whether a write
 * goes to the server or the localStorage demo store.
 *
 * Why this exists: Settings → Builder Profile called `update('tenants', …)`
 * directly, behind a 500ms timeout that made it look like a network save. In
 * API mode the whole screen was theatre — company name, contact details, RERA
 * number and address all reverted at the next session refresh.
 *
 * The GSTIN was worse than reverting. The form wrote `tenants.gst`, the
 * original free-text field, while GST returns and e-invoicing read
 * `tenants.gstin`, which nothing wrote at all. So the GST panel's "this
 * workspace has no GSTIN — set it before preparing" was advice the product
 * could not take, and no invoice could ever be registered for an IRN.
 *
 * Saving a GSTIN now writes both, and the server derives the state code from
 * its first two digits unless one is supplied that agrees.
 */
import type { Tenant } from '../types';
import { update } from './db';
import { isApiEnabled, apiUpdateWorkspace, type ApiWorkspace } from './apiClient';

export interface WorkspaceProfilePatch {
  company?: string;
  /** The brand name — `tenants.name`. */
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  rera?: string;
  gstin?: string;
  stateCode?: string;
  city?: string;
  pincode?: string;
  einvoicingEnabled?: boolean;
}

/**
 * Save the profile. Returns the server's view in API mode so the caller can
 * refresh from what was actually stored rather than what it hoped it sent —
 * the server normalises the GSTIN's case and fills in the state code.
 */
export async function saveWorkspaceProfile(
  tenantId: string, patch: WorkspaceProfilePatch,
): Promise<ApiWorkspace | null> {
  if (isApiEnabled()) {
    // Empty strings are meaningful here — clearing a phone number is a real
    // edit — so only `undefined` is dropped.
    const body = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined));
    return apiUpdateWorkspace(body);
  }

  // Demo store: the legacy free-text `gst` field is what the local Tenant type
  // has, so a GSTIN goes there.
  const { gstin, einvoicingEnabled, stateCode, city, pincode, ...rest } = patch;
  update<Tenant>('tenants', tenantId, {
    ...rest,
    ...(gstin !== undefined ? { gst: gstin } : {}),
  } as Partial<Tenant>);
  return null;
}
