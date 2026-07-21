import type { Tenant } from '../types';

export interface PlanDef {
  id: 'starter' | 'growth' | 'enterprise';
  name: 'Starter' | 'Growth' | 'Enterprise';
  priceMonthly: { INR: number; USD: number };
  /** -1 means unlimited */
  limits: { users: number; projects: number };
  features: string[];
}

export const PLANS: PlanDef[] = [
  {
    id: 'starter', name: 'Starter',
    priceMonthly: { INR: 1999, USD: 29 },
    limits: { users: 5, projects: 2 },
    features: ['Unlimited leads', '5 team members', '2 projects', 'AI Studio', 'Basic reports', 'Standard support'],
  },
  {
    id: 'growth', name: 'Growth',
    priceMonthly: { INR: 4999, USD: 79 },
    limits: { users: 15, projects: 10 },
    features: ['Everything in Starter', '15 team members', '10 projects', 'All integrations', 'Advanced reports', 'Priority support'],
  },
  {
    id: 'enterprise', name: 'Enterprise',
    priceMonthly: { INR: 14999, USD: 299 },
    limits: { users: -1, projects: -1 },
    features: ['Everything in Growth', 'Unlimited team & projects', 'Custom integrations', 'Dedicated support', 'SLA guarantee'],
  },
];

export const TRIAL_DAYS = 14;

export function getPlanForTenant(tenant: Tenant | null): PlanDef {
  return PLANS.find(p => p.name === tenant?.plan) ?? PLANS[0];
}

export function planPriceLabel(plan: PlanDef, currency: string): string {
  return currency === 'INR' ? `₹${plan.priceMonthly.INR.toLocaleString('en-IN')}` : `$${plan.priceMonthly.USD}`;
}

export function withinLimit(current: number, limit: number): boolean {
  return limit < 0 || current < limit;
}

/** Days of trial remaining. null when the tenant is not on a trial. */
export function trialDaysLeft(tenant: Tenant | null): number | null {
  if (!tenant || tenant.status !== 'trial' || !tenant.trialEndsAt) return null;
  return Math.ceil((new Date(tenant.trialEndsAt).getTime() - Date.now()) / 86400000);
}

export function isTrialExpired(tenant: Tenant | null): boolean {
  const left = trialDaysLeft(tenant);
  return left !== null && left <= 0;
}

/** Platform-level MRR in USD across billable (active) tenants. A negotiated
 *  custom price (super-admin override) takes precedence over the plan price. */
export function platformMrrUsd(tenants: Tenant[]): number {
  return tenants
    .filter(t => (t.status ?? 'active') === 'active' && (t.approvalStatus ?? 'approved') === 'approved')
    .reduce((sum, t) => sum + tenantMrrUsd(t), 0);
}

export function tenantMrrUsd(t: Tenant): number {
  if (typeof t.overrides?.customPriceMonthly === 'number') return t.overrides.customPriceMonthly;
  return PLANS.find(p => p.name === t.plan)?.priceMonthly.USD ?? 0;
}

// ── Custom control model (super-admin per-tenant overrides) ─────────────────

/** Modules the super admin can enable/disable per tenant. Keys match route
 *  path segments; Dashboard and Settings are always on. */
export const CONTROLLABLE_MODULES: { key: string; label: string }[] = [
  { key: 'leads', label: 'Leads' },
  { key: 'projects', label: 'Projects' },
  { key: 'execution', label: 'Site Execution' },
  { key: 'procurement', label: 'Procurement' },
  { key: 'hr', label: 'HR & Workforce' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'bookings', label: 'Bookings' },
  { key: 'sales-performance', label: 'Sales Performance' },
  { key: 'ai-studio', label: 'AI Studio' },
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'reports', label: 'Reports' },
  { key: 'messages', label: 'Messages' },
  { key: 'documents', label: 'Documents' },
  { key: 'billing', label: 'Billing' },
  { key: 'accounts', label: 'Accounts & Ledger' },
  { key: 'service', label: 'Service' },
  { key: 'brokers', label: 'Partners' },
];

export function isModuleEnabled(tenant: Tenant | null, moduleKey: string): boolean {
  return !(tenant?.overrides?.disabledModules || []).includes(moduleKey);
}

/** Effective limits = plan limits unless the super admin set an override. */
export function getEffectiveLimits(tenant: Tenant | null): { users: number; projects: number } {
  const plan = getPlanForTenant(tenant);
  return {
    users: tenant?.overrides?.maxUsers ?? plan.limits.users,
    projects: tenant?.overrides?.maxProjects ?? plan.limits.projects,
  };
}
