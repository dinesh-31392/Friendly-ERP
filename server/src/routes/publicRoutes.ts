import type { FastifyInstance } from 'fastify';
import { platformPool, withTenantContext } from '../db.js';

/**
 * PUBLIC, unauthenticated endpoints for the website chatbot a builder embeds on
 * their own site. These are the ONLY lead routes without requireAuth, so they
 * are deliberately narrow and defensive:
 *
 *  • The tenant is resolved SERVER-SIDE from the slug in the URL — never from a
 *    tenant id in the request body. A caller can only ever create a lead for,
 *    or read the public config of, the workspace whose slug they hit.
 *  • The GET returns only public-safe fields (branding, project price ranges,
 *    the builder's own questions). No PII, no secrets.
 *  • The POST is insert-only, honeypot-guarded, validated and rate-limited.
 *  • Everything runs under withTenantContext, so RLS still scopes every query.
 */

interface CustomFieldDTO { key: string; label: string; type: string; options?: string[]; required: boolean; qualifying?: boolean }

const DEFAULT_CONFIG = {
  enabled: true,
  greeting: "Hi! 👋 I can help you find the right home. A few quick questions and our team will reach out.",
  accentColor: '#6366f1',
  projectMode: 'all' as 'all' | 'selected',
  projectIds: [] as string[],
  timelineOptions: ['Immediately', '1–3 months', '3–6 months', 'Just exploring'],
  customFields: [
    { key: 'financing', label: 'How are you planning to purchase?', type: 'select', options: ['Home loan', 'Cash / self-funded', 'Not decided yet'], required: true, qualifying: true },
  ] as CustomFieldDTO[],
  hotMin: 70, warmMin: 45, qualifyMin: 55,
};

const QUAL_STATUSES = ['hot', 'warm', 'cold', 'unqualified'];

/** Resolve a tenant by public slug via the platform pool (login lookup path).
 *  Returns null for unknown or suspended workspaces (a live public surface must
 *  go dark exactly like the login/microsite lifecycle gate). */
async function resolveTenant(slug: string) {
  const { rows } = await platformPool.query(
    `SELECT id, name, company, currency, primary_color, status FROM tenants WHERE slug = $1`,
    [slug],
  );
  const t = rows[0];
  if (!t || t.status === 'suspended') return null;
  return t;
}

function configFromRow(r: Record<string, unknown> | undefined) {
  if (!r) return { ...DEFAULT_CONFIG };
  return {
    enabled: r.enabled as boolean,
    greeting: (r.greeting as string) || DEFAULT_CONFIG.greeting,
    accentColor: (r.accent_color as string) || DEFAULT_CONFIG.accentColor,
    projectMode: (r.project_mode as 'all' | 'selected') || 'all',
    projectIds: (r.project_ids as string[]) || [],
    timelineOptions: ((r.timeline_options as string[])?.length ? r.timeline_options : DEFAULT_CONFIG.timelineOptions) as string[],
    customFields: (r.custom_fields as CustomFieldDTO[]) || [],
    hotMin: r.hot_min as number, warmMin: r.warm_min as number, qualifyMin: r.qualify_min as number,
  };
}

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/public/chatbot/:slug — everything the embedded widget needs to
   * render: tenant branding, the chatbot config, and the offered projects
   * (public marketing fields only).
   */
  app.get<{ Params: { slug: string } }>(
    '/api/public/chatbot/:slug',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { params: { type: 'object', required: ['slug'], properties: { slug: { type: 'string', maxLength: 80 } } } },
    },
    async (req, reply) => {
      const tenant = await resolveTenant(req.params.slug);
      if (!tenant) return reply.code(404).send({ error: 'Not found' });

      const ctx = { tenantId: tenant.id as string, userId: '', ip: req.ip };
      return withTenantContext(ctx, async (db) => {
        const { rows: cfgRows } = await db.query('SELECT * FROM chatbot_configs WHERE tenant_id = app_current_tenant()');
        const config = configFromRow(cfgRows[0]);

        let projects: { id: string; name: string; location: string; priceMin: number; priceMax: number }[] = [];
        if (config.enabled) {
          const { rows: pj } = await db.query(
            `SELECT id, name, location, COALESCE(price_min,0) AS price_min, COALESCE(price_max,0) AS price_max
               FROM projects ORDER BY name`,
          );
          projects = pj
            .filter(p => config.projectMode !== 'selected' || config.projectIds.includes(p.id))
            .map(p => ({ id: p.id, name: p.name, location: p.location, priceMin: Number(p.price_min), priceMax: Number(p.price_max) }));
        }

        return {
          tenant: { name: tenant.name, currency: tenant.currency, primaryColor: tenant.primary_color },
          config, projects,
        };
      });
    },
  );

  /**
   * POST /api/public/leads — capture a lead from the chatbot. Insert-only.
   */
  app.post<{ Body: {
    slug: string; name: string; phone: string; email?: string; projectId?: string;
    budget?: number; configuration?: string; timeline?: string;
    customFields?: Record<string, string>;
    qualification?: { status: string; score: number; reasons?: string[] };
    hp?: string;   // honeypot
  } }>(
    '/api/public/leads',
    {
      config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object', required: ['slug', 'name', 'phone'], additionalProperties: false,
          properties: {
            slug: { type: 'string', maxLength: 80 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            phone: { type: 'string', minLength: 3, maxLength: 32 },
            email: { type: 'string', maxLength: 160 },
            projectId: { type: 'string', maxLength: 40 },
            budget: { type: 'number', minimum: 0, maximum: 1e12 },
            configuration: { type: 'string', maxLength: 40 },
            timeline: { type: 'string', maxLength: 40 },
            customFields: { type: 'object', additionalProperties: { type: 'string', maxLength: 500 } },
            qualification: {
              type: 'object', additionalProperties: false,
              properties: {
                status: { type: 'string', enum: QUAL_STATUSES },
                score: { type: 'number', minimum: 0, maximum: 100 },
                reasons: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 12 },
              },
            },
            hp: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      // Honeypot: a filled hidden field means a bot. Ack with 200 but don't write.
      if (req.body.hp && req.body.hp.trim() !== '') return { ok: true, dropped: true };

      const tenant = await resolveTenant(req.body.slug);
      if (!tenant) return reply.code(404).send({ error: 'Not found' });

      const q = req.body.qualification;
      const score = q ? Math.max(0, Math.min(100, Math.round(q.score))) : 0;
      const ctx = { tenantId: tenant.id as string, userId: '', ip: req.ip };

      return withTenantContext(ctx, async (db) => {
        // Qualified-from threshold is per tenant; read it (or default 55).
        const { rows: cfgRows } = await db.query('SELECT qualify_min FROM chatbot_configs WHERE tenant_id = app_current_tenant()');
        const qualifyMin = cfgRows[0]?.qualify_min ?? 55;

        const stage = q && q.status !== 'unqualified' && score >= qualifyMin ? 'qualified' : 'new';
        const priority = q ? (q.status === 'hot' ? 'hot' : q.status === 'warm' ? 'warm' : 'cold') : 'warm';

        // Project attribution — only when the id genuinely belongs to this
        // tenant (RLS already scopes the read; this also gives us the name).
        let projectId: string | null = null;
        let projectName = '';
        if (req.body.projectId) {
          const { rows: pr } = await db.query('SELECT id, name FROM projects WHERE id = $1', [req.body.projectId]);
          if (pr[0]) { projectId = pr[0].id; projectName = pr[0].name; }
        }

        // Capacity-based routing: the active sales rep with the fewest open leads.
        const { rows: rep } = await db.query(
          `SELECT u.id,
                  (SELECT count(*) FROM leads l WHERE l.assigned_to = u.id AND l.stage NOT IN ('booked','lost')) AS open
             FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.active AND r.name IN ('sales_executive','sales_manager')
            ORDER BY open ASC, u.id ASC
            LIMIT 1`,
        );
        const assignedTo: string | null = rep[0]?.id ?? null;

        const { rows } = await db.query(
          `INSERT INTO leads
             (tenant_id, name, email, phone, source, project_id, project, budget, configuration,
              stage, priority, score, assigned_to, custom_fields, qualification, last_contact_at)
           VALUES
             (app_current_tenant(), $1, $2, $3, 'Chatbot', $4, $5, $6, $7,
              $8, $9, $10, $11, $12::jsonb, $13::jsonb, now())
           RETURNING id`,
          [
            req.body.name, req.body.email || null, req.body.phone,
            projectId, projectName, req.body.budget ?? 0, req.body.configuration || null,
            stage, priority, score, assignedTo,
            JSON.stringify(req.body.customFields || {}),
            q ? JSON.stringify({ status: q.status, score, reasons: q.reasons || [] }) : null,
          ],
        );

        reply.code(201); return { ok: true, leadId: rows[0].id, stage, status: q?.status ?? null };
      });
    },
  );
}
