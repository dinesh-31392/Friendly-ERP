/**
 * Team-member mutations — the single place that decides whether a write goes
 * to the Fastify/PostgreSQL backend or the localStorage demo store.
 *
 * Why this exists: Settings managed the team with direct `create/update/
 * remove('users', …)` calls and no mode branch at all. Every other entity got
 * one of these modules; users never did. In API mode that made the whole team
 * screen theatre — inviting someone wrote a row to localStorage, said "Team
 * member added", and left them unable to sign in, because authentication asks
 * the server and the server had never heard of them.
 *
 * Deactivate was the dangerous one. "User deactivated" appeared, the row went
 * grey, and the account kept working — which is the opposite of what an admin
 * revoking access at speed believes they just did.
 *
 * The server's user model differs from the demo store's in two ways that the
 * UI has to respect rather than paper over:
 *
 *   The PASSWORD is the server's to choose. It returns a one-time temporary
 *   password on create and on reset, exactly once. The client never sends one,
 *   so the demo store's password field has no API equivalent.
 *
 *   There is NO DELETE. `/api/users` offers GET, POST and PATCH and nothing
 *   else, deliberately: a user carries audit history, assigned leads and
 *   approvals, and deleting that row would orphan all of it. Deactivation is
 *   the supported way to end access. `canHardDeleteUsers()` reports this so
 *   the UI can stop offering a button the backend has no route for.
 */
import type { User as UserType, Role } from '../types';
import { create, update, remove } from './db';
import {
  isApiEnabled, apiCreateUser, apiUpdateUser, apiGetRoles, type ApiRole,
} from './apiClient';

/** Roles this caller may actually assign. Empty in demo mode, where the role
 *  list is a static union rather than rows. */
export async function listAssignableRoles(): Promise<ApiRole[]> {
  if (!isApiEnabled()) return [];
  return apiGetRoles();
}

/** True when "Delete" is a real operation. False against the API, which has no
 *  delete route — see the note above. */
export function canHardDeleteUsers(): boolean {
  return !isApiEnabled();
}

/** Resolve a role key to the row id the API wants. */
async function roleIdFor(role: Role): Promise<string> {
  const roles = await apiGetRoles();
  const match = roles.find(r => r.name === role);
  if (!match) {
    throw new Error(`This workspace has no "${role}" role.`);
  }
  if (!match.assignable) {
    // The server would refuse anyway; saying so first is kinder than a 403.
    throw new Error(`You cannot assign "${role}" — it grants permissions you do not hold.`);
  }
  return match.id;
}

/**
 * Invite a team member.
 *
 * `temporaryPassword` comes back only in API mode, and only once — the caller
 * must show it to the admin then, because it cannot be retrieved later.
 */
export async function createUser(input: {
  tenantId: string; name: string; email: string; role: Role;
  password?: string; phone?: string; projectIds?: string[];
}): Promise<{ user: UserType; temporaryPassword?: string }> {
  if (isApiEnabled()) {
    const roleId = await roleIdFor(input.role);
    const res = await apiCreateUser({
      name: input.name,
      email: input.email.toLowerCase(),
      ...(input.phone ? { phone: input.phone } : {}),
      roleId,
    });
    return { user: res.user as unknown as UserType, temporaryPassword: res.temporaryPassword };
  }
  const user = create<UserType>('users', {
    id: '', tenantId: input.tenantId, name: input.name,
    email: input.email.toLowerCase(), password: input.password ?? '',
    role: input.role, avatar: '', phone: input.phone ?? '',
    ...(input.projectIds?.length ? { projectIds: input.projectIds } : {}),
    active: true, createdAt: new Date().toISOString(),
  } as UserType);
  return { user };
}

/** Rename, deactivate/reactivate, or move a member to another role. */
export async function patchUser(
  id: string,
  patch: { name?: string; phone?: string; active?: boolean; role?: Role },
): Promise<void> {
  if (isApiEnabled()) {
    const { role, ...rest } = patch;
    await apiUpdateUser(id, {
      ...rest,
      ...(role ? { roleId: await roleIdFor(role) } : {}),
    });
    return;
  }
  update<UserType>('users', id, patch as Partial<UserType>);
}

/**
 * Remove a member outright. Demo store only — see `canHardDeleteUsers()`.
 * Throwing beats silently deactivating: the confirm dialog says "cannot be
 * undone", and quietly doing something milder is its own kind of lie.
 */
export async function deleteUser(id: string): Promise<void> {
  if (isApiEnabled()) {
    throw new Error('Team members are deactivated rather than deleted, so their audit history stays intact.');
  }
  remove('users', id);
}
