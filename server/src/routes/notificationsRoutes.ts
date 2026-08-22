import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * The notification inbox (migration 040).
 *
 * Every route here is scoped to the CALLER, not to a user id in the request.
 * There is deliberately no "read someone else's inbox" endpoint and no
 * permission that grants one: a notification is addressed to a person, and the
 * only thing a manager should be able to see is the underlying record, which
 * has its own permission already.
 *
 * That is also why none of these call has_permission(). The authorisation is
 * structural — `user_id = app_current_user()` — rather than a grant somebody
 * could be given by mistake.
 */

const UUID = '^[0-9a-fA-F-]{36}$';

const toApi = (r: Record<string, unknown>) => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  body: r.body ?? '',
  entityType: r.entity_type ?? undefined,
  entityId: r.entity_id ?? undefined,
  readAt: r.read_at ?? null,
  createdAt: r.created_at,
});

export async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/notifications — the caller's inbox, newest first.
   *
   * Returns the unread count alongside the rows so the bell badge does not
   * need a second request. Capped at 50: an inbox is a recent-activity feed,
   * not an archive, and nobody scrolls to notification 400.
   */
  app.get<{ Querystring: { unreadOnly?: string } }>(
    '/api/notifications',
    { preHandler: requireAuth },
    async (req) =>
      withTenantContext(req.ctx, async (db) => {
        const unreadOnly = req.query.unreadOnly === 'true';
        const { rows } = await db.query(
          `SELECT * FROM notifications
            WHERE user_id = app_current_user()
              AND ($1::boolean IS NOT TRUE OR read_at IS NULL)
            ORDER BY created_at DESC
            LIMIT 50`, [unreadOnly]);
        const { rows: [c] } = await db.query(
          `SELECT count(*)::int AS n FROM notifications
            WHERE user_id = app_current_user() AND read_at IS NULL`);
        return { notifications: rows.map(toApi), unreadCount: c.n };
      }),
  );

  /** PATCH /api/notifications/:id — mark one read. Idempotent. */
  app.patch<{ Params: { id: string } }>(
    '/api/notifications/:id',
    {
      preHandler: requireAuth,
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        // COALESCE keeps the first read time rather than moving it forward on
        // every re-mark, so "when did they see this" stays answerable.
        const { rows } = await db.query(
          `UPDATE notifications SET read_at = COALESCE(read_at, now())
            WHERE id = $1 AND user_id = app_current_user()
            RETURNING *`, [req.params.id]);
        // 404 rather than 403 for someone else's notification — the endpoint
        // must not confirm that an id it will not show you exists.
        if (!rows[0]) return reply.code(404).send({ error: 'Not found' });
        reply.code(200);
        return { notification: toApi(rows[0]) };
      }),
  );

  /** POST /api/notifications/read-all — clear the badge. */
  app.post('/api/notifications/read-all', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE notifications SET read_at = now()
          WHERE user_id = app_current_user() AND read_at IS NULL`);
      reply.code(200);
      return { marked: rowCount ?? 0 };
    }),
  );

  /**
   * GET /api/notification-prefs — the caller's own toggles.
   *
   * Returns only the explicit rows. Absence means enabled (see
   * wants_notification), so the client fills in defaults rather than the
   * server inventing a row per kind for every user who has never opened
   * Settings.
   */
  app.get('/api/notification-prefs', { preHandler: requireAuth }, async (req) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows } = await db.query(
        `SELECT kind, enabled FROM notification_prefs WHERE user_id = app_current_user()`);
      return { prefs: Object.fromEntries(rows.map(r => [r.kind, r.enabled])) };
    }),
  );

  /** PUT /api/notification-prefs/:kind — set one toggle. */
  app.put<{ Params: { kind: string }; Body: { enabled: boolean } }>(
    '/api/notification-prefs/:kind',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', maxLength: 64, pattern: '^[a-z_]+$' } } },
        body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        await db.query(
          `INSERT INTO notification_prefs (tenant_id, user_id, kind, enabled)
           VALUES (app_current_tenant(), app_current_user(), $1, $2)
           ON CONFLICT (user_id, kind) DO UPDATE SET enabled = EXCLUDED.enabled`,
          [req.params.kind, req.body.enabled]);
        reply.code(200);
        return { kind: req.params.kind, enabled: req.body.enabled };
      }),
  );
}
