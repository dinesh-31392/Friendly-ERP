import { getByTenant, create, update } from './db';
import type { ApprovalRule, ApprovalAction } from '../types';

/** Sensible defaults (spec: defaults over configuration, but editable).
 *  Amounts are in the tenant's currency. 0 = every instance needs approval. */
const DEFAULTS: Record<ApprovalAction, number> = {
  discount: 100_000,     // discounts of ₹1L+ on a quotation route for approval
  vendor_bill: 500_000,  // bills of ₹5L+ need the approve_vendor_bills grant
  ra_bill: 0,            // RA bills ALWAYS go through both approval stages
};

export function getApprovalRules(tenantId: string): Record<ApprovalAction, number> {
  const stored = getByTenant<ApprovalRule>('approvalRules', tenantId);
  const result = { ...DEFAULTS };
  stored.forEach(r => { result[r.actionType] = r.thresholdAmount; });
  return result;
}

export function setApprovalThreshold(tenantId: string, actionType: ApprovalAction, thresholdAmount: number): void {
  const existing = getByTenant<ApprovalRule>('approvalRules', tenantId).find(r => r.actionType === actionType);
  if (existing) {
    update<ApprovalRule>('approvalRules', existing.id, { thresholdAmount, updatedAt: new Date().toISOString() });
  } else {
    create<ApprovalRule>('approvalRules', {
      id: '', tenantId, actionType, thresholdAmount, updatedAt: new Date().toISOString(),
    });
  }
}

/** Does this amount cross the tenant's threshold for the action? */
export function needsApproval(tenantId: string, actionType: ApprovalAction, amount: number): boolean {
  const threshold = getApprovalRules(tenantId)[actionType];
  return amount >= threshold;
}
