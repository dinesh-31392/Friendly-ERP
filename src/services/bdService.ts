import { getByTenant, remove, logAudit } from './db';
import { persistLandLead, persistBdPatch } from './landBdWrites';
import type { BdLead, LandLead, LitigationStatus } from '../types';

/**
 * Business Development service. Sources deals and hands qualified ones off into
 * Land Acquisition. The hand-off is a cross-link, not a merge — both rows keep
 * existing, referencing each other, so the deal's origin stays traceable.
 */

export interface HandOffResult { ok: boolean; error?: string; landLeadId?: string }

/**
 * Guarded hand-off (approver only — approve_bd_handoff). Re-verifies the deal
 * is still open at call time (not trusted from an earlier read), creates a
 * Land parcel pre-filled from the deal, advances the BD stage, and links the
 * two. If the link-back fails, the freshly-created parcel is removed so a deal
 * never ends up half-handed-off (a land parcel exists but the deal still shows
 * 'terms_negotiation', or vice versa) — the same compensating discipline as
 * Land's convertToProject.
 */
export async function handOffToLand(deal: BdLead, actor: { id: string; name: string }): Promise<HandOffResult> {
  const fresh = getByTenant<BdLead>('bdLeads', deal.tenantId).find(d => d.id === deal.id);
  if (!fresh) return { ok: false, error: 'Deal no longer exists.' };
  if (fresh.stage === 'handed_to_land' || fresh.landLeadId) return { ok: false, error: 'This deal has already been handed to Land.' };
  if (fresh.stage === 'closed_lost') return { ok: false, error: 'A closed-lost deal cannot be handed off.' };

  const now = new Date().toISOString();
  let parcel: LandLead;
  try {
    parcel = await persistLandLead({
    tenantId: fresh.tenantId,
    referenceSource: fresh.source === 'broker' ? 'broker' : 'direct',
    ownerName: fresh.counterpartyName,
    ownerContact: fresh.counterpartyContact,
    location: '', city: fresh.city, state: '', pincode: '',
    surveyNumber: `BD-${fresh.id.slice(0, 6).toUpperCase()}`, // placeholder until land team captures the real one
    areaAcres: 0,
    askingPrice: fresh.estimatedDealValue,
    status: 'lead_reference',
    isEncumbered: false,
    litigationStatus: 'none' as LitigationStatus,
    createdBy: actor.id, createdAt: now,
    });
  } catch {
    return { ok: false, error: 'Could not create the land parcel — hand-off aborted.' };
  }

  const linked = await persistBdPatch(fresh, { stage: 'handed_to_land', landLeadId: parcel.id });
  if (!linked) {
    remove('landLeads', parcel.id);   // compensating action — no orphan parcel
    return { ok: false, error: 'Could not link the deal to the new parcel — hand-off rolled back.' };
  }
  logAudit({
    tenantId: fresh.tenantId, userId: actor.id, userName: actor.name,
    action: 'approve', entity: 'bd_lead', entityId: fresh.id,
    details: `Handed deal "${fresh.counterpartyName}" (${fresh.city}) to Land Acquisition`,
  });
  return { ok: true, landLeadId: parcel.id };
}

export async function advanceStage(deal: BdLead, stage: BdLead['stage'], actor: { id: string; name: string }): Promise<void> {
  await persistBdPatch(deal, { stage });
  logAudit({
    tenantId: deal.tenantId, userId: actor.id, userName: actor.name,
    action: 'update', entity: 'bd_lead', entityId: deal.id,
    details: `Deal "${deal.counterpartyName}" → ${stage.replace(/_/g, ' ')}`,
  });
}

export async function closeLost(deal: BdLead, reason: string, actor: { id: string; name: string }): Promise<void> {
  // Never delete — a closed-lost deal stays in reporting so post-mortems on why
  // deals fall through are possible later.
  await persistBdPatch(deal, { stage: 'closed_lost', closedLostReason: reason });
  logAudit({
    tenantId: deal.tenantId, userId: actor.id, userName: actor.name,
    action: 'update', entity: 'bd_lead', entityId: deal.id,
    details: `Closed-lost deal "${deal.counterpartyName}": ${reason}`,
  });
}
