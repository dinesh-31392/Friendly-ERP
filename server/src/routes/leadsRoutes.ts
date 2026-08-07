import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
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
    brokerId: (r.broker_id as string | null) ?? undefined,
    lastContact: r.last_contact_at,
    createdAt: r.created_at,
    customFields: r.custom_fields,
    score: r.score,
  };
}

/** Fields a client may write, camelCase → column. Everything absent here is
 *  deliberately NOT writable: `tenant_id` comes from the JWT via
 *  app_current_tenant(), `phone_normalized` is GENERATED ALWAYS (writing it is
 *  an error), and id/created_at/updated_at are owned by the database. */
const WRITABLE: Record<string, string> = {
  name: 'name',
  email: 'email',
  phone: 'phone',
  source: 'source',
  project: 'project',
  projectId: 'project_id',
  budget: 'budget',
  configuration: 'configuration',
  stage: 'stage',
  priority: 'priority',
  score: 'score',
  assignedTo: 'assigned_to',
  brokerId: 'broker_id',
  customFields: 'custom_fields',
  lastContact: 'last_contact_at',
};

/** Shared JSON-schema properties for the write bodies. Validation here turns
 *  malformed input into a 400 at the edge instead of a constraint violation
 *  (500) deep inside a transaction. */
const LEAD_PROPS = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  email: { type: 'string', maxLength: 254 },
  phone: { type: 'string', minLength: 1, maxLength: 32 },
  source: { type: 'string', maxLength: 64 },
  project: { type: 'string', maxLength: 200 },
  projectId: { type: 'string', pattern: UUID },
  budget: { type: 'number', minimum: 0, maximum: 1e12 },
  configuration: { type: 'string', maxLength: 64 },
  stage: { type: 'string', maxLength: 64 },
  priority: { type: 'string', enum: ['hot', 'warm', 'cold'] },
  score: { type: 'integer', minimum: 0, maximum: 100 },
  assignedTo: { type: 'string', pattern: UUID },
  brokerId: { type: 'string', pattern: UUID },
  customFields: { type: 'object' },
  lastContact: { type: 'string', maxLength: 40 },
} as const;

interface LeadBody {
  name?: string; email?: string; phone?: string; source?: string;
  project?: string; projectId?: string; budget?: number; configuration?: string;
  stage?: string; priority?: string; score?: number; assignedTo?: string;
  brokerId?: string; customFields?: Record<string, unknown>; lastContact?: string;
}

interface LeadAccess {
  canWrite: boolean;   // may create/update at all
  canAssign: boolean;  // may set assigned_to to someone else
  ownOnly: boolean;    // restricted to rows assigned to them
}

/** One round-trip for every RBAC decision a write route needs. `ownOnly`
 *  matches the read routes exactly so a user can never edit a lead they are
 *  not allowed to see. */
async function leadAccess(db: pg.PoolClient): Promise<LeadAccess> {
  const { rows: [p] } = await db.query(
    `SELECT has_permission('manage_leads')     AS full_access,
            has_permission('manage_own_leads') AS own_access,
            has_permission('assign_leads')     AS can_assign`,
  );
  return {
    canWrite: p.full_access || p.own_access,
    canAssign: p.full_access || p.can_assign,
    ownOnly: !p.full_access && !p.can_assign,
  };
}

/** Turn the constraint violations these routes can legitimately provoke into
 *  4xx client errors. Anything else is a real bug and must keep bubbling to the
 *  error handler (which logs it with a correlation id and leaks nothing). */
function mapWriteError(err: unknown): { error: string } | null {
  switch ((err as { code?: string })?.code) {
    case '23514': // check_violation — incl. validate_lead_stage()
      return { error: 'Invalid value: stage must exist in your pipeline, priority must be hot/warm/cold, and score must be 0-100.' };
    case '23503': // foreign_key_violation — incl. the tenant-scoped assignee FK
      return { error: 'That assignee or project does not exist in this workspace.' };
    case '23502':
      return { error: 'A required field is missing.' };
    case '22P02': // invalid_text_representation
      return { error: 'A field has an invalid format.' };
    case '23505':
      return { error: 'A record with these values already exists.' };
    default:
      return null;
  }
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

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * POST /api/leads — create.
   *
   * `manage_leads` is full access; `manage_own_leads` may create but the row is
   * forced onto the caller (they have no `assign_leads`). tenant_id is NEVER
   * taken from the body — it comes from app_current_tenant(), and the RLS
   * policy's USING expression doubles as the INSERT check, so a forged tenant
   * cannot be written even if this code were wrong.
   */
  app.post<{ Body: LeadBody }>(
    '/api/leads',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['name', 'phone'],
          additionalProperties: false,   // rejects id/tenantId/createdAt injection
          properties: LEAD_PROPS,
        },
      },
    },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const acc = await leadAccess(db);
          if (!acc.canWrite) {
            return reply.code(403).send({ error: 'Missing permission: manage_leads' });
          }

          const body = req.body as Record<string, unknown>;
          const cols = ['tenant_id'];
          const vals = ['app_current_tenant()'];
          const params: unknown[] = [];

          for (const [key, col] of Object.entries(WRITABLE)) {
            if (key === 'assignedTo' || body[key] === undefined) continue;
            params.push(key === 'customFields' ? JSON.stringify(body[key]) : body[key]);
            cols.push(col);
            vals.push(`$${params.length}`);
          }

          // Someone without assign rights cannot hand a new lead to a colleague.
          const assignee = acc.ownOnly
            ? req.ctx.userId
            : ((body.assignedTo as string | undefined) ?? req.ctx.userId);
          params.push(assignee);
          cols.push('assigned_to');
          vals.push(`$${params.length}`);

          const { rows } = await db.query(
            `INSERT INTO leads (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING *`,
            params,
          );
          // The audit row is written by the audit_row_change trigger using
          // app.current_user_id — no application-side logging needed.
          reply.code(201); return { lead: toApiLead(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  /**
   * PATCH /api/leads/:id — partial update. Mirrors the read route's own_only
   * rule (404, not 403, so it never confirms a lead the caller may not see),
   * and gates reassignment behind assign_leads.
   */
  app.patch<{ Params: { id: string }; Body: LeadBody }>(
    '/api/leads/:id',
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
          properties: LEAD_PROPS,
        },
      },
    },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const acc = await leadAccess(db);
          if (!acc.canWrite) {
            return reply.code(403).send({ error: 'Missing permission: manage_leads' });
          }

          const { rows: found } = await db.query(
            'SELECT assigned_to FROM leads WHERE id = $1', [req.params.id],
          );
          if (found.length === 0) return reply.code(404).send({ error: 'Lead not found' });
          if (acc.ownOnly && found[0].assigned_to !== req.ctx.userId) {
            return reply.code(404).send({ error: 'Lead not found' });
          }

          const body = req.body as Record<string, unknown>;
          if (
            body.assignedTo !== undefined &&
            !acc.canAssign &&
            body.assignedTo !== req.ctx.userId
          ) {
            return reply.code(403).send({ error: 'Missing permission: assign_leads' });
          }

          const sets: string[] = [];
          const params: unknown[] = [];
          for (const [key, col] of Object.entries(WRITABLE)) {
            if (body[key] === undefined) continue;
            params.push(key === 'customFields' ? JSON.stringify(body[key]) : body[key]);
            sets.push(`${col} = $${params.length}`);
          }
          if (sets.length === 0) {
            return reply.code(400).send({ error: 'No writable fields supplied' });
          }

          params.push(req.params.id);
          // updated_at is maintained by the leads_touch trigger.
          const { rows } = await db.query(
            `UPDATE leads SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
            params,
          );
          return { lead: toApiLead(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  /** DELETE /api/leads/:id — same visibility rule as update. */
  app.delete<{ Params: { id: string } }>(
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
        const acc = await leadAccess(db);
        if (!acc.canWrite) {
          return reply.code(403).send({ error: 'Missing permission: manage_leads' });
        }

        const { rows: found } = await db.query(
          'SELECT assigned_to FROM leads WHERE id = $1', [req.params.id],
        );
        if (found.length === 0) return reply.code(404).send({ error: 'Lead not found' });
        if (acc.ownOnly && found[0].assigned_to !== req.ctx.userId) {
          return reply.code(404).send({ error: 'Lead not found' });
        }

        await db.query('DELETE FROM leads WHERE id = $1', [req.params.id]);
        reply.code(204); return null;
      }),
  );
}
