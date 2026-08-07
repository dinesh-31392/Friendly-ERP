import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { withTenantContext, platformPool } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * Two small modules added in migration 020:
 *
 *  • branches — PLATFORM org units grouping builder tenants. The table is
 *    granted only to app_platform (the tenant runtime has zero DB access), and
 *    every route re-verifies the caller is an ACTIVE super_admin/tech_team user
 *    of the platform tenant. A builder super_admin gets 403 here.
 *  • call_logs — tenant-scoped telephony history per lead (SIM/cloud), the
 *    persistence the call-log modal previously wrote only into localStorage.
 */

const UUID = '^[0-9a-fA-F-]{36}$';
async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

/** Platform-staff check via the platform pool (branches carry no tenant_id, so
 *  the RLS/tenant path doesn't apply). Identity still comes only from the JWT. */
async function requirePlatformStaff(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const { rows } = await platformPool.query(
    `SELECT t.slug, r.name AS role, u.active
       FROM users u JOIN tenants t ON t.id = u.tenant_id JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.tenant_id = $2`,
    [req.ctx.userId, req.ctx.tenantId],
  );
  const u = rows[0];
  if (!u || !u.active || u.slug !== 'platform' || !['super_admin', 'tech_team'].includes(u.role)) {
    reply.code(403).send({ error: 'Platform staff only' });
    return false;
  }
  return true;
}

export async function branchCallRoutes(app: FastifyInstance): Promise<void> {
  // ── Branches (platform) ─────────────────────────────────────────────────
  const branchToApi = (r: Record<string, unknown>) => ({ id: r.id, name: r.name, managerId: r.manager_id, createdAt: r.created_at });

  app.get('/api/branches', { preHandler: requireAuth }, async (req, reply) => {
    if (!await requirePlatformStaff(req, reply)) return;
    const { rows } = await platformPool.query('SELECT * FROM branches ORDER BY name');
    return { branches: rows.map(branchToApi) };
  });

  app.post<{ Body: { name: string; managerId?: string } }>(
    '/api/branches',
    { preHandler: requireAuth, schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 }, managerId: { type: 'string', pattern: UUID },
    } } } },
    async (req, reply) => {
      if (!await requirePlatformStaff(req, reply)) return;
      try {
        const { rows } = await platformPool.query('INSERT INTO branches (name, manager_id) VALUES ($1, $2) RETURNING *', [req.body.name, req.body.managerId || null]);
        reply.code(201); return { branch: branchToApi(rows[0]) };
      } catch (err) {
        if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'A branch with this name already exists' });
        throw err;
      }
    },
  );

  /** PUT /api/branches/assign-tenant — move a builder workspace into a branch. */
  app.put<{ Body: { tenantId: string; branchId: string | null } }>(
    '/api/branches/assign-tenant',
    { preHandler: requireAuth, schema: { body: { type: 'object', required: ['tenantId'], additionalProperties: false, properties: {
      tenantId: { type: 'string', pattern: UUID }, branchId: { type: ['string', 'null'], pattern: UUID },
    } } } },
    async (req, reply) => {
      if (!await requirePlatformStaff(req, reply)) return;
      const { rows } = await platformPool.query('UPDATE tenants SET branch_id = $1 WHERE id = $2 RETURNING id, name, branch_id', [req.body.branchId, req.body.tenantId]);
      if (!rows[0]) return reply.code(404).send({ error: 'Tenant not found' });
      return { tenant: { id: rows[0].id, name: rows[0].name, branchId: rows[0].branch_id } };
    },
  );

  // ── Call logs (tenant) ──────────────────────────────────────────────────
  const callToApi = (r: Record<string, unknown>) => ({ id: r.id, leadId: r.lead_id, userId: r.user_id, mode: r.mode, status: r.status, durationSeconds: r.duration_seconds, notes: r.notes, recordingUrl: r.recording_url, createdAt: r.created_at });

  app.get<{ Querystring: { leadId?: string } }>('/api/call-logs', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_leads')) return reply.code(403).send({ error: 'Missing permission: view_leads' });
      const { rows } = req.query.leadId
        ? await db.query('SELECT * FROM call_logs WHERE lead_id = $1 ORDER BY created_at DESC', [req.query.leadId])
        : await db.query('SELECT * FROM call_logs ORDER BY created_at DESC LIMIT 500');
      return { callLogs: rows.map(callToApi) };
    }),
  );

  app.post<{ Body: { leadId: string; mode?: string; status: string; durationSeconds?: number; notes?: string; recordingUrl?: string } }>(
    '/api/call-logs',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['leadId', 'status'], additionalProperties: false, properties: {
        leadId: { type: 'string', pattern: UUID }, mode: { type: 'string', enum: ['SIM_NATIVE', 'API_CLOUD'] },
        status: { type: 'string', enum: ['connected', 'no_answer', 'busy', 'wrong_number', 'callback_requested'] },
        durationSeconds: { type: 'integer', minimum: 0 }, notes: { type: 'string', maxLength: 2000 }, recordingUrl: { type: 'string', maxLength: 500 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        // Logging a call is an own-lead action — either permission suffices.
        if (!await gate(db, 'manage_leads') && !await gate(db, 'manage_own_leads')) return reply.code(403).send({ error: 'Missing permission: manage_own_leads' });
        const { rows: lead } = await db.query('SELECT id FROM leads WHERE id = $1', [req.body.leadId]);
        if (!lead[0]) return reply.code(404).send({ error: 'Lead not found' });
        const b = req.body;
        const { rows } = await db.query(
          `INSERT INTO call_logs (tenant_id, lead_id, user_id, mode, status, duration_seconds, notes, recording_url)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [b.leadId, req.ctx.userId || null, b.mode || 'SIM_NATIVE', b.status, b.durationSeconds ?? 0, b.notes || null, b.recordingUrl || null]);
        reply.code(201); return { callLog: callToApi(rows[0]) };
      }),
  );
}
