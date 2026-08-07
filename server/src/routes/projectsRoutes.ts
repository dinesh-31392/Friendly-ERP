import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const STATUSES = ['pre_launch', 'under_construction', 'ready_to_move', 'completed', 'on_hold'] as const;

/**
 * DB row → the SPA's `Project` shape (camelCase). The two diverge on purpose:
 *  - the table stores price as two numeric columns; the UI wants a
 *    `priceRange: [min, max]` tuple;
 *  - `availableUnits` is not stored — it is computed from the live unit
 *    inventory (see the correlated subquery in the SELECTs below).
 */
function toApiProject(r: Record<string, unknown>) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    location: r.location ?? '',
    type: r.type ?? 'Residential',
    status: r.status,
    reraNumber: r.rera_number ?? undefined,
    totalUnits: Number(r.total_units) || 0,
    availableUnits: Number(r.available_units) || 0,
    priceRange: [Number(r.price_min) || 0, Number(r.price_max) || 0] as [number, number],
    launchDate: r.launch_date ?? undefined,
    completionDate: r.completion_date ?? undefined,
    description: r.description ?? undefined,
    amenities: (r.amenities as string[] | null) ?? [],
    micrositePublished: r.microsite_published ?? false,
    createdAt: r.created_at,
  };
}

// Scalar writables (camelCase → column). priceRange and amenities are handled
// specially below; tenant_id/id/created_at are owned by the DB and never
// accepted from the client (additionalProperties:false blocks injection).
const WRITABLE: Record<string, string> = {
  name: 'name',
  location: 'location',
  type: 'type',
  status: 'status',
  reraNumber: 'rera_number',
  totalUnits: 'total_units',
  launchDate: 'launch_date',
  completionDate: 'completion_date',
  description: 'description',
  micrositePublished: 'microsite_published',
};

const PROJECT_PROPS = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  location: { type: 'string', maxLength: 200 },
  type: { type: 'string', maxLength: 64 },
  status: { type: 'string', enum: STATUSES as unknown as string[] },
  reraNumber: { type: 'string', maxLength: 64 },
  totalUnits: { type: 'integer', minimum: 0, maximum: 100000 },
  priceRange: { type: 'array', items: { type: 'number', minimum: 0, maximum: 1e12 }, minItems: 2, maxItems: 2 },
  launchDate: { type: 'string', maxLength: 40 },
  completionDate: { type: 'string', maxLength: 40 },
  description: { type: 'string', maxLength: 4000 },
  amenities: { type: 'array', items: { type: 'string', maxLength: 60 }, maxItems: 60 },
  micrositePublished: { type: 'boolean' },
} as const;

interface ProjectBody {
  name?: string; location?: string; type?: string; status?: string;
  reraNumber?: string; totalUnits?: number; priceRange?: [number, number];
  launchDate?: string; completionDate?: string; description?: string;
  amenities?: string[]; micrositePublished?: boolean;
}

// Available units are the live inventory count — computed, never stored.
const SELECT = `SELECT p.*, (
  SELECT count(*)::int FROM units un JOIN towers tw ON tw.id = un.tower_id
   WHERE tw.project_id = p.id AND un.status = 'available'
) AS available_units FROM projects p`;

/** Turn the constraint violations these routes can provoke into 4xx client
 *  errors; anything else is a real bug and keeps bubbling to the error handler. */
function mapWriteError(err: unknown): { error: string } | null {
  switch ((err as { code?: string })?.code) {
    case '23514': return { error: `Invalid status — must be one of: ${STATUSES.join(', ')}.` };
    case '23502': return { error: 'A required field is missing.' };
    case '22P02': return { error: 'A field has an invalid format.' };
    case '22007': case '22008': return { error: 'A date field has an invalid value.' };
    case '23505': return { error: 'A project with these values already exists.' };
    default: return null;
  }
}

/** Build the column list + parameterised values shared by INSERT and (as SETs)
 *  UPDATE. Returns the writable column names, the SQL placeholders/expressions
 *  and the ordered params. priceRange fans out to price_min/price_max; amenities
 *  is cast to jsonb. */
function collectWrites(body: ProjectBody) {
  const cols: string[] = [];
  const exprs: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, value: unknown, cast = '') => {
    params.push(value);
    cols.push(col);
    exprs.push(`$${params.length}${cast}`);
  };
  // DATE columns reject an empty string ('' → 22007). A blank date field means
  // "no date", so coerce '' → NULL for these before it reaches Postgres.
  const DATE_COLS = new Set(['launch_date', 'completion_date']);
  for (const [key, col] of Object.entries(WRITABLE)) {
    const value = body[key as keyof ProjectBody];
    if (value === undefined) continue;
    add(col, DATE_COLS.has(col) && value === '' ? null : value);
  }
  if (body.priceRange !== undefined) {
    add('price_min', body.priceRange[0]);
    add('price_max', body.priceRange[1]);
  }
  if (body.amenities !== undefined) add('amenities', JSON.stringify(body.amenities), '::jsonb');
  return { cols, exprs, params };
}

export async function projectsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/projects — RLS scopes to the tenant; view_projects gates access. */
  app.get('/api/projects', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_projects') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_projects' });
      const { rows } = await db.query(`${SELECT} ORDER BY p.created_at DESC`);
      return { projects: rows.map(toApiProject) };
    }),
  );

  /** GET /api/projects/:id */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_projects') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_projects' });
        const { rows } = await db.query(`${SELECT} WHERE p.id = $1`, [req.params.id]);
        if (rows.length === 0) return reply.code(404).send({ error: 'Project not found' });
        return { project: toApiProject(rows[0]) };
      }),
  );

  /** POST /api/projects — create. tenant_id comes from app_current_tenant(). */
  app.post<{ Body: ProjectBody }>(
    '/api/projects',
    { preHandler: requireAuth, schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: PROJECT_PROPS } } },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_projects') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_projects' });
          const { cols, exprs, params } = collectWrites(req.body);
          const { rows } = await db.query(
            `WITH ins AS (
               INSERT INTO projects (tenant_id${cols.length ? ', ' + cols.join(', ') : ''})
               VALUES (app_current_tenant()${exprs.length ? ', ' + exprs.join(', ') : ''})
               RETURNING *
             )
             ${SELECT.replace('FROM projects p', 'FROM ins p')}`,
            params,
          );
          reply.code(201); return { project: toApiProject(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  /** PATCH /api/projects/:id — partial update. */
  app.patch<{ Params: { id: string }; Body: ProjectBody }>(
    '/api/projects/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: PROJECT_PROPS },
      },
    },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_projects') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_projects' });
          const { rows: found } = await db.query('SELECT 1 FROM projects WHERE id = $1', [req.params.id]);
          if (found.length === 0) return reply.code(404).send({ error: 'Project not found' });

          const { cols, exprs, params } = collectWrites(req.body);
          if (cols.length === 0) return reply.code(400).send({ error: 'No writable fields supplied' });
          const sets = cols.map((c, i) => `${c} = ${exprs[i]}`);
          params.push(req.params.id);
          const { rows } = await db.query(
            `WITH upd AS (
               UPDATE projects SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *
             )
             ${SELECT.replace('FROM projects p', 'FROM upd p')}`,
            params,
          );
          return { project: toApiProject(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  /** DELETE /api/projects/:id — cascades to towers/units/leads via FKs. */
  app.delete<{ Params: { id: string } }>(
    '/api/projects/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_projects') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_projects' });
        const { rowCount } = await db.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Project not found' });
        reply.code(204); return null;
      }),
  );
}
