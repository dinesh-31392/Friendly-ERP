import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { withTenantContext, isActiveUser } from '../db.js';
import { requireAuth, hashPassword } from '../auth.js';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** Unambiguous alphabet — no O/0, l/1/I. These get read aloud and retyped. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/**
 * A one-time password: 18 characters of the alphabet above (~105 bits).
 *
 * Rejection-sampled rather than a plain `byte % length`, which would bias the
 * first 25 characters of the alphabet upward — a small bias, but there is no
 * reason to ship a knowingly skewed credential generator.
 */
function temporaryPassword(): string {
  const limit = 256 - (256 % ALPHABET.length);
  const chars: string[] = [];
  while (chars.length < 18) {
    for (const b of randomBytes(24)) {
      if (chars.length === 18) break;
      if (b >= limit) continue;
      chars.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  const s = chars.join('');
  return `${s.slice(0, 6)}-${s.slice(6, 12)}-${s.slice(12, 18)}`;
}

function toApiUser(r: Record<string, unknown>) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    email: r.email,
    password: '',
    role: r.role,
    avatar: r.avatar_url ?? '',
    phone: r.phone ?? '',
    active: r.active,
    mustChangePassword: r.must_change_password ?? false,
    createdAt: r.created_at,
  };
}

/**
 * May the caller hand out this role?
 *
 * The rule is a subset test: a role is assignable only if it grants nothing the
 * caller does not already hold. That prevents privilege escalation without
 * hardcoding a hierarchy — a sales_manager who has `manage_users` cannot mint a
 * builder_admin, and nobody can mint a super_admin unless they already hold
 * every permission themselves. has_permission() evaluates against
 * app_current_user(), so this is always asked on behalf of the caller.
 */
async function canAssignRole(db: pg.PoolClient, roleId: string): Promise<boolean> {
  const { rows: [r] } = await db.query(
    `SELECT NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = $1 AND NOT has_permission(rp.permission_key)
     ) AS assignable`,
    [roleId],
  );
  return !!r?.assignable;
}

/** Does the role exist in the CALLER's workspace? RLS scopes this lookup, so a
 *  role id from another tenant simply is not found. Checking explicitly turns
 *  that into a clean 400 instead of a composite-FK violation later. */
async function roleInTenant(db: pg.PoolClient, roleId: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM roles WHERE id = $1', [roleId]);
  return rows.length > 0;
}

/**
 * May the caller ACT ON a user who currently holds this role?
 *
 * Same subset test as canAssignRole, applied to the TARGET's existing role.
 * Without it, `manage_users` was a blanket override: a holder could reset the
 * password of (and log in as, since the temp password is returned) or
 * deactivate a MORE-privileged peer — e.g. a custom "office_manager" role with
 * only manage_users could take over the tenant's builder_admin. Gating every
 * mutation on "the target grants nothing you lack" closes that escalation
 * without hardcoding a hierarchy. A user with no role row (should not happen)
 * is treated as unmanageable — fail closed.
 */
async function canManageUserRole(db: pg.PoolClient, targetRoleId: string | null): Promise<boolean> {
  if (!targetRoleId) return false;
  return canAssignRole(db, targetRoleId);
}

function mapWriteError(err: unknown): { error: string } | null {
  switch ((err as { code?: string })?.code) {
    case '23505': return { error: 'A user with that email already exists in this workspace.' };
    case '23503': return { error: 'That role does not exist in this workspace.' };
    case '23502': return { error: 'A required field is missing.' };
    case '22P02': return { error: 'A field has an invalid format.' };
    default: return null;
  }
}

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/users — the caller's workspace directory.
   *
   * Every role needs this: without it the SPA cannot turn an `assigned_to` uuid
   * into a name, so every lead renders as "Unassigned" and the assignee picker
   * is empty. Like /api/meta it therefore carries NO permission gate — which is
   * exactly why the active check below is mandatory, or a deactivated user
   * keeps reading the staff directory for the remaining life of their token.
   *
   * RLS scopes the rows to the caller's tenant. `password_hash` is never
   * selected — the column does not leave the database, in any shape.
   */
  app.get('/api/users', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await isActiveUser(db)) {
        return reply.code(401).send({ error: 'Account is inactive' });
      }
      // Contact PII (email + phone) is only for people who actually administer
      // staff. The directory itself is ungated because every role needs to turn
      // an assigned_to uuid into a NAME — but a telecaller has no business
      // reading every colleague's email and phone. Callers without
      // manage_users/manage_team get id/name/role/active only.
      const { rows: [{ can_see_contacts }] } = await db.query(
        `SELECT has_permission('manage_users') OR has_permission('manage_team') AS can_see_contacts`,
      );
      // LEFT JOIN, not INNER: an inner join would silently drop any user whose
      // role row wasn't visible, and a missing user is precisely the
      // "Unassigned" bug this endpoint exists to fix.
      const { rows } = await db.query(
        `SELECT u.id, u.tenant_id, u.name, u.email, u.phone, u.avatar_url,
                u.active, u.must_change_password, u.created_at,
                COALESCE(r.name, '') AS role
           FROM users u
           LEFT JOIN roles r ON r.id = u.role_id
          ORDER BY u.name`,
      );
      const users = rows.map(r => {
        const u = toApiUser(r);
        if (!can_see_contacts) { u.email = ''; u.phone = ''; }
        return u;
      });
      return { users };
    }),
  );

  /** GET /api/roles — the workspace's roles, each flagged with whether the
   *  caller is allowed to assign it (see canAssignRole). Lets the UI grey out
   *  roles rather than offering them and failing at submit. */
  app.get('/api/roles', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await isActiveUser(db)) {
        return reply.code(401).send({ error: 'Account is inactive' });
      }
      const { rows } = await db.query(
        `SELECT r.id, r.name, r.is_system,
                NOT EXISTS (
                  SELECT 1 FROM role_permissions rp
                   WHERE rp.role_id = r.id AND NOT has_permission(rp.permission_key)
                ) AS assignable
           FROM roles r
          ORDER BY r.name`,
      );
      return {
        roles: rows.map(r => ({
          id: r.id, name: r.name, isSystem: r.is_system, assignable: r.assignable,
        })),
      };
    }),
  );

  /**
   * POST /api/users — onboard a colleague.
   *
   * The server generates the password; the client cannot supply one. That keeps
   * weak admin-chosen passwords out of the system entirely and means the plain
   * text exists for exactly one response. It is returned ONCE, alongside
   * must_change_password, so the recipient is forced to replace it at first
   * sign-in.
   */
  app.post<{ Body: { name: string; email: string; phone?: string; roleId: string } }>(
    '/api/users',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['name', 'email', 'roleId'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            email: { type: 'string', minLength: 3, maxLength: 254 },
            phone: { type: 'string', maxLength: 32 },
            roleId: { type: 'string', pattern: UUID },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(
            `SELECT has_permission('manage_users') AS allowed`,
          );
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_users' });

          const { name, email, phone, roleId } = req.body;
          if (!await roleInTenant(db, roleId)) {
            return reply.code(400).send({ error: 'That role does not exist in this workspace.' });
          }
          if (!await canAssignRole(db, roleId)) {
            return reply.code(403).send({
              error: 'That role grants permissions you do not hold, so you cannot assign it.',
            });
          }

          const temp = temporaryPassword();
          const { rows: [u] } = await db.query(
            `INSERT INTO users (tenant_id, role_id, name, email, phone,
                                password_hash, must_change_password)
             VALUES (app_current_tenant(), $1, $2, $3, $4, $5, true)
             RETURNING id, tenant_id, name, email, phone, avatar_url, active,
                       must_change_password, created_at,
                       (SELECT name FROM roles WHERE id = $1) AS role`,
            [roleId, name, email.toLowerCase(), phone ?? null, await hashPassword(temp)],
          );
          // The only time this value is ever transmitted. It is not stored in
          // plain text anywhere and cannot be read back.
          return reply.code(201).send({ user: toApiUser(u), temporaryPassword: temp });
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  /**
   * PATCH /api/users/:id — rename, change phone, deactivate/reactivate,
   * reassign a role, or issue a fresh temporary password.
   *
   * Deactivation is the offboarding mechanism (there is no DELETE): it revokes
   * access immediately — has_permission() ANDs `active`, and the directory,
   * /me and /api/meta all assert isActiveUser() — while preserving the audit
   * trail and every lead the person touched.
   */
  app.patch<{
    Params: { id: string };
    Body: { name?: string; phone?: string; active?: boolean; roleId?: string; resetPassword?: boolean };
  }>(
    '/api/users/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: {
          type: 'object', required: ['id'],
          properties: { id: { type: 'string', pattern: UUID } },
        },
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            phone: { type: 'string', maxLength: 32 },
            active: { type: 'boolean' },
            roleId: { type: 'string', pattern: UUID },
            resetPassword: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(
            `SELECT has_permission('manage_users') AS allowed`,
          );
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_users' });

          const targetId = req.params.id;
          const { rows: found } = await db.query(
            'SELECT id, active, role_id FROM users WHERE id = $1', [targetId],
          );
          if (found.length === 0) return reply.code(404).send({ error: 'User not found' });

          const isSelf = targetId === req.ctx.userId;
          const body = req.body;

          // Privilege ceiling: you may only act on a peer whose CURRENT role
          // grants nothing you lack. Otherwise manage_users would let a
          // narrow custom role reset/deactivate a higher-privileged admin and
          // seize the account (the temp password is returned in the response).
          // Self is exempt — you can always manage your own name/phone/password
          // (role and active on self are separately blocked below).
          if (!isSelf && !await canManageUserRole(db, found[0].role_id)) {
            return reply.code(403).send({
              error: 'That user holds permissions you do not, so you cannot modify their account.',
            });
          }

          // Self-lockout guards. An admin who deactivates or demotes themselves
          // can lock the whole workspace out of user management with no way
          // back in — the workspace would need direct database access to
          // recover. These two blocks are also what keeps the "at least one
          // active administrator" invariant true: the caller necessarily holds
          // manage_users and necessarily remains active and unchanged.
          if (isSelf && body.active === false) {
            return reply.code(400).send({ error: 'You cannot deactivate your own account.' });
          }
          if (isSelf && body.roleId !== undefined) {
            return reply.code(400).send({ error: 'You cannot change your own role.' });
          }

          if (body.roleId !== undefined) {
            if (!await roleInTenant(db, body.roleId)) {
              return reply.code(400).send({ error: 'That role does not exist in this workspace.' });
            }
            if (!await canAssignRole(db, body.roleId)) {
              return reply.code(403).send({
                error: 'That role grants permissions you do not hold, so you cannot assign it.',
              });
            }
          }

          const sets: string[] = [];
          const params: unknown[] = [];
          const push = (col: string, value: unknown) => {
            params.push(value);
            sets.push(`${col} = $${params.length}`);
          };
          if (body.name !== undefined) push('name', body.name);
          if (body.phone !== undefined) push('phone', body.phone);
          if (body.active !== undefined) push('active', body.active);
          if (body.roleId !== undefined) push('role_id', body.roleId);

          let temp: string | undefined;
          if (body.resetPassword) {
            temp = temporaryPassword();
            push('password_hash', await hashPassword(temp));
            push('must_change_password', true);
          }

          if (sets.length === 0) {
            return reply.code(400).send({ error: 'No writable fields supplied' });
          }

          params.push(targetId);
          const { rows: [u] } = await db.query(
            `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}
             RETURNING id, tenant_id, name, email, phone, avatar_url, active,
                       must_change_password, created_at,
                       (SELECT name FROM roles WHERE id = users.role_id) AS role`,
            params,
          );
          return { user: toApiUser(u), ...(temp ? { temporaryPassword: temp } : {}) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );
}
