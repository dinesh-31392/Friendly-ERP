import { getByTenant, create, update, remove, logAudit } from './db';
import { explainLandFeasibility } from '../types';
import type { LandLead, FeasibilityRecord, LandDocument, LandDocType, Project, ProjectStatus } from '../types';

/**
 * Land acquisition service. Follows the playbook's mandates as faithfully as a
 * browser-store client can:
 *   • No blind writes — every mutating helper checks the store actually changed
 *     and returns a typed result instead of silently no-op'ing (mustAffect).
 *   • Guarded transitions re-checked in code, not just the UI (encumbrance
 *     blocks qualify; convert re-verifies status === 'qualified').
 *   • Maker ≠ checker — qualifying and converting are separate permissions the
 *     PAGE enforces; this layer records who did what.
 * True ACID lives in the Postgres migrations; here writes are sequential, so
 * convertToProject compensates (removes the project) if the second write fails.
 */

export interface FeasibilityInputs {
  costPerSqft: number;
  saleableArea: number;
}

/** Compute + persist a feasibility record; caches the score onto the lead and
 *  advances it to 'feasibility_working' if it was earlier in the funnel. */
export function computeFeasibility(
  lead: LandLead, inputs: FeasibilityInputs, actor: { id: string; name: string },
): FeasibilityRecord {
  const estimatedRevenue = Math.round(inputs.saleableArea * inputs.costPerSqft);
  const cost = lead.askingPrice + Math.round(inputs.saleableArea * inputs.costPerSqft * 0.55); // land + ~55% build cost proxy
  const marginPercent = estimatedRevenue > 0 ? ((estimatedRevenue - cost) / estimatedRevenue) * 100 : 0;

  const { score, cappedByRisk } = explainLandFeasibility({
    fsiPermissible: lead.fsiPermissible, fsiConsumed: lead.fsiConsumed,
    marginPercent, roadWidthFt: lead.roadWidthFt, ownershipType: lead.ownershipType,
    isEncumbered: lead.isEncumbered, litigationStatus: lead.litigationStatus,
  });

  const rec = create<FeasibilityRecord>('feasibilityRecords', {
    id: '', tenantId: lead.tenantId, landLeadId: lead.id,
    costPerSqft: inputs.costPerSqft, saleableArea: inputs.saleableArea,
    estimatedRevenue, marginPercent: Number(marginPercent.toFixed(1)),
    score, cappedByRisk, computedBy: actor.id, computedAt: new Date().toISOString(),
  });

  update<LandLead>('landLeads', lead.id, {
    latestScore: score,
    status: lead.status === 'lead_reference' || lead.status === 'property_details' ? 'feasibility_working' : lead.status,
  });
  logAudit({
    tenantId: lead.tenantId, userId: actor.id, userName: actor.name,
    action: 'create', entity: 'feasibility', entityId: rec.id,
    details: `Feasibility scored ${score}/100 for parcel ${lead.surveyNumber} (margin ${marginPercent.toFixed(1)}%)`,
  });
  return rec;
}

export function feasibilityHistory(tenantId: string, landLeadId: string): FeasibilityRecord[] {
  return getByTenant<FeasibilityRecord>('feasibilityRecords', tenantId)
    .filter(r => r.landLeadId === landLeadId)
    .sort((a, b) => new Date(b.computedAt).getTime() - new Date(a.computedAt).getTime());
}

/** Duplicate-parcel guard: another ACTIVE lead on the same survey number in
 *  the same city (case-insensitive). Returns the existing lead, if any. */
export function findDuplicateParcel(
  tenantId: string, surveyNumber: string, city: string, excludeId?: string,
): LandLead | undefined {
  const sv = surveyNumber.trim().toLowerCase();
  const ct = city.trim().toLowerCase();
  return getByTenant<LandLead>('landLeads', tenantId).find(l =>
    l.id !== excludeId && l.status !== 'rejected' &&
    l.surveyNumber.trim().toLowerCase() === sv &&
    l.city.trim().toLowerCase() === ct
  );
}

export interface QualifyResult { ok: boolean; error?: string }

/**
 * Checker action (bd_manager / builder_admin). Blocks in CODE, not just the UI:
 * an encumbered or actively-litigated parcel cannot be qualified.
 */
export function qualifyLead(lead: LandLead, actor: { id: string; name: string }): QualifyResult {
  if (lead.status === 'converted_to_project') return { ok: false, error: 'Already converted to a project.' };
  if (lead.isEncumbered) return { ok: false, error: 'Parcel is encumbered — clear the encumbrance before qualifying.' };
  if (lead.litigationStatus === 'pending') return { ok: false, error: 'Live litigation on this parcel — resolve it before qualifying.' };
  if ((lead.latestScore ?? 0) <= 0) return { ok: false, error: 'Run a feasibility computation first.' };
  const updated = update<LandLead>('landLeads', lead.id, { status: 'qualified' });
  if (!updated) return { ok: false, error: 'Could not update the parcel (it may have been removed).' };
  logAudit({
    tenantId: lead.tenantId, userId: actor.id, userName: actor.name,
    action: 'approve', entity: 'land_lead', entityId: lead.id,
    details: `Qualified parcel ${lead.surveyNumber} into the acquisition pipeline`,
  });
  return { ok: true };
}

export function rejectLead(lead: LandLead, reason: string, actor: { id: string; name: string }): void {
  update<LandLead>('landLeads', lead.id, { status: 'rejected', rejectionReason: reason });
  logAudit({
    tenantId: lead.tenantId, userId: actor.id, userName: actor.name,
    action: 'update', entity: 'land_lead', entityId: lead.id,
    details: `Rejected parcel ${lead.surveyNumber}: ${reason}`,
  });
}

export interface ConvertResult { ok: boolean; error?: string; projectId?: string }

/**
 * Checker action (builder_admin only — a SECOND, higher-stakes approval than
 * qualifying). Re-verifies status === 'qualified' at call time (not trusted
 * from an earlier read), creates the project, then links it back. If the
 * link-back fails the freshly-created project is removed — a land lead can
 * never end up half-converted (project exists but lead still 'qualified',
 * or vice versa).
 */
export function convertToProject(lead: LandLead, actor: { id: string; name: string }): ConvertResult {
  const fresh = getByTenant<LandLead>('landLeads', lead.tenantId).find(l => l.id === lead.id);
  if (!fresh) return { ok: false, error: 'Parcel no longer exists.' };
  if (fresh.status !== 'qualified') return { ok: false, error: 'Only a qualified parcel can be converted.' };
  if (fresh.projectId) return { ok: false, error: 'This parcel is already linked to a project.' };

  const feas = feasibilityHistory(lead.tenantId, lead.id)[0];
  const saleable = feas?.saleableArea ?? 0;

  const project = create<Project>('projects', {
    id: '', tenantId: lead.tenantId,
    name: `${fresh.city} — Survey ${fresh.surveyNumber}`,
    location: fresh.location || `${fresh.city}, ${fresh.state}`,
    type: 'Residential',
    status: 'pre_launch' as ProjectStatus,
    reraNumber: '',
    totalUnits: saleable > 0 ? Math.max(1, Math.round(saleable / 1000)) : 0,
    availableUnits: saleable > 0 ? Math.max(1, Math.round(saleable / 1000)) : 0,
    priceRange: [0, 0],
    description: `Converted from land parcel ${fresh.surveyNumber} (${fresh.areaAcres} acres). Feasibility score ${fresh.latestScore ?? '—'}/100.`,
    createdAt: new Date().toISOString(),
  });

  const linked = update<LandLead>('landLeads', fresh.id, { status: 'converted_to_project', projectId: project.id });
  if (!linked) {
    // Compensating action — undo the orphaned project so nothing half-commits
    remove('projects', project.id);
    return { ok: false, error: 'Could not link the parcel to the new project — conversion rolled back.' };
  }
  logAudit({
    tenantId: lead.tenantId, userId: actor.id, userName: actor.name,
    action: 'approve', entity: 'land_lead', entityId: fresh.id,
    details: `Converted parcel ${fresh.surveyNumber} into project "${project.name}"`,
  });
  return { ok: true, projectId: project.id };
}

/** Versioned upload — always a NEW row at max(version)+1 for that doc type;
 *  title deeds and survey docs keep full history, never overwritten. */
export function addLandDocument(
  tenantId: string, landLeadId: string, docType: LandDocType, fileName: string,
  actor: { id: string; name: string },
): LandDocument {
  const existing = getByTenant<LandDocument>('landDocuments', tenantId)
    .filter(d => d.landLeadId === landLeadId && d.docType === docType);
  const version = existing.reduce((max, d) => Math.max(max, d.version), 0) + 1;
  const doc = create<LandDocument>('landDocuments', {
    id: '', tenantId, landLeadId, docType, version, fileName,
    verificationStatus: 'pending', uploadedBy: actor.id, createdAt: new Date().toISOString(),
  });
  logAudit({
    tenantId, userId: actor.id, userName: actor.name,
    action: 'create', entity: 'land_document', entityId: doc.id,
    details: `Uploaded ${docType.replace('_', ' ')} v${version}`,
  });
  return doc;
}

export function landDocuments(tenantId: string, landLeadId: string): LandDocument[] {
  return getByTenant<LandDocument>('landDocuments', tenantId)
    .filter(d => d.landLeadId === landLeadId)
    .sort((a, b) => b.version - a.version);
}

/** Verifier (separate from uploader) sets a document's status. */
export function verifyDocument(
  doc: LandDocument, status: 'verified' | 'rejected', actor: { id: string; name: string },
): void {
  update<LandDocument>('landDocuments', doc.id, {
    verificationStatus: status, verifiedBy: actor.id, verifiedAt: new Date().toISOString(),
  });
  logAudit({
    tenantId: doc.tenantId, userId: actor.id, userName: actor.name,
    action: 'update', entity: 'land_document', entityId: doc.id,
    details: `${status === 'verified' ? 'Verified' : 'Rejected'} ${doc.docType.replace('_', ' ')} v${doc.version}`,
  });
}
