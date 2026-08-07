import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const UNIT_STATUSES = ['available', 'reserved', 'blocked', 'booked', 'sold', 'on_hold'] as const;

/**
 * Inventory = towers + units. The SPA and DB diverge on names:
 *   unit.number ↔ unit_code, unit.type ↔ unit_type, unit.floorNumber ↔ floor,
 *   unit.area ↔ area_sqft, unit.price ↔ base_rate.
 * The SPA `Unit` has no projectId (it reaches the project through its tower); on
 * the DB side units carry a NOT NULL project_id, which we resolve from the tower
 * at write time. `bookedBy` is not a column — it is derived from the unit's most
 * recent booking so the matrix can name the buyer.
 */
function toApiTower(r: Record<string, unknown>) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    projectId: r.project_id,
    name: r.name,
    floors: Number(r.floors) || 0,
    unitsPerFloor: Number(r.units_per_floor) || 0,
  };
}

function toApiUnit(r: Record<string, unknown>) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    towerId: r.tower_id ?? '',
    floorNumber: Number(r.floor) || 0,
    number: r.unit_code,
    type: r.unit_type ?? '',
    configuration: r.configuration ?? '',
    area: Number(r.area_sqft) || 0,
    price: Number(r.base_rate) || 0,
    status: r.status,
    bookedBy: (r.booked_by as string | null) ?? undefined,
  };
}

// unit camelCase → column. tower_id/project_id handled specially on create.
const UNIT_WRITABLE: Record<string, string> = {
  number: 'unit_code',
  type: 'unit_type',
  configuration: 'configuration',
  floorNumber: 'floor',
  area: 'area_sqft',
  price: 'base_rate',
  status: 'status',
};

const UNIT_PROPS = {
  towerId: { type: 'string', pattern: UUID },
  number: { type: 'string', minLength: 1, maxLength: 40 },
  type: { type: 'string', maxLength: 60 },
  configuration: { type: 'string', maxLength: 60 },
  floorNumber: { type: 'integer', minimum: -10, maximum: 300 },
  area: { type: 'number', minimum: 0, maximum: 1e7 },
  price: { type: 'number', minimum: 0, maximum: 1e12 },
  status: { type: 'string', enum: UNIT_STATUSES as unknown as string[] },
} as const;

const TOWER_PROPS = {
  projectId: { type: 'string', pattern: UUID },
  name: { type: 'string', minLength: 1, maxLength: 120 },
  floors: { type: 'integer', minimum: 0, maximum: 300 },
  unitsPerFloor: { type: 'integer', minimum: 0, maximum: 1000 },
} as const;

interface UnitBody {
  towerId?: string; number?: string; type?: string; configuration?: string;
  floorNumber?: number; area?: number; price?: number; status?: string;
}
interface TowerBody { projectId?: string; name?: string; floors?: number; unitsPerFloor?: number; }

// bookedBy is derived from the unit's most recent LIVE booking (active/completed
// — the same states the partial unique index locks on); cancelled/transferred
// bookings don't own the unit.
const UNIT_SELECT = `SELECT u.*, (
  SELECT b.lead_id FROM bookings b
   WHERE b.unit_id = u.id AND b.status IN ('active', 'completed')
   ORDER BY b.booked_at DESC LIMIT 1
) AS booked_by FROM units u`;

/** Constraint violations → 4xx; anything else keeps bubbling to the handler. */
function mapWriteError(err: unknown): { error: string } | null {
  switch ((err as { code?: string })?.code) {
    case '23514': return { error: `Invalid value — status must be one of: ${UNIT_STATUSES.join(', ')}.` };
    case '23502': return { error: 'A required field is missing.' };
    case '22P02': return { error: 'A field has an invalid format.' };
    case '23505': return { error: 'A unit with that number already exists in this project.' };
    case '23503': return { error: 'Referenced tower or project does not exist, or the unit is still referenced by a booking.' };
    default: return null;
  }
}

/** Writable columns/placeholders/params for a unit INSERT/UPDATE. */
function collectUnitWrites(body: UnitBody) {
  const cols: string[] = [];
  const exprs: string[] = [];
  const params: unknown[] = [];
  for (const [key, col] of Object.entries(UNIT_WRITABLE)) {
    const value = body[key as keyof UnitBody];
    if (value === undefined) continue;
    params.push(value);
    cols.push(col);
    exprs.push(`$${params.length}`);
  }
  return { cols, exprs, params };
}

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  // ── Towers ─────────────────────────────────────────────────────────────────

  /** GET /api/towers — RLS-scoped; view_inventory gates access. */
  app.get('/api/towers', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_inventory') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_inventory' });
      const { rows } = await db.query('SELECT * FROM towers ORDER BY name');
      return { towers: rows.map(toApiTower) };
    }),
  );

  /** POST /api/towers — create a tower under a project. */
  app.post<{ Body: TowerBody }>(
    '/api/towers',
    { preHandler: requireAuth, schema: { body: { type: 'object', required: ['projectId', 'name'], additionalProperties: false, properties: TOWER_PROPS } } },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_inventory') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_inventory' });
          const { rows } = await db.query(
            `INSERT INTO towers (tenant_id, project_id, name, floors, units_per_floor)
             VALUES (app_current_tenant(), $1, $2, $3, $4) RETURNING *`,
            [req.body.projectId, req.body.name, req.body.floors ?? 0, req.body.unitsPerFloor ?? 0],
          );
          reply.code(201); return { tower: toApiTower(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  // ── Units ──────────────────────────────────────────────────────────────────

  /** GET /api/units — optional ?projectId filter; RLS-scoped; view_inventory. */
  app.get<{ Querystring: { projectId?: string } }>(
    '/api/units',
    { preHandler: requireAuth, schema: { querystring: { type: 'object', properties: { projectId: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_inventory') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_inventory' });
        const where = req.query.projectId ? ' WHERE u.project_id = $1' : '';
        const args = req.query.projectId ? [req.query.projectId] : [];
        const { rows } = await db.query(`${UNIT_SELECT}${where} ORDER BY u.floor DESC, u.unit_code`, args);
        return { units: rows.map(toApiUnit) };
      }),
  );

  /** POST /api/units — create. project_id is resolved from the tower so the SPA
   *  contract (towerId only) is preserved. */
  app.post<{ Body: UnitBody }>(
    '/api/units',
    { preHandler: requireAuth, schema: { body: { type: 'object', required: ['towerId', 'number'], additionalProperties: false, properties: UNIT_PROPS } } },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_inventory') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_inventory' });

          // Resolve the tower's project (RLS-scoped, so cross-tenant ids miss).
          const { rows: tw } = await db.query('SELECT project_id FROM towers WHERE id = $1', [req.body.towerId]);
          if (tw.length === 0) return reply.code(400).send({ error: 'Tower not found' });
          const projectId = tw[0].project_id;

          const { cols, exprs, params } = collectUnitWrites(req.body);
          // tower_id + project_id are appended last.
          params.push(req.body.towerId, projectId);
          const towerPlaceholder = `$${params.length - 1}`;
          const projectPlaceholder = `$${params.length}`;
          const { rows } = await db.query(
            `WITH ins AS (
               INSERT INTO units (tenant_id, tower_id, project_id${cols.length ? ', ' + cols.join(', ') : ''})
               VALUES (app_current_tenant(), ${towerPlaceholder}, ${projectPlaceholder}${exprs.length ? ', ' + exprs.join(', ') : ''})
               RETURNING *
             )
             ${UNIT_SELECT.replace('FROM units u', 'FROM ins u')}`,
            params,
          );
          reply.code(201); return { unit: toApiUnit(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  /** PATCH /api/units/:id — partial update (status, price, config, …). */
  app.patch<{ Params: { id: string }; Body: UnitBody }>(
    '/api/units/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        // towerId is not repatchable here (units don't move towers in the UI);
        // only the mutable unit fields.
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: {
          number: UNIT_PROPS.number, type: UNIT_PROPS.type, configuration: UNIT_PROPS.configuration,
          floorNumber: UNIT_PROPS.floorNumber, area: UNIT_PROPS.area, price: UNIT_PROPS.price, status: UNIT_PROPS.status,
        } },
      },
    },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_inventory') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_inventory' });
          const { rows: found } = await db.query('SELECT 1 FROM units WHERE id = $1', [req.params.id]);
          if (found.length === 0) return reply.code(404).send({ error: 'Unit not found' });

          const { cols, exprs, params } = collectUnitWrites(req.body);
          if (cols.length === 0) return reply.code(400).send({ error: 'No writable fields supplied' });
          const sets = cols.map((c, i) => `${c} = ${exprs[i]}`);
          params.push(req.params.id);
          const { rows } = await db.query(
            `WITH upd AS (
               UPDATE units SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *
             )
             ${UNIT_SELECT.replace('FROM units u', 'FROM upd u')}`,
            params,
          );
          return { unit: toApiUnit(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  /** DELETE /api/units/:id — blocked by FK if a booking still references it. */
  app.delete<{ Params: { id: string } }>(
    '/api/units/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_inventory') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_inventory' });
          const { rowCount } = await db.query('DELETE FROM units WHERE id = $1', [req.params.id]);
          if (!rowCount) return reply.code(404).send({ error: 'Unit not found' });
          reply.code(204); return null;
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );
}
