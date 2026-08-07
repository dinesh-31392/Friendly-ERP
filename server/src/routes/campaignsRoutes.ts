import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sent', 'completed'] as const;

const iso = (v: unknown): string | undefined => (v == null ? undefined : new Date(v as string).toISOString());

// ── Campaigns ────────────────────────────────────────────────────────────────

function toApiCampaign(r: Record<string, unknown>) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    type: r.type ?? 'Broadcast',
    status: r.status,
    audience: r.audience ?? '',
    channel: r.channel ?? '',
    content: r.content ?? '',
    scheduledAt: iso(r.scheduled_at),
    sentAt: iso(r.sent_at),
    createdAt: iso(r.created_at),
  };
}

const CAMPAIGN_WRITABLE: Record<string, string> = {
  name: 'name', type: 'type', status: 'status', audience: 'audience',
  channel: 'channel', content: 'content', scheduledAt: 'scheduled_at', sentAt: 'sent_at',
};

const CAMPAIGN_PROPS = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  type: { type: 'string', maxLength: 60 },
  status: { type: 'string', enum: CAMPAIGN_STATUSES as unknown as string[] },
  audience: { type: 'string', maxLength: 200 },
  channel: { type: 'string', maxLength: 60 },
  content: { type: 'string', maxLength: 20000 },
  scheduledAt: { type: 'string', maxLength: 40 },
  sentAt: { type: 'string', maxLength: 40 },
} as const;

interface CampaignBody {
  name?: string; type?: string; status?: string; audience?: string;
  channel?: string; content?: string; scheduledAt?: string; sentAt?: string;
}

// ── Templates ────────────────────────────────────────────────────────────────

function toApiTemplate(r: Record<string, unknown>) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    category: r.category ?? 'General',
    channel: r.channel ?? '',
    content: r.content ?? '',
    createdAt: iso(r.created_at),
  };
}

const TEMPLATE_WRITABLE: Record<string, string> = {
  name: 'name', category: 'category', channel: 'channel', content: 'content',
};

const TEMPLATE_PROPS = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  category: { type: 'string', maxLength: 60 },
  channel: { type: 'string', maxLength: 60 },
  content: { type: 'string', maxLength: 20000 },
} as const;

interface TemplateBody { name?: string; category?: string; channel?: string; content?: string; }

/** Shared writable-column collector. */
function collect(map: Record<string, string>, body: Record<string, unknown>) {
  const cols: string[] = [];
  const exprs: string[] = [];
  const params: unknown[] = [];
  for (const [key, col] of Object.entries(map)) {
    if (body[key] === undefined) continue;
    params.push(body[key]);
    cols.push(col);
    exprs.push(`$${params.length}`);
  }
  return { cols, exprs, params };
}

function mapWriteError(err: unknown): { error: string } | null {
  switch ((err as { code?: string })?.code) {
    case '23514': return { error: `Invalid status — must be one of: ${CAMPAIGN_STATUSES.join(', ')}.` };
    case '23502': return { error: 'A required field is missing.' };
    case '22P02': case '22007': return { error: 'A field has an invalid value.' };
    default: return null;
  }
}

export async function campaignsRoutes(app: FastifyInstance): Promise<void> {
  // ── Campaigns ──────────────────────────────────────────────────────────────

  app.get('/api/campaigns', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_campaigns') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_campaigns' });
      const { rows } = await db.query('SELECT * FROM campaigns ORDER BY created_at DESC');
      return { campaigns: rows.map(toApiCampaign) };
    }),
  );

  app.post<{ Body: CampaignBody }>(
    '/api/campaigns',
    { preHandler: requireAuth, schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: CAMPAIGN_PROPS } } },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_campaigns') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_campaigns' });
          const { cols, exprs, params } = collect(CAMPAIGN_WRITABLE, req.body as Record<string, unknown>);
          const { rows } = await db.query(
            `INSERT INTO campaigns (tenant_id${cols.length ? ', ' + cols.join(', ') : ''})
             VALUES (app_current_tenant()${exprs.length ? ', ' + exprs.join(', ') : ''}) RETURNING *`,
            params,
          );
          reply.code(201); return { campaign: toApiCampaign(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: CampaignBody }>(
    '/api/campaigns/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: CAMPAIGN_PROPS },
      },
    },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_campaigns') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_campaigns' });
          const { rows: found } = await db.query('SELECT 1 FROM campaigns WHERE id = $1', [req.params.id]);
          if (found.length === 0) return reply.code(404).send({ error: 'Campaign not found' });
          const { cols, exprs, params } = collect(CAMPAIGN_WRITABLE, req.body as Record<string, unknown>);
          if (cols.length === 0) return reply.code(400).send({ error: 'No writable fields supplied' });
          const sets = cols.map((c, i) => `${c} = ${exprs[i]}`);
          params.push(req.params.id);
          const { rows } = await db.query(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
          return { campaign: toApiCampaign(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/campaigns/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_campaigns') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_campaigns' });
        const { rowCount } = await db.query('DELETE FROM campaigns WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Campaign not found' });
        reply.code(204); return null;
      }),
  );

  // ── Templates ──────────────────────────────────────────────────────────────

  app.get('/api/templates', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_campaigns') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_campaigns' });
      const { rows } = await db.query('SELECT * FROM templates ORDER BY created_at DESC');
      return { templates: rows.map(toApiTemplate) };
    }),
  );

  app.post<{ Body: TemplateBody }>(
    '/api/templates',
    { preHandler: requireAuth, schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: TEMPLATE_PROPS } } },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_campaigns') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_campaigns' });
          const { cols, exprs, params } = collect(TEMPLATE_WRITABLE, req.body as Record<string, unknown>);
          const { rows } = await db.query(
            `INSERT INTO templates (tenant_id${cols.length ? ', ' + cols.join(', ') : ''})
             VALUES (app_current_tenant()${exprs.length ? ', ' + exprs.join(', ') : ''}) RETURNING *`,
            params,
          );
          reply.code(201); return { template: toApiTemplate(rows[0]) };
        });
      } catch (err) {
        if ((err as { code?: string })?.code === '23502') return reply.code(400).send({ error: 'A required field is missing.' });
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/templates/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_campaigns') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_campaigns' });
        const { rowCount } = await db.query('DELETE FROM templates WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Template not found' });
        reply.code(204); return null;
      }),
  );
}
