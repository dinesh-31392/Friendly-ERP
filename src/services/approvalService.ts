import { getByTenant, create, update } from './db';
import { isApiEnabled, apiGetApprovalWorkflows, apiSaveApprovalWorkflow } from './apiClient';
import type { ApprovalRule, ApprovalAction } from '../types';

/** Sensible defaults (spec: defaults over configuration, but editable).
 *  Amounts are in the tenant's currency. 0 = every instance needs approval. */
const DEFAULTS: Record<ApprovalAction, number> = {
  discount: 100_000,     // discounts of ₹1L+ on a quotation route for approval
  vendor_bill: 500_000,  // bills of ₹5L+ need the approve_vendor_bills grant
  ra_bill: 0,            // RA bills ALWAYS go through both approval stages
};

/**
 * The SPA and the database disagreed on what these actions are called.
 *
 * approval_workflows.action_type is CHECK-constrained to the '_approval'
 * spellings; the SPA has always used the short ones. That mismatch is half of
 * why this module never talked to the server — even a correct call would have
 * failed the constraint — and the thresholds a builder set went to
 * localStorage instead, which meant they applied on one browser and nowhere
 * else, while the server-side table stayed empty and every other user was
 * governed by the defaults above.
 *
 * Translated at this boundary rather than migrating either side: the column's
 * vocabulary covers actions the SPA does not implement yet (cancellation,
 * transfer), so the database is the more complete name-space of the two.
 */
const TO_SERVER: Record<ApprovalAction, string> = {
  discount: 'discount_approval',
  vendor_bill: 'vendor_bill_approval',
  ra_bill: 'ra_bill_approval',
};
const TO_CLIENT: Record<string, ApprovalAction> = Object.fromEntries(
  Object.entries(TO_SERVER).map(([k, v]) => [v, k as ApprovalAction]),
) as Record<string, ApprovalAction>;

/**
 * Read-through cache of the server's rules.
 *
 * needsApproval() is called inline from render paths — a quotation row asking
 * "does this discount need sign-off?" while it draws — so it has to stay
 * synchronous. The cache is what makes that possible without the answer being
 * a browser-local invention: syncApprovalRules() fills it from the server on
 * session start, and every write goes through the API before it lands here.
 */
export function getApprovalRules(tenantId: string): Record<ApprovalAction, number> {
  const stored = getByTenant<ApprovalRule>('approvalRules', tenantId);
  const result = { ...DEFAULTS };
  stored.forEach(r => { result[r.actionType] = r.thresholdAmount; });
  return result;
}

/** Write the cache. Not exported — the server is the way in. */
function cacheThreshold(tenantId: string, actionType: ApprovalAction, thresholdAmount: number): void {
  const existing = getByTenant<ApprovalRule>('approvalRules', tenantId).find(r => r.actionType === actionType);
  if (existing) {
    update<ApprovalRule>('approvalRules', existing.id, { thresholdAmount, updatedAt: new Date().toISOString() });
  } else {
    create<ApprovalRule>('approvalRules', {
      id: '', tenantId, actionType, thresholdAmount, updatedAt: new Date().toISOString(),
    });
  }
}

/**
 * Load the tenant's rules from the server into the cache.
 *
 * Called once per session. A failure leaves whatever is cached in place rather
 * than reverting to DEFAULTS, because silently loosening an approval gate is
 * the worst of the available failure modes.
 */
export async function syncApprovalRules(tenantId: string): Promise<void> {
  if (!isApiEnabled() || !tenantId) return;
  const workflows = await apiGetApprovalWorkflows();
  for (const w of workflows) {
    const action = TO_CLIENT[w.actionType];
    // A rule for an action the SPA does not implement yet is not an error.
    if (!action) continue;
    // NULL threshold means "always requires approval" — 0 in this scale.
    cacheThreshold(tenantId, action, w.thresholdAmount ?? 0);
  }
}

/**
 * Persist a threshold. Server first, cache second — so a rejected write never
 * leaves the browser believing a gate moved.
 *
 * Now async. It used to be fire-and-forget into localStorage, which is exactly
 * how it came to be lying to people.
 */
export async function setApprovalThreshold(
  tenantId: string, actionType: ApprovalAction, thresholdAmount: number,
): Promise<void> {
  if (isApiEnabled()) {
    await apiSaveApprovalWorkflow({ actionType: TO_SERVER[actionType], thresholdAmount });
  }
  cacheThreshold(tenantId, actionType, thresholdAmount);
}

/** Does this amount cross the tenant's threshold for the action? */
export function needsApproval(tenantId: string, actionType: ApprovalAction, amount: number): boolean {
  const threshold = getApprovalRules(tenantId)[actionType];
  return amount >= threshold;
}
