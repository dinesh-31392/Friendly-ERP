import type { FastifyInstance } from 'fastify';
import { withTenantContext, isActiveUser } from '../db.js';
import { requireAuth } from '../auth.js';

export async function metaRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/meta/:entity — the tenant's active form/pipeline/list-view
   * definitions. This is the "zero hardcoding" endpoint: the SPA renders
   * stages and forms from this JSON instead of compiled constants.
   */
  app.get<{ Params: { entity: string } }>(
    '/api/meta/:entity',
    {
      preHandler: requireAuth,
      schema: {
        params: {
          type: 'object', required: ['entity'],
          // definitions are keyed by a small set of entity slugs
          properties: { entity: { type: 'string', pattern: '^[a-z_]{1,32}$' } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        // This route has no has_permission gate (UI metadata every role needs),
        // so it must assert the user is still active itself, or a deactivated
        // user keeps reading it until their token expires.
        if (!await isActiveUser(db)) return reply.code(401).send({ error: 'Account is inactive' });
        const { rows } = await db.query(
          `SELECT DISTINCT ON (kind) kind, definition, version
             FROM schema_definitions
            WHERE entity = $1 AND is_active
            ORDER BY kind, version DESC`,
          [req.params.entity],
        );
        return Object.fromEntries(rows.map(r => [r.kind, { ...r.definition, _version: r.version }]));
      }),
  );
}
