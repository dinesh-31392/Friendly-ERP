import type { FastifyInstance } from 'fastify';
import { withTenantContext, isActiveUser } from '../db.js';
import { requireAuth } from '../auth.js';

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

      // LEFT JOIN, not INNER: an inner join would silently drop any user whose
      // role row wasn't visible, and a missing user is precisely the
      // "Unassigned" bug this endpoint exists to fix.
      const { rows } = await db.query(
        `SELECT u.id, u.tenant_id, u.name, u.email, u.phone, u.avatar_url,
                u.active, u.created_at, COALESCE(r.name, '') AS role
           FROM users u
           LEFT JOIN roles r ON r.id = u.role_id
          ORDER BY u.name`,
      );

      return {
        users: rows.map(r => ({
          id: r.id,
          tenantId: r.tenant_id,
          name: r.name,
          email: r.email,
          password: '',            // the SPA's User type wants the field; it stays empty
          role: r.role,
          avatar: r.avatar_url ?? '',
          phone: r.phone ?? '',
          active: r.active,
          createdAt: r.created_at,
        })),
      };
    }),
  );
}
