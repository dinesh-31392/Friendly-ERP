/**
 * Persistence layer for Land acquisition and Business development.
 *
 * landService / bdService own the BUSINESS RULES (an encumbered parcel cannot
 * be qualified, only a qualified parcel converts, documents are versioned
 * never overwritten). This module owns only WHERE the resulting row lands:
 * the server in API mode, localStorage in demo mode. Splitting it this way
 * means the rules are enforced once, on one code path, in both modes.
 *
 * As in accountsWrites, an API-mode write mirrors the server's own row (server
 * id included) back into the local read-cache, so the pages' synchronous
 * getByTenant reads and the derived KPI folds stay correct without becoming
 * async.
 */
import { create, update, removeByTenant } from './db';
import {
  isApiEnabled,
  apiGetLandLeads, apiCreateLandLead, apiUpdateLandLead,
  apiGetFeasibility, apiCreateFeasibility,
  apiGetLandDocuments, apiCreateLandDocument, apiVerifyLandDocument,
  apiGetBdLeads, apiCreateBdLead, apiUpdateBdLead,
  apiGetMarketReports, apiCreateMarketReport,
  type ApiLandLead, type ApiBdLead, type ApiFeasibility,
  type ApiLandDocument, type ApiMarketReport,
} from './apiClient';
import type {
  LandLead, LandLeadStatus, LandReferenceSource, OwnershipType, LitigationStatus,
  FeasibilityRecord, LandDocument, LandDocType, DocVerificationStatus,
  BdLead, BdStage, BdOpportunityType, BdSource, JvStructure, MarketReport,
} from '../types';

// ── mappers ──────────────────────────────────────────────────────────────────
export function mapLandLead(r: ApiLandLead, tenantId: string): LandLead {
  return {
    id: r.id, tenantId,
    referenceSource: (r.referenceSource as LandReferenceSource) || 'broker',
    ownerName: r.ownerName, ownerContact: r.ownerContact,
    location: r.location, city: r.city, state: r.state, pincode: r.pincode,
    surveyNumber: r.surveyNumber, areaAcres: r.areaAcres, askingPrice: r.askingPrice,
    status: (r.status as LandLeadStatus) || 'lead_reference',
    rejectionReason: r.rejectionReason ?? undefined,
    assignedTo: r.assignedTo ?? undefined,
    ownershipType: (r.ownershipType as OwnershipType) ?? undefined,
    zoning: r.zoning ?? undefined,
    fsiPermissible: r.fsiPermissible ?? undefined,
    fsiConsumed: r.fsiConsumed ?? undefined,
    roadWidthFt: r.roadWidthFt ?? undefined,
    isEncumbered: !!r.isEncumbered,
    encumbranceNotes: r.encumbranceNotes ?? undefined,
    litigationStatus: (r.litigationStatus as LitigationStatus) || 'none',
    duplicateOf: r.duplicateOf ?? undefined,
    projectId: r.projectId ?? undefined,
    latestScore: r.latestScore ?? undefined,
    createdBy: r.createdBy ?? undefined,
    createdAt: r.createdAt ?? new Date().toISOString(),
  };
}

export function mapFeasibility(r: ApiFeasibility, tenantId: string): FeasibilityRecord {
  return {
    id: r.id, tenantId, landLeadId: r.landLeadId,
    costPerSqft: r.costPerSqft, saleableArea: r.saleableArea,
    estimatedRevenue: r.estimatedRevenue, marginPercent: r.marginPercent,
    score: r.score, cappedByRisk: !!r.cappedByRisk,
    computedBy: r.computedBy ?? '', computedAt: r.computedAt ?? new Date().toISOString(),
  };
}

export function mapLandDocument(r: ApiLandDocument, tenantId: string): LandDocument {
  return {
    id: r.id, tenantId, landLeadId: r.landLeadId,
    docType: r.docType as LandDocType, version: r.version, fileName: r.fileName,
    verificationStatus: (r.verificationStatus as DocVerificationStatus) || 'pending',
    verifiedBy: r.verifiedBy ?? undefined, verifiedAt: r.verifiedAt ?? undefined,
    uploadedBy: r.uploadedBy ?? '', createdAt: r.createdAt ?? new Date().toISOString(),
  };
}

export function mapBdLead(r: ApiBdLead, tenantId: string): BdLead {
  return {
    id: r.id, tenantId,
    opportunityType: (r.opportunityType as BdOpportunityType) || 'outright',
    source: (r.source as BdSource) || 'broker',
    counterpartyName: r.counterpartyName, counterpartyContact: r.counterpartyContact,
    city: r.city, stage: (r.stage as BdStage) || 'prospecting',
    estimatedDealValue: r.estimatedDealValue,
    closedLostReason: r.closedLostReason ?? undefined,
    ownedBy: r.ownedBy ?? undefined,
    jvStructure: (r.jvStructure as JvStructure) ?? undefined,
    revenueSharePercent: r.revenueSharePercent ?? undefined,
    areaSharePercent: r.areaSharePercent ?? undefined,
    jvNotes: r.jvNotes ?? undefined,
    landLeadId: r.landLeadId ?? undefined,
    createdBy: r.createdBy ?? undefined,
    createdAt: r.createdAt ?? new Date().toISOString(),
  };
}

export function mapMarketReport(r: ApiMarketReport, tenantId: string): MarketReport {
  return {
    id: r.id, tenantId, areaName: r.areaName,
    reportType: (r.reportType as MarketReport['reportType']) || 'pricing_benchmark',
    findings: r.findings || '', dataSources: r.dataSources ?? undefined,
    createdBy: r.createdBy ?? '', createdAt: r.createdAt ?? new Date().toISOString(),
  };
}

// ── hydration ────────────────────────────────────────────────────────────────
/** Mirror the server's Land + BD slice into the local read-cache. Best-effort
 *  per dataset — one failing endpoint must not blank the others. */
export async function hydrateLandBd(tenantId: string): Promise<void> {
  if (!isApiEnabled()) return;
  const replace = <T extends { id: string }>(table: Parameters<typeof removeByTenant>[0], rows: T[]) => {
    removeByTenant(table, tenantId);
    rows.forEach(r => { try { create(table, r); } catch { /* cache is best-effort */ } });
  };
  await Promise.all([
    apiGetLandLeads().then(r => replace('landLeads', r.map(x => mapLandLead(x, tenantId)))).catch(() => {}),
    apiGetFeasibility().then(r => replace('feasibilityRecords', r.map(x => mapFeasibility(x, tenantId)))).catch(() => {}),
    apiGetLandDocuments().then(r => replace('landDocuments', r.map(x => mapLandDocument(x, tenantId)))).catch(() => {}),
    apiGetBdLeads().then(r => replace('bdLeads', r.map(x => mapBdLead(x, tenantId)))).catch(() => {}),
    apiGetMarketReports().then(r => replace('marketReports', r.map(x => mapMarketReport(x, tenantId)))).catch(() => {}),
  ]);
}

// ── Land ─────────────────────────────────────────────────────────────────────
export async function persistLandLead(input: Omit<LandLead, 'id'>): Promise<LandLead> {
  if (!isApiEnabled()) return create<LandLead>('landLeads', { ...input, id: '' } as LandLead);
  const created = await apiCreateLandLead({
    referenceSource: input.referenceSource, ownerName: input.ownerName, ownerContact: input.ownerContact,
    location: input.location, city: input.city, state: input.state, pincode: input.pincode,
    surveyNumber: input.surveyNumber, areaAcres: input.areaAcres, askingPrice: input.askingPrice,
    status: input.status, ownershipType: input.ownershipType, zoning: input.zoning,
    fsiPermissible: input.fsiPermissible, fsiConsumed: input.fsiConsumed, roadWidthFt: input.roadWidthFt,
    isEncumbered: input.isEncumbered, encumbranceNotes: input.encumbranceNotes,
    litigationStatus: input.litigationStatus,
  });
  return create<LandLead>('landLeads', mapLandLead(created, input.tenantId));
}

/** Status transitions (qualify / reject / convert link-back). Returns false when
 *  the row is gone, which the callers treat as a failed transition. */
export async function persistLandStatus(
  lead: LandLead,
  patch: { status?: LandLeadStatus; rejectionReason?: string; projectId?: string },
): Promise<boolean> {
  if (!isApiEnabled()) return !!update<LandLead>('landLeads', lead.id, patch);
  try {
    const updated = await apiUpdateLandLead(lead.id, patch);
    return !!update<LandLead>('landLeads', lead.id, mapLandLead(updated, lead.tenantId));
  } catch {
    return false;
  }
}

export async function persistFeasibility(input: Omit<FeasibilityRecord, 'id'>): Promise<FeasibilityRecord> {
  if (!isApiEnabled()) return create<FeasibilityRecord>('feasibilityRecords', { ...input, id: '' } as FeasibilityRecord);
  const created = await apiCreateFeasibility({
    landLeadId: input.landLeadId, costPerSqft: input.costPerSqft, saleableArea: input.saleableArea,
    estimatedRevenue: input.estimatedRevenue, marginPercent: input.marginPercent,
    score: input.score, cappedByRisk: input.cappedByRisk,
  });
  return create<FeasibilityRecord>('feasibilityRecords', mapFeasibility(created, input.tenantId));
}

export async function persistLandDocument(input: Omit<LandDocument, 'id'>): Promise<LandDocument> {
  if (!isApiEnabled()) return create<LandDocument>('landDocuments', { ...input, id: '' } as LandDocument);
  const created = await apiCreateLandDocument({
    landLeadId: input.landLeadId, docType: input.docType, fileName: input.fileName, version: input.version,
  });
  return create<LandDocument>('landDocuments', mapLandDocument(created, input.tenantId));
}

export async function persistDocumentVerification(
  doc: LandDocument, status: 'verified' | 'rejected', actorId: string,
): Promise<void> {
  if (!isApiEnabled()) {
    update<LandDocument>('landDocuments', doc.id, {
      verificationStatus: status, verifiedBy: actorId, verifiedAt: new Date().toISOString(),
    });
    return;
  }
  const updated = await apiVerifyLandDocument(doc.id, status);
  update<LandDocument>('landDocuments', doc.id, mapLandDocument(updated, doc.tenantId));
}

// ── BD ───────────────────────────────────────────────────────────────────────
export async function persistBdLead(input: Omit<BdLead, 'id'>): Promise<BdLead> {
  if (!isApiEnabled()) return create<BdLead>('bdLeads', { ...input, id: '' } as BdLead);
  const created = await apiCreateBdLead({
    opportunityType: input.opportunityType, source: input.source,
    counterpartyName: input.counterpartyName, counterpartyContact: input.counterpartyContact,
    city: input.city, stage: input.stage, estimatedDealValue: input.estimatedDealValue,
    jvStructure: input.jvStructure, revenueSharePercent: input.revenueSharePercent,
    areaSharePercent: input.areaSharePercent, jvNotes: input.jvNotes,
  });
  return create<BdLead>('bdLeads', mapBdLead(created, input.tenantId));
}

export async function persistBdPatch(
  deal: BdLead, patch: { stage?: BdStage; closedLostReason?: string; landLeadId?: string },
): Promise<boolean> {
  if (!isApiEnabled()) return !!update<BdLead>('bdLeads', deal.id, patch);
  try {
    const updated = await apiUpdateBdLead(deal.id, patch);
    return !!update<BdLead>('bdLeads', deal.id, mapBdLead(updated, deal.tenantId));
  } catch {
    return false;
  }
}

export async function persistMarketReport(input: Omit<MarketReport, 'id'>): Promise<MarketReport> {
  if (!isApiEnabled()) return create<MarketReport>('marketReports', { ...input, id: '' } as MarketReport);
  const created = await apiCreateMarketReport({
    areaName: input.areaName, reportType: input.reportType,
    findings: input.findings, dataSources: input.dataSources,
  });
  return create<MarketReport>('marketReports', mapMarketReport(created, input.tenantId));
}
