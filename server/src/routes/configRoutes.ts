import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * Tenant configuration persistence:
 *  • approval_workflows — the discount/cancellation/vendor-bill approval matrix
 *    (003), previously localStorage-only.
 *  • schema_definitions WRITE — the metadata that drives pipelines/forms. GET
 *    /api/meta/:entity already reads it; without a write endpoint the SPA's
 *    pipeline/form customization couldn't persist in API mode. This adds a
 *    versioned upsert so config actually saves server-side.
 * Both gated on manage_settings.
 */

const UUID = '^[0-9a-fA-F-]{36}$';
const ACTION_TYPES = ['discount_approval', 'cancellation_approval', 'transfer_approval', 'vendor_bill_approval', 'ra_bill_approval'];
const KINDS = ['form', 'pipeline', 'validation', 'list_view'];

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

export async function configRoutes(app: FastifyInstance): Promise<void> {
  // ── Approval workflows ──────────────────────────────────────────────────
  app.get('/api/approval-workflows', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'manage_settings')) return reply.code(403).send({ error: 'Missing permission: manage_settings' });
      const { rows } = await db.query('SELECT * FROM approval_workflows ORDER BY action_type');
      return { workflows: rows.map(r => ({ id: r.id, actionType: r.action_type, thresholdAmount: r.threshold_amount === null ? null : Number(r.threshold_amount), approverRoleId: r.approver_role_id })) };
    }),
  );

  /** PUT /api/approval-workflows — upsert one action_type's rule. */
  app.put<{ Body: { actionType: string; thresholdAmount?: number | null; approverRoleId: string } }>(
    '/api/approval-workflows',
    {
      preHandler: requireAuth,
      // approverRoleId is OPTIONAL. Setting a threshold and choosing who
      // approves are two different decisions, and the settings UI only offers
      // the first — requiring both here is part of why this endpoint sat
      // unused while the SPA wrote thresholds to localStorage instead.
      // Omitted, it defaults to builder_admin, which holds every approve_* key
      // by construction, and an existing rule keeps whatever approver it has.
      schema: { body: { type: 'object', required: ['actionType'], additionalProperties: false, properties: {
        actionType: { type: 'string', enum: ACTION_TYPES },
        thresholdAmount: { type: ['number', 'null'], minimum: 0 },
        approverRoleId: { type: 'string', pattern: UUID },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_settings')) return reply.code(403).send({ error: 'Missing permission: manage_settings' });

        let approverRoleId = req.body.approverRoleId;
        if (approverRoleId) {
          // The approver role must belong to this tenant (RLS scopes the read).
          const { rows: role } = await db.query('SELECT id FROM roles WHERE id = $1', [approverRoleId]);
          if (!role[0]) return reply.code(404).send({ error: 'Approver role not found' });
        } else {
          // Keep the approver already on the rule; fall back to builder_admin
          // for a rule being created for the first time.
          const { rows: [existing] } = await db.query(
            'SELECT approver_role_id FROM approval_workflows WHERE action_type = $1', [req.body.actionType]);
          if (existing) {
            approverRoleId = existing.approver_role_id;
          } else {
            const { rows: [owner] } = await db.query(
              `SELECT id FROM roles WHERE name = 'builder_admin' LIMIT 1`);
            if (!owner) return reply.code(400).send({ error: 'No approver role available in this workspace' });
            approverRoleId = owner.id;
          }
        }

        const { rows } = await db.query(
          `INSERT INTO approval_workflows (tenant_id, action_type, threshold_amount, approver_role_id)
           VALUES (app_current_tenant(), $1, $2, $3)
           ON CONFLICT (tenant_id, action_type) DO UPDATE SET threshold_amount = EXCLUDED.threshold_amount, approver_role_id = EXCLUDED.approver_role_id
           RETURNING *`,
          [req.body.actionType, req.body.thresholdAmount ?? null, approverRoleId]);
        const r = rows[0];
        return { workflow: { id: r.id, actionType: r.action_type, thresholdAmount: r.threshold_amount === null ? null : Number(r.threshold_amount), approverRoleId: r.approver_role_id } };
      }),
  );

  app.delete<{ Params: { actionType: string } }>(
    '/api/approval-workflows/:actionType',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['actionType'], properties: { actionType: { type: 'string', enum: ACTION_TYPES } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_settings')) return reply.code(403).send({ error: 'Missing permission: manage_settings' });
        await db.query('DELETE FROM approval_workflows WHERE action_type = $1', [req.params.actionType]);
        reply.code(204); return null;
      }),
  );

  // ── Metadata write (versioned schema-definition upsert) ─────────────────
  /**
   * PUT /api/meta/:entity — save a form/pipeline/etc definition. Deactivates the
   * current active (entity, kind) and inserts a new active version, so history
   * is preserved and GET /api/meta/:entity keeps returning the latest.
   */
  app.put<{ Params: { entity: string }; Body: { kind: string; definition: unknown } }>(
    '/api/meta/:entity',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['entity'], properties: { entity: { type: 'string', pattern: '^[a-z_]{1,32}$' } } },
        body: { type: 'object', required: ['kind', 'definition'], additionalProperties: false, properties: {
          kind: { type: 'string', enum: KINDS }, definition: {},
        } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_settings')) return reply.code(403).send({ error: 'Missing permission: manage_settings' });
        const { entity } = req.params;
        const { kind } = req.body;
        await db.query('UPDATE schema_definitions SET is_active = false WHERE entity = $1 AND kind = $2 AND is_active', [entity, kind]);
        const { rows: [{ v }] } = await db.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_definitions WHERE entity = $1 AND kind = $2', [entity, kind]);
        const { rows } = await db.query(
          `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition, created_by)
           VALUES (app_current_tenant(), $1, $2, $3, true, $4::jsonb, $5) RETURNING id, entity, kind, version`,
          [entity, kind, v, JSON.stringify(req.body.definition), req.ctx.userId || null]);
        reply.code(201); return { definition: rows[0] };
      }),
  );
}
