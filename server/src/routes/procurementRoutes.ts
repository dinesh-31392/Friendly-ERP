import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * Procurement: material master, purchase orders (with approval + goods
 * receipt), stock movements, and machinery. Tables added in migration 016.
 * RLS + RBAC (view_procurement / manage_procurement / approve_purchase_orders).
 */

const UUID = '^[0-9a-fA-F-]{36}$';
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

interface PoLine { materialId?: string; description: string; unit: string; qty: number; rate: number; receivedQty: number }

export async function procurementRoutes(app: FastifyInstance): Promise<void> {
  // ── Materials ───────────────────────────────────────────────────────────
  app.get('/api/materials', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_procurement')) return reply.code(403).send({ error: 'Missing permission: view_procurement' });
      const { rows } = await db.query('SELECT * FROM materials ORDER BY name');
      return { materials: rows.map(r => ({ id: r.id, name: r.name, category: r.category, unit: r.unit, reorderLevel: Number(r.reorder_level) })) };
    }),
  );

  app.post<{ Body: { name: string; category?: string; unit?: string; reorderLevel?: number } }>(
    '/api/materials',
    { preHandler: requireAuth, schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: {
      name: { type: 'string', minLength: 1, maxLength: 160 }, category: { type: 'string', maxLength: 80 }, unit: { type: 'string', maxLength: 24 }, reorderLevel: { type: 'number', minimum: 0 },
    } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_procurement')) return reply.code(403).send({ error: 'Missing permission: manage_procurement' });
        const { rows } = await db.query('INSERT INTO materials (tenant_id, name, category, unit, reorder_level) VALUES (app_current_tenant(), $1,$2,$3,$4) RETURNING *', [req.body.name, req.body.category || '', req.body.unit || 'nos', req.body.reorderLevel ?? 0]);
        const r = rows[0];
        reply.code(201); return { material: { id: r.id, name: r.name, category: r.category, unit: r.unit, reorderLevel: Number(r.reorder_level) } };
      }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/materials/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_procurement')) return reply.code(403).send({ error: 'Missing permission: manage_procurement' });
        // Stock history cascades with the material (FK ON DELETE CASCADE), so
        // refuse when movements exist — same guard the SPA applies.
        const { rows: txns } = await db.query('SELECT 1 FROM stock_txns WHERE material_id = $1 LIMIT 1', [req.params.id]);
        if (txns[0]) return reply.code(409).send({ error: 'This material has stock movements — it cannot be deleted' });
        const { rowCount } = await db.query('DELETE FROM materials WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Material not found' });
        reply.code(204); return null;
      }),
  );

  // ── Purchase orders ─────────────────────────────────────────────────────
  const poToApi = (r: Record<string, unknown>) => ({ id: r.id, number: r.number, vendorId: r.vendor_id, projectId: r.project_id, status: r.status, lines: r.lines, expectedDate: r.expected_date, notes: r.notes, createdBy: r.created_by, approvedBy: r.approved_by, approvedAt: r.approved_at });

  app.get('/api/purchase-orders', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_procurement')) return reply.code(403).send({ error: 'Missing permission: view_procurement' });
      const { rows } = await db.query('SELECT * FROM purchase_orders ORDER BY number DESC');
      return { purchaseOrders: rows.map(poToApi) };
    }),
  );

  app.post<{ Body: { vendorId: string; projectId?: string; lines: PoLine[]; expectedDate?: string; notes?: string } }>(
    '/api/purchase-orders',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['vendorId', 'lines'], additionalProperties: false, properties: {
        vendorId: { type: 'string', pattern: UUID }, projectId: { type: 'string', pattern: UUID }, expectedDate: { type: 'string' }, notes: { type: 'string', maxLength: 1000 },
        lines: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', required: ['description', 'qty', 'rate'], additionalProperties: false, properties: {
          materialId: { type: 'string', pattern: UUID }, description: { type: 'string', maxLength: 300 }, unit: { type: 'string', maxLength: 24 }, qty: { type: 'number', exclusiveMinimum: 0 }, rate: { type: 'number', minimum: 0 }, receivedQty: { type: 'number', minimum: 0 },
        } } },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_procurement')) return reply.code(403).send({ error: 'Missing permission: manage_procurement' });
        const { rows: v } = await db.query('SELECT id FROM vendors WHERE id = $1', [req.body.vendorId]);
        if (!v[0]) return reply.code(404).send({ error: 'Vendor not found' });
        const lines = req.body.lines.map(l => ({ ...l, unit: l.unit || 'nos', receivedQty: l.receivedQty ?? 0 }));
        const { rows: seq } = await db.query('SELECT COALESCE(MAX(number),0)+1 AS n FROM purchase_orders');
        const { rows } = await db.query(
          `INSERT INTO purchase_orders (tenant_id, number, vendor_id, project_id, lines, expected_date, notes, created_by)
           VALUES (app_current_tenant(), $1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING *`,
          [seq[0].n, req.body.vendorId, req.body.projectId || null, JSON.stringify(lines), req.body.expectedDate || null, req.body.notes || null, req.ctx.userId || null]);
        reply.code(201); return { purchaseOrder: poToApi(rows[0]) };
      }),
  );

  /** PATCH — approve (approver-gated) or cancel a PO. */
  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/api/purchase-orders/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['approved', 'cancelled'] } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        // Approving a PO is the checker step — its own permission.
        const perm = req.body.status === 'approved' ? 'approve_purchase_orders' : 'manage_procurement';
        if (!await gate(db, perm)) return reply.code(403).send({ error: `Missing permission: ${perm}` });
        const approving = req.body.status === 'approved';
        const { rows } = await db.query(
          `UPDATE purchase_orders SET status = $1,
             approved_by = CASE WHEN $2 THEN $3::uuid ELSE approved_by END,
             approved_at = CASE WHEN $2 THEN now() ELSE approved_at END
           WHERE id = $4 RETURNING *`,
          [req.body.status, approving, req.ctx.userId || null, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Purchase order not found' });
        return { purchaseOrder: poToApi(rows[0]) };
      }),
  );

  /** POST /:id/receive — goods receipt: bump received quantities, recompute status. */
  app.post<{ Params: { id: string }; Body: { receipts: { index: number; receivedQty: number }[] } }>(
    '/api/purchase-orders/:id/receive',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', required: ['receipts'], additionalProperties: false, properties: {
          receipts: { type: 'array', minItems: 1, items: { type: 'object', required: ['index', 'receivedQty'], additionalProperties: false, properties: { index: { type: 'integer', minimum: 0 }, receivedQty: { type: 'number', minimum: 0 } } } },
        } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_procurement')) return reply.code(403).send({ error: 'Missing permission: manage_procurement' });
        const { rows: cur } = await db.query('SELECT * FROM purchase_orders WHERE id = $1', [req.params.id]);
        if (!cur[0]) return reply.code(404).send({ error: 'Purchase order not found' });
        if (cur[0].status === 'pending_approval' || cur[0].status === 'cancelled') return reply.code(400).send({ error: 'PO must be approved before receiving goods' });

        const lines: PoLine[] = (cur[0].lines as PoLine[]).map(l => ({ ...l }));
        for (const rec of req.body.receipts) {
          if (rec.index < lines.length) lines[rec.index].receivedQty = Math.min(lines[rec.index].qty, rec.receivedQty);
        }
        const fully = lines.every(l => l.receivedQty >= l.qty);
        const any = lines.some(l => l.receivedQty > 0);
        const status = fully ? 'received' : any ? 'partially_received' : cur[0].status;
        const { rows } = await db.query('UPDATE purchase_orders SET lines = $1::jsonb, status = $2 WHERE id = $3 RETURNING *', [JSON.stringify(lines), status, req.params.id]);
        return { purchaseOrder: poToApi(rows[0]) };
      }),
  );

  // ── Stock movements ─────────────────────────────────────────────────────
  const stockToApi = (r: Record<string, unknown>) => ({ id: r.id, materialId: r.material_id, projectId: r.project_id, type: r.type, qty: Number(r.qty), rate: num(r.rate), vendorId: r.vendor_id, poId: r.po_id, reference: r.reference, notes: r.notes, date: r.txn_date });

  app.get<{ Querystring: { materialId?: string } }>('/api/stock-txns', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_procurement')) return reply.code(403).send({ error: 'Missing permission: view_procurement' });
      const { rows } = req.query.materialId
        ? await db.query('SELECT * FROM stock_txns WHERE material_id = $1 ORDER BY txn_date DESC', [req.query.materialId])
        : await db.query('SELECT * FROM stock_txns ORDER BY txn_date DESC LIMIT 1000');
      return { stockTxns: rows.map(stockToApi) };
    }),
  );

  app.post<{ Body: { materialId: string; type: string; qty: number; projectId?: string; rate?: number; vendorId?: string; poId?: string; reference?: string; notes?: string; date?: string } }>(
    '/api/stock-txns',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['materialId', 'type', 'qty'], additionalProperties: false, properties: {
        materialId: { type: 'string', pattern: UUID }, type: { type: 'string', enum: ['inward', 'outward'] }, qty: { type: 'number', exclusiveMinimum: 0 },
        projectId: { type: 'string', pattern: UUID }, rate: { type: 'number', minimum: 0 }, vendorId: { type: 'string', pattern: UUID }, poId: { type: 'string', pattern: UUID },
        reference: { type: 'string', maxLength: 64 }, notes: { type: 'string', maxLength: 500 }, date: { type: 'string' },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_procurement')) return reply.code(403).send({ error: 'Missing permission: manage_procurement' });
        const { rows: m } = await db.query('SELECT id FROM materials WHERE id = $1', [req.body.materialId]);
        if (!m[0]) return reply.code(404).send({ error: 'Material not found' });
        const b = req.body;
        const { rows } = await db.query(
          `INSERT INTO stock_txns (tenant_id, material_id, project_id, type, qty, rate, vendor_id, po_id, reference, notes, created_by, txn_date)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, CURRENT_DATE)) RETURNING *`,
          [b.materialId, b.projectId || null, b.type, b.qty, b.rate ?? null, b.vendorId || null, b.poId || null, b.reference || null, b.notes || null, req.ctx.userId || null, b.date || null]);
        reply.code(201); return { stockTxn: stockToApi(rows[0]) };
      }),
  );

  // ── Machinery ───────────────────────────────────────────────────────────
  const machineToApi = (r: Record<string, unknown>) => ({ id: r.id, name: r.name, category: r.category, registrationNo: r.registration_no, ownership: r.ownership, projectId: r.project_id, status: r.status, nextServiceDate: r.next_service_date, notes: r.notes });

  app.get('/api/machines', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_procurement')) return reply.code(403).send({ error: 'Missing permission: view_procurement' });
      const { rows } = await db.query('SELECT * FROM machines ORDER BY name');
      return { machines: rows.map(machineToApi) };
    }),
  );

  app.post<{ Body: { name: string; category?: string; registrationNo?: string; ownership?: string; projectId?: string; status?: string; nextServiceDate?: string; notes?: string } }>(
    '/api/machines',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 }, category: { type: 'string', maxLength: 80 }, registrationNo: { type: 'string', maxLength: 40 },
        ownership: { type: 'string', enum: ['owned', 'rented'] }, projectId: { type: 'string', pattern: UUID }, status: { type: 'string', enum: ['on_site', 'idle', 'maintenance'] }, nextServiceDate: { type: 'string' }, notes: { type: 'string', maxLength: 500 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_procurement')) return reply.code(403).send({ error: 'Missing permission: manage_procurement' });
        const b = req.body;
        const { rows } = await db.query(
          `INSERT INTO machines (tenant_id, name, category, registration_no, ownership, project_id, status, next_service_date, notes)
           VALUES (app_current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [b.name, b.category || '', b.registrationNo || null, b.ownership || 'owned', b.projectId || null, b.status || 'idle', b.nextServiceDate || null, b.notes || null]);
        reply.code(201); return { machine: machineToApi(rows[0]) };
      }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/machines/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_procurement')) return reply.code(403).send({ error: 'Missing permission: manage_procurement' });
        const { rowCount } = await db.query('DELETE FROM machines WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Machine not found' });
        reply.code(204); return null;
      }),
  );

  app.patch<{ Params: { id: string }; Body: { status?: string; projectId?: string; nextServiceDate?: string } }>(
    '/api/machines/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: { status: { type: 'string', enum: ['on_site', 'idle', 'maintenance'] }, projectId: { type: 'string', pattern: UUID }, nextServiceDate: { type: 'string' } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_procurement')) return reply.code(403).send({ error: 'Missing permission: manage_procurement' });
        const b = req.body;
        const { rows } = await db.query(
          `UPDATE machines SET status = COALESCE($1, status), project_id = COALESCE($2, project_id), next_service_date = COALESCE($3, next_service_date) WHERE id = $4 RETURNING *`,
          [b.status ?? null, b.projectId ?? null, b.nextServiceDate ?? null, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Machine not found' });
        return { machine: machineToApi(rows[0]) };
      }),
  );
}
