import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * Authenticated chatbot CONFIG routes for the in-CRM Chatbot Builder. Both are
 * gated on manage_settings (admin surface). The public widget reads its config
 * through /api/public/chatbot/:slug instead — these are for editing it.
 */

const PROJECT_MODES = ['all', 'selected'];

function toApiConfig(r: Record<string, unknown> | undefined) {
  if (!r) return null;
  return {
    enabled: r.enabled, greeting: r.greeting, accentColor: r.accent_color,
    projectMode: r.project_mode, projectIds: r.project_ids, timelineOptions: r.timeline_options,
    customFields: r.custom_fields, hotMin: r.hot_min, warmMin: r.warm_min, qualifyMin: r.qualify_min,
  };
}

interface ConfigBody {
  enabled?: boolean; greeting?: string; accentColor?: string;
  projectMode?: string; projectIds?: string[]; timelineOptions?: string[];
  customFields?: unknown[]; hotMin?: number; warmMin?: number; qualifyMin?: number;
}

export async function chatbotRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/chatbot/config', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_settings') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_settings' });
      const { rows } = await db.query('SELECT * FROM chatbot_configs WHERE tenant_id = app_current_tenant()');
      return { config: toApiConfig(rows[0]) };   // null when never configured → client uses defaults
    }),
  );

  app.put<{ Body: ConfigBody }>(
    '/api/chatbot/config',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            greeting: { type: 'string', maxLength: 500 },
            accentColor: { type: 'string', maxLength: 16 },
            projectMode: { type: 'string', enum: PROJECT_MODES },
            projectIds: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 200 },
            timelineOptions: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 12 },
            customFields: { type: 'array', maxItems: 30 },
            hotMin: { type: 'number', minimum: 0, maximum: 100 },
            warmMin: { type: 'number', minimum: 0, maximum: 100 },
            qualifyMin: { type: 'number', minimum: 0, maximum: 100 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_settings') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_settings' });

        const b = req.body;
        const { rows } = await db.query(
          `INSERT INTO chatbot_configs
             (tenant_id, enabled, greeting, accent_color, project_mode, project_ids,
              timeline_options, custom_fields, hot_min, warm_min, qualify_min)
           VALUES (app_current_tenant(),
              COALESCE($1, true), COALESCE($2,''), COALESCE($3,'#6366f1'), COALESCE($4,'all'),
              COALESCE($5,'[]')::jsonb, COALESCE($6,'[]')::jsonb, COALESCE($7,'[]')::jsonb,
              COALESCE($8,70), COALESCE($9,45), COALESCE($10,55))
           ON CONFLICT (tenant_id) DO UPDATE SET
              enabled = COALESCE($1, chatbot_configs.enabled),
              greeting = COALESCE($2, chatbot_configs.greeting),
              accent_color = COALESCE($3, chatbot_configs.accent_color),
              project_mode = COALESCE($4, chatbot_configs.project_mode),
              project_ids = COALESCE($5, chatbot_configs.project_ids::text)::jsonb,
              timeline_options = COALESCE($6, chatbot_configs.timeline_options::text)::jsonb,
              custom_fields = COALESCE($7, chatbot_configs.custom_fields::text)::jsonb,
              hot_min = COALESCE($8, chatbot_configs.hot_min),
              warm_min = COALESCE($9, chatbot_configs.warm_min),
              qualify_min = COALESCE($10, chatbot_configs.qualify_min),
              updated_at = now()
           RETURNING *`,
          [
            b.enabled ?? null, b.greeting ?? null, b.accentColor ?? null, b.projectMode ?? null,
            b.projectIds ? JSON.stringify(b.projectIds) : null,
            b.timelineOptions ? JSON.stringify(b.timelineOptions) : null,
            b.customFields ? JSON.stringify(b.customFields) : null,
            b.hotMin ?? null, b.warmMin ?? null, b.qualifyMin ?? null,
          ],
        );
        return { config: toApiConfig(rows[0]) };
      }),
  );
}
