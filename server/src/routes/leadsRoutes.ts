import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

interface LeadsQuery {
  stage?: string;
  assigned_to?: string;
  search?: string;
  limit?: string;
  offset?: string;
}

// A native `pattern` (ajv supports it out of the box) — NOT `format: 'uuid'`,
// which needs ajv-formats registered with Fastify's validator or route
// registration can throw at boot. This validates the shape without that risk.
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** Maps a DB row to the shape the SPA's `Lead` type expects (camelCase). */
function toApiLead(r: Record<string, unknown>) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    email: r.email ?? '',
    phone: r.phone,
    source: r.source,
    project: r.project ?? '',
    projectId: r.project_id ?? undefined,
    budget: Number(r.budget),
    configuration: r.configuration ?? '',
    stage: r.stage,
    priority: r.priority,
    assignedTo: r.assigned_to ?? '',
    lastContact: r.last_contact_at,
    createdAt: r.created_at,
    customFields: r.custom_fields,
    score: r.score,
  };
}

export async function leadsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/leads — RLS scopes to the JWT's tenant; RBAC checked in-DB. */
  app.get<{ Querystring: LeadsQuery }>(
    '/api/leads',
    {
      preHandler: requireAuth,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            stage: { type: 'string', maxLength: 64 },
            // uuid-shaped or absent: a non-uuid here would reach the SQL as
            // `assigned_to = $n` against a uuid column → 22P02 → 500.
            assigned_to: { type: 'string', pattern: UUID },
            search: { type: 'string', maxLength: 200 },
            limit: { type: 'string', maxLength: 6 },
            offset: { type: 'string', maxLength: 9 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(
          `SELECT has_permission('view_leads') AS allowed`,
        );
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_leads' });

        const { rows: [{ own_only }] } = await db.query(
          `SELECT NOT has_permission('manage_leads')
             AND NOT has_permission('assign_leads') AS own_only`,
        );

        const params: unknown[] = [];
        const where: string[] = ['true'];       // tenant scoping is done by RLS
        if (own_only) { params.push(req.ctx.userId); where.push(`assigned_to = $${params.length}`); }
        if (req.query.stage)       { params.push(req.query.stage);       where.push(`stage = $${params.length}`); }
        if (req.query.assigned_to) { params.push(req.query.assigned_to); where.push(`assigned_to = $${params.length}`); }
        if (req.query.search) {
          // Two params: raw term for name ILIKE, digits-only for phone —
          // wildcards must wrap the CLEANED digits or phone search never matches
          params.push(`%${req.query.search}%`);
          const nameParam = params.length;
          params.push(req.query.search.replace(/\D/g, ''));
          const phoneParam = params.length;
          where.push(
            `(name ILIKE $${nameParam} OR ($${phoneParam} <> '' AND phone_normalized LIKE '%' || $${phoneParam} || '%'))`,
          );
        }
        // Clamp BOTH bounds: an unclamped lower bound let `?limit=-1` reach
        // Postgres as `LIMIT -1`, which errors and surfaced as a 500.
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 500));
        const offset = Math.max(Number(req.query.offset) || 0, 0);
        params.push(limit, offset);

        const { rows } = await db.query(
          `SELECT * FROM leads
            WHERE ${where.join(' AND ')}
            ORDER BY created_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        );
        return { leads: rows.map(toApiLead), limit, offset };
      }),
  );

  /**
   * GET /api/leads/:id — must enforce the SAME controls as the list route.
   * It previously checked neither view_leads nor own_only, so any tenant user
   * could read another rep's lead (full PII) one id at a time. RLS still blocks
   * cross-tenant reads, but within-tenant least-privilege was bypassed.
   * The uuid param schema also makes a non-uuid id a 400, not a 500.
   */
  app.get<{ Params: { id: string } }>(
    '/api/leads/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: {
          type: 'object', required: ['id'],
          properties: { id: { type: 'string', pattern: UUID } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(
          `SELECT has_permission('view_leads') AS allowed`,
        );
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_leads' });

        const { rows: [{ own_only }] } = await db.query(
          `SELECT NOT has_permission('manage_leads')
             AND NOT has_permission('assign_leads') AS own_only`,
        );

        const { rows } = await db.query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
        if (rows.length === 0) return reply.code(404).send({ error: 'Lead not found' });
        // 404 (not 403) on the own_only miss so the endpoint doesn't confirm the
        // lead exists to someone not allowed to see it.
        if (own_only && rows[0].assigned_to !== req.ctx.userId) {
          return reply.code(404).send({ error: 'Lead not found' });
        }
        return { lead: toApiLead(rows[0]) };
      }),
  );
}
