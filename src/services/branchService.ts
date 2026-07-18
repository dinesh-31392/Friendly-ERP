import { getAll, create, update, getById } from './db';
import type { Branch, Tenant, User } from '../types';

const LEGACY_BRANCH_NAME = 'Head Office';

/**
 * Branch governance — the platform-operator organizational layer.
 *
 * Non-destructive migration: runs once, gives every pre-existing tenant a
 * 'Head Office' branch and an 'approved' status so nothing that worked before
 * this feature can break. Legacy (undefined) values are always treated as
 * approved / head-office by the readers below.
 */
function ensureLegacyBranch(): Branch {
  let legacy = getAll<Branch>('branches').find(b => b.name === LEGACY_BRANCH_NAME);
  if (!legacy) legacy = create<Branch>('branches', { id: '', name: LEGACY_BRANCH_NAME, createdAt: new Date().toISOString() });
  return legacy;
}

export function ensureBranchMigration(): void {
  const tenants = getAll<Tenant>('tenants');
  const users = getAll<User>('users');
  const needsMigration = tenants.some(t => !t.branchId || !t.approvalStatus)
    || users.some(u => (u.role === 'super_admin' || u.role === 'tech_team') && !u.branchId);

  if (needsMigration) {
    const legacy = ensureLegacyBranch();
    tenants.forEach(t => {
      if (!t.branchId || !t.approvalStatus) {
        update<Tenant>('tenants', t.id, {
          branchId: t.branchId || legacy.id,
          approvalStatus: t.approvalStatus || 'approved',
        });
      }
    });
    users
      .filter(u => (u.role === 'super_admin' || u.role === 'tech_team') && !u.branchId)
      .forEach(u => update<User>('users', u.id, { branchId: legacy.id }));
  }

  // The demo seed that lived here — a "West Zone – Mumbai" branch plus a
  // tech_team member (branch@friendlycrm.com / password123) — has been removed
  // for production. It minted a real, privileged platform account with a
  // published password on any install that didn't already have one. Branches
  // are created by a super admin in Platform Control → Branches, and branch
  // staff are onboarded from there.
}

export function getBranches(): Branch[] {
  return getAll<Branch>('branches').sort((a, b) => a.name.localeCompare(b.name));
}

export function getLegacyBranch(): Branch | undefined {
  return getAll<Branch>('branches').find(b => b.name === LEGACY_BRANCH_NAME);
}

export function branchName(branchId?: string): string {
  if (!branchId) return LEGACY_BRANCH_NAME;
  return getById<Branch>('branches', branchId)?.name || 'Unknown Branch';
}

/** A tenant is reachable by its builder users only once approved. Legacy
 *  (undefined) counts as approved so pre-feature accounts never lock out. */
export function isApproved(tenant: Tenant | null): boolean {
  return (tenant?.approvalStatus ?? 'approved') === 'approved';
}

export function isPendingApproval(tenant: Tenant | null): boolean {
  return tenant?.approvalStatus === 'pending';
}

/**
 * The Gatekeeper: which tenants a platform user may see. Super admin sees all
 * branches; tech_team is hard-scoped to its own branch (legacy tenants fall
 * under Head Office, so a Head-Office tech member sees them). No global
 * select-all for non-super-admin roles.
 */
export function visibleTenantsForUser(user: User | null, all: Tenant[]): Tenant[] {
  if (!user) return [];
  if (user.role === 'super_admin') return all;
  if (user.role === 'tech_team') {
    const legacyId = getLegacyBranch()?.id;
    return all.filter(t => (t.branchId ?? legacyId) === user.branchId);
  }
  return [];
}
