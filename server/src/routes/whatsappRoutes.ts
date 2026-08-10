import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { withTenantContext, platformPool } from '../db.js';
import { requireAuth } from '../auth.js';
import { enqueueAutoReply, drainOutbox } from '../autoReply.js';
import { resolveGateway, ensureInstance, requestQr, connectionStatus, logoutInstance, sendWhatsAppMessage, sendWhatsAppMedia, type MediaKind } from '../evolution.js';

const PROVIDERS = ['click_to_chat', 'meta_cloud_waba', 'evolution'] as const;

// Mirrors the column defaults in 027 — needed because an INSERT that passes an
// explicit NULL overrides the DB default and would violate NOT NULL.
const DEFAULT_NEW_LEAD_TEMPLATE =
  "Hi {{name}}, thanks for your enquiry with {{company}}. I'm {{agent}} and I'll help you personally — when is a good time to talk?";
const DEFAULT_INBOUND_TEMPLATE =
  "Thanks for your message! I've received it and will reply personally very shortly.";
const GRAPH_VERSION = 'v21.0';

/** DB row → the SPA-safe view. Secrets (Meta token, Evolution key) are NEVER
 *  included — the client only learns WHETHER each is set. */
function toApiInstance(r: Record<string, unknown> | undefined) {
  // No row yet (a tenant running on the platform's env gateway). Mirror the
  // column defaults from 026/027 so the UI shows what would actually apply,
  // rather than blanks that look like "off" for settings that have values.
  if (!r) return {
    provider: 'click_to_chat', phoneNumberId: '', displayPhone: '', status: 'disconnected',
    hasToken: false, evolutionUrl: '', hasEvolutionKey: !!process.env.EVOLUTION_API_KEY,
    chatVisibility: 'private', retentionDays: null,
    autoNewLeadEnabled: false, autoNewLeadTemplate: DEFAULT_NEW_LEAD_TEMPLATE,
    autoInboundEnabled: false, autoInboundTemplate: DEFAULT_INBOUND_TEMPLATE,
    autoMinDelaySeconds: 20, autoMaxDelaySeconds: 60,
    autoDailyCap: 50, autoQuietFrom: 21, autoQuietTo: 9,
  };
  return {
    provider: r.provider_type,
    phoneNumberId: r.phone_number_id ?? '',
    displayPhone: r.display_phone ?? '',
    status: r.connection_status,
    hasToken: !!(r.access_token as string),
    evolutionUrl: r.evolution_url ?? '',
    chatVisibility: r.chat_visibility ?? 'private',
    retentionDays: r.retention_days ?? null,
    autoNewLeadEnabled: !!r.auto_new_lead_enabled,
    autoNewLeadTemplate: r.auto_new_lead_template ?? '',
    autoInboundEnabled: !!r.auto_inbound_enabled,
    autoInboundTemplate: r.auto_inbound_template ?? '',
    autoMinDelaySeconds: Number(r.auto_min_delay_seconds ?? 20),
    autoMaxDelaySeconds: Number(r.auto_max_delay_seconds ?? 60),
    autoDailyCap: Number(r.auto_daily_cap ?? 50),
    autoQuietFrom: Number(r.auto_quiet_from ?? 21),
    autoQuietTo: Number(r.auto_quiet_to ?? 9),
    hasEvolutionKey: !!(r.evolution_api_key as string) || !!process.env.EVOLUTION_API_KEY,
  };
}

/** Leads are often stored as bare 10-digit local numbers; WhatsApp JIDs need
 *  the country code. Default '91' (the product's market) — override with
 *  WHATSAPP_DEFAULT_CC. Longer numbers pass through untouched. */
function normalizePhone(raw: string): string {
  let d = String(raw).replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10) d = (process.env.WHATSAPP_DEFAULT_CC || '91') + d;
  return d;
}

function waLink(to: string, body?: string): string {
  const digits = String(to).replace(/\D/g, '');
  return `https://wa.me/${digits}${body ? `?text=${encodeURIComponent(body)}` : ''}`;
}

/** Per-user Evolution instance name: deterministic so reconnects reuse the
 *  same gateway session instead of orphaning one per attempt. */
function instanceNameFor(tenantId: string, userId: string): string {
  return `erp-${tenantId.replace(/-/g, '').slice(0, 10)}-${userId.replace(/-/g, '').slice(0, 10)}`;
}

const sessionToApi = (r: Record<string, unknown> | undefined) =>
  r
    ? { instanceName: r.instance_name, status: r.status, phone: r.phone, lastConnectedAt: r.last_connected_at }
    : { instanceName: '', status: 'disconnected', phone: '', lastConnectedAt: null };

/**
 * Extract a human-readable line from an Evolution message payload.
 *
 * We do NOT store the media itself (there is no blob store) — an attachment is
 * recorded as a descriptor so the timeline shows WHAT arrived and when. Before
 * this, a caption-less photo produced an empty string and the message was
 * dropped entirely, so a customer sending only a picture looked like silence.
 */
function messageText(msg: Record<string, unknown> | undefined): string {
  if (!msg) return '';
  const m = msg as {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: { caption?: string };
    videoMessage?: { caption?: string };
    documentMessage?: { caption?: string; fileName?: string };
    documentWithCaptionMessage?: { message?: { documentMessage?: { caption?: string; fileName?: string } } };
    audioMessage?: { ptt?: boolean };
    stickerMessage?: unknown;
    locationMessage?: { degreesLatitude?: number; degreesLongitude?: number };
    contactMessage?: { displayName?: string };
  };
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return m.imageMessage.caption ? `📷 ${m.imageMessage.caption}` : '📷 Photo';
  if (m.videoMessage) return m.videoMessage.caption ? `🎥 ${m.videoMessage.caption}` : '🎥 Video';
  const doc = m.documentMessage ?? m.documentWithCaptionMessage?.message?.documentMessage;
  if (doc) return `📄 ${doc.fileName || 'Document'}${doc.caption ? ` — ${doc.caption}` : ''}`;
  if (m.audioMessage) return m.audioMessage.ptt ? '🎙️ Voice message' : '🎵 Audio';
  if (m.stickerMessage) return '🌟 Sticker';
  if (m.locationMessage) return '📍 Location';
  if (m.contactMessage) return `👤 Contact${m.contactMessage.displayName ? `: ${m.contactMessage.displayName}` : ''}`;
  return '';
}

interface SaveBody { provider?: string; phoneNumberId?: string; accessToken?: string; displayPhone?: string; evolutionUrl?: string; evolutionApiKey?: string; chatVisibility?: string; retentionDays?: number | null; autoNewLeadEnabled?: boolean; autoNewLeadTemplate?: string; autoInboundEnabled?: boolean; autoInboundTemplate?: string; autoMinDelaySeconds?: number; autoMaxDelaySeconds?: number; autoDailyCap?: number; autoQuietFrom?: number; autoQuietTo?: number }
interface SendBody { to: string; body: string; leadId?: string }

/**
 * WhatsApp chat privacy (026). Each rep links their OWN phone, so their
 * conversations are personal correspondence — the workspace defaults to
 * 'private' and a rep sees only rows their own session carried
 * (lead_activities.user_id = them), even from colleagues in the same tenant.
 *
 * Returns the SQL fragment + params to append to a whatsapp query. Every read,
 * export and delete goes through this one helper so a new endpoint cannot
 * accidentally sidestep the boundary.
 */
async function chatScope(db: import('pg').PoolClient, userId: string | undefined) {
  const { rows } = await db.query(
    `SELECT chat_visibility, retention_days FROM whatsapp_instances WHERE tenant_id = app_current_tenant()`);
  const visibility = (rows[0]?.chat_visibility as string) ?? 'private';
  const retentionDays = (rows[0]?.retention_days as number | null) ?? null;
  return {
    visibility,
    retentionDays,
    /**
     * NULL when the workspace shares chats ('team'), else the caller's id.
     * Queries pair it with `($n::uuid IS NULL OR la.user_id = $n)` so one
     * statement serves both modes — no SQL splicing, no parameter drift.
     */
    ownerId: visibility === 'team' ? null : (userId ?? null),
  };
}

/**
 * Lazy retention sweep — this stack runs no scheduler, so the tenant's policy
 * is applied whenever their inbox is read. Bounded by a LIMIT so one very old
 * workspace can't stall a request; the next read continues the sweep.
 */
async function applyRetention(db: import('pg').PoolClient, retentionDays: number | null): Promise<number> {
  if (!retentionDays || retentionDays <= 0) return 0;
  const { rowCount } = await db.query(
    `DELETE FROM lead_activities
      WHERE ctid IN (
        SELECT ctid FROM lead_activities
         WHERE type = 'whatsapp' AND created_at < now() - ($1 || ' days')::interval
         LIMIT 500)`,
    [retentionDays]);
  return rowCount ?? 0;
}

export async function whatsappRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/whatsapp/instance — the tenant's WhatsApp config, secrets stripped. */
  app.get('/api/whatsapp/instance', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_messages') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_messages' });
      const { rows } = await db.query('SELECT * FROM whatsapp_instances WHERE tenant_id = app_current_tenant()');
      return { instance: toApiInstance(rows[0]) };
    }),
  );

  /**
   * PUT /api/whatsapp/instance — set the provider and its credentials.
   *  • meta_cloud_waba: WABA phone-number id + access token.
   *  • evolution: the self-hosted container URL + API key (either may be left
   *    blank to fall back to the platform's EVOLUTION_API_URL/KEY env).
   * Secrets are stored server-side only and never round-trip to the browser.
   */
  app.put<{ Body: SaveBody }>(
    '/api/whatsapp/instance',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', additionalProperties: false,
          properties: {
            provider: { type: 'string', enum: PROVIDERS as unknown as string[] },
            phoneNumberId: { type: 'string', maxLength: 64 },
            accessToken: { type: 'string', maxLength: 1000 },
            displayPhone: { type: 'string', maxLength: 32 },
            evolutionUrl: { type: 'string', maxLength: 300 },
            evolutionApiKey: { type: 'string', maxLength: 300 },
            chatVisibility: { type: 'string', enum: ['private', 'team'] },
            retentionDays: { type: ['integer', 'null'], minimum: 0, maximum: 3650 },
            autoNewLeadEnabled: { type: 'boolean' },
            autoNewLeadTemplate: { type: 'string', maxLength: 1000 },
            autoInboundEnabled: { type: 'boolean' },
            autoInboundTemplate: { type: 'string', maxLength: 1000 },
            autoMinDelaySeconds: { type: 'integer', minimum: 0, maximum: 3600 },
            autoMaxDelaySeconds: { type: 'integer', minimum: 0, maximum: 3600 },
            autoDailyCap: { type: 'integer', minimum: 0, maximum: 1000 },
            autoQuietFrom: { type: 'integer', minimum: 0, maximum: 23 },
            autoQuietTo: { type: 'integer', minimum: 0, maximum: 23 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_settings') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_settings' });

        const provider = req.body.provider ?? 'click_to_chat';
        const envGateway = !!(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY);
        const { rows } = await db.query(
          `INSERT INTO whatsapp_instances (tenant_id, provider_type, phone_number_id, display_phone, access_token, evolution_url, evolution_api_key, connection_status, chat_visibility, retention_days,
             auto_new_lead_enabled, auto_new_lead_template, auto_inbound_enabled, auto_inbound_template,
             auto_min_delay_seconds, auto_max_delay_seconds, auto_daily_cap, auto_quiet_from, auto_quiet_to)
           VALUES (app_current_tenant(), $1, COALESCE($2,''), COALESCE($3,''), COALESCE($4,''), COALESCE($5,''), COALESCE($6,''),
                   CASE
                     WHEN $1 = 'meta_cloud_waba' AND COALESCE($2,'') <> '' AND COALESCE($4,'') <> '' THEN 'connected'
                     WHEN $1 = 'evolution' AND ((COALESCE($5,'') <> '' AND COALESCE($6,'') <> '') OR $7) THEN 'connected'
                     ELSE 'disconnected' END,
                   COALESCE($8, 'private'),
                   CASE WHEN $9 THEN $10::int ELSE NULL END,
                   COALESCE($11,false), COALESCE(NULLIF($12,''), $20),
                   COALESCE($13,false), COALESCE(NULLIF($14,''), $21),
                   COALESCE($15,20), COALESCE($16,60), COALESCE($17,50), COALESCE($18,21), COALESCE($19,9))
           ON CONFLICT (tenant_id) DO UPDATE SET
             provider_type   = EXCLUDED.provider_type,
             phone_number_id = COALESCE(NULLIF($2,''), whatsapp_instances.phone_number_id),
             display_phone   = COALESCE(NULLIF($3,''), whatsapp_instances.display_phone),
             -- secrets: keep the stored value when the client sends none (they
             -- never round-trip), replace when a new one is supplied
             access_token      = COALESCE(NULLIF($4,''), whatsapp_instances.access_token),
             evolution_url     = COALESCE(NULLIF($5,''), whatsapp_instances.evolution_url),
             evolution_api_key = COALESCE(NULLIF($6,''), whatsapp_instances.evolution_api_key),
             chat_visibility = COALESCE($8, whatsapp_instances.chat_visibility),
             auto_new_lead_enabled  = COALESCE($11, whatsapp_instances.auto_new_lead_enabled),
             auto_new_lead_template = COALESCE(NULLIF($12,''), whatsapp_instances.auto_new_lead_template),
             auto_inbound_enabled   = COALESCE($13, whatsapp_instances.auto_inbound_enabled),
             auto_inbound_template  = COALESCE(NULLIF($14,''), whatsapp_instances.auto_inbound_template),
             auto_min_delay_seconds = COALESCE($15, whatsapp_instances.auto_min_delay_seconds),
             auto_max_delay_seconds = COALESCE($16, whatsapp_instances.auto_max_delay_seconds),
             auto_daily_cap         = COALESCE($17, whatsapp_instances.auto_daily_cap),
             auto_quiet_from        = COALESCE($18, whatsapp_instances.auto_quiet_from),
             auto_quiet_to          = COALESCE($19, whatsapp_instances.auto_quiet_to),
             retention_days  = CASE WHEN $9 THEN $10::int ELSE whatsapp_instances.retention_days END,
             connection_status = CASE
               WHEN EXCLUDED.provider_type = 'meta_cloud_waba'
                    AND COALESCE(NULLIF($2,''), whatsapp_instances.phone_number_id) <> ''
                    AND COALESCE(NULLIF($4,''), whatsapp_instances.access_token) <> ''
               THEN 'connected'
               WHEN EXCLUDED.provider_type = 'evolution'
                    AND ((COALESCE(NULLIF($5,''), whatsapp_instances.evolution_url) <> ''
                          AND COALESCE(NULLIF($6,''), whatsapp_instances.evolution_api_key) <> '') OR $7)
               THEN 'connected'
               ELSE 'disconnected' END,
             updated_at = now()
           RETURNING *`,
          [provider, req.body.phoneNumberId ?? null, req.body.displayPhone ?? null, req.body.accessToken ?? null,
           req.body.evolutionUrl ?? null, req.body.evolutionApiKey ?? null, envGateway,
           req.body.chatVisibility ?? null,
           // retentionDays supports an explicit null ("keep forever") — hence the sentinel
           'retentionDays' in req.body, req.body.retentionDays ?? null,
           req.body.autoNewLeadEnabled ?? null, req.body.autoNewLeadTemplate ?? null,
           req.body.autoInboundEnabled ?? null, req.body.autoInboundTemplate ?? null,
           req.body.autoMinDelaySeconds ?? null, req.body.autoMaxDelaySeconds ?? null,
           req.body.autoDailyCap ?? null, req.body.autoQuietFrom ?? null, req.body.autoQuietTo ?? null,
           DEFAULT_NEW_LEAD_TEMPLATE, DEFAULT_INBOUND_TEMPLATE],
        );
        return { instance: toApiInstance(rows[0]) };
      }),
  );

  // ── Per-rep Evolution sessions ──────────────────────────────────────────

  /** GET /api/whatsapp/session — the CALLER's own session. When the gateway is
   *  reachable the stored status is refreshed from the live connection state,
   *  so the profile chip never shows a stale "connecting". */
  app.get('/api/whatsapp/session', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('send_messages') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: send_messages' });
      const { rows } = await db.query('SELECT * FROM whatsapp_user_sessions WHERE user_id = $1', [req.ctx.userId]);
      let session = rows[0];
      if (session && session.status !== 'disconnected') {
        const gw = await resolveGateway(db);
        if (gw) {
          try {
            const live = await connectionStatus(gw, session.instance_name);
            if (live !== session.status) {
              const { rows: upd } = await db.query(
                `UPDATE whatsapp_user_sessions SET status = $1,
                   last_connected_at = CASE WHEN $1 = 'connected' THEN now() ELSE last_connected_at END,
                   updated_at = now()
                 WHERE id = $2 RETURNING *`, [live, session.id]);
              session = upd[0];
            }
          } catch { /* gateway briefly unreachable — serve the stored status */ }
        }
      }
      return { session: sessionToApi(session) };
    }),
  );

  /**
   * POST /api/whatsapp/connect — link (or re-link) the CALLER's WhatsApp.
   * Creates/reuses the per-user Evolution instance, registers the per-session
   * webhook, and returns a QR to scan. The instance is mapped to the logged-in
   * user id — the body cannot connect on someone else's behalf.
   */
  app.post('/api/whatsapp/connect', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('send_messages') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: send_messages' });

      const gw = await resolveGateway(db);
      if (!gw) return reply.code(503).send({ error: 'Evolution gateway is not configured — set the container URL and API key under Integrations → WhatsApp' });

      const name = instanceNameFor(req.ctx.tenantId, req.ctx.userId!);
      // Upsert the session row FIRST so the webhook token exists before the
      // gateway could possibly call back.
      const token = randomBytes(24).toString('hex');
      const { rows } = await db.query(
        `INSERT INTO whatsapp_user_sessions (tenant_id, user_id, instance_name, status, webhook_token)
         VALUES (app_current_tenant(), $1, $2, 'connecting', $3)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'connecting', updated_at = now()
         RETURNING *`,
        [req.ctx.userId, name, token]);
      const session = rows[0];

      const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
      const webhookUrl = `${publicUrl}/api/whatsapp/webhook/${session.webhook_token}`;
      try {
        await ensureInstance(gw, name, webhookUrl);
        const qr = await requestQr(gw, name);
        return { session: sessionToApi(session), qrcode: qr.qrcode, pairingCode: qr.pairingCode };
      } catch (err) {
        await db.query(`UPDATE whatsapp_user_sessions SET status = 'disconnected', updated_at = now() WHERE id = $1`, [session.id]);
        return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach the WhatsApp gateway' });
      }
    }),
  );

  /**
   * GET /api/whatsapp/conversations — the WhatsApp inbox: one row per lead
   * that has any WhatsApp history, newest activity first, with the last
   * message for the preview line.
   *
   * `awaitingReply` is true when the newest message came FROM the customer —
   * that is the "needs you" signal the inbox sorts and badges on, and it needs
   * no extra read-state table to maintain.
   *
   * Scoping: RLS pins the tenant. A sales executive additionally sees only
   * leads assigned to them (mirrors the Messages page's existing rule); anyone
   * with team-wide lead visibility sees the whole tenant inbox.
   */
  app.get('/api/whatsapp/conversations', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_messages') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_messages' });
      // manage_leads = team-wide lead ownership; a sales executive holds only
      // manage_own_leads, so their inbox is filtered to leads assigned to them.
      const { rows: [{ all_leads }] } = await db.query(
        `SELECT has_permission('manage_leads') OR has_permission('manage_team') AS all_leads`);

      // Chat privacy (026) is a SECOND, independent filter: even a manager who
      // can see every lead sees only their own conversations while the
      // workspace is 'private'.
      const scope = await chatScope(db, req.ctx.userId);
      await applyRetention(db, scope.retentionDays);
      // No scheduler in this stack — the inbox poll is what moves the queue.
      await drainOutbox(db).catch(() => { /* never block the inbox on a send */ });

      const { rows } = await db.query(
        `SELECT l.id AS lead_id, l.name, l.phone, l.project, l.stage, l.assigned_to,
                last.notes AS last_notes, last.created_at AS last_at, agg.n AS message_count
           FROM leads l
           JOIN LATERAL (
             SELECT la.notes, la.created_at FROM lead_activities la
              WHERE la.lead_id = l.id AND la.type = 'whatsapp'
                AND ($3::uuid IS NULL OR la.user_id = $3)
              ORDER BY la.created_at DESC LIMIT 1
           ) last ON true
           JOIN LATERAL (
             SELECT count(*)::int AS n FROM lead_activities la
              WHERE la.lead_id = l.id AND la.type = 'whatsapp'
                AND ($3::uuid IS NULL OR la.user_id = $3)
           ) agg ON true
          WHERE ($1::boolean OR l.assigned_to = $2::uuid)
          ORDER BY last.created_at DESC
          LIMIT 200`,
        [!!all_leads, req.ctx.userId || null, scope.ownerId]);

      return {
        conversations: rows.map(r => {
          const notes = String(r.last_notes ?? '');
          const m = notes.match(/^\[(sent via [^\]]+|sent from phone|received)\]\s?([\s\S]*)$/);
          return {
            leadId: r.lead_id, name: r.name, phone: r.phone, project: r.project, stage: r.stage,
            lastMessage: m ? m[2] : notes,
            lastAt: r.last_at,
            lastFromCustomer: m ? m[1] === 'received' : false,
            awaitingReply: m ? m[1] === 'received' : false,
            messageCount: r.message_count,
          };
        }),
      };
    }),
  );

  /**
   * GET /api/whatsapp/auto-reply/queue — what automation is about to do, and
   * what it recently did. Automated sending should never be invisible: the
   * whole point of the delay window is that a human can still intervene.
   * Draining here too means opening this page also moves the queue.
   */
  app.get('/api/whatsapp/auto-reply/queue', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_messages') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_messages' });
      await drainOutbox(db).catch(() => { /* reporting must not fail on a send */ });
      const { rows } = await db.query(
        `SELECT o.id, o.trigger, o.status, o.phone, o.body, o.send_after, o.sent_at, o.last_error,
                l.name AS lead_name
           FROM whatsapp_outbox o JOIN leads l ON l.id = o.lead_id
          ORDER BY (o.status = 'pending') DESC, COALESCE(o.sent_at, o.send_after) DESC
          LIMIT 50`);
      return {
        queue: rows.map(r => ({
          id: r.id, trigger: r.trigger, status: r.status, leadName: r.lead_name,
          phone: r.phone, body: r.body, sendAfter: r.send_after, sentAt: r.sent_at, error: r.last_error,
        })),
      };
    }),
  );

  /** DELETE /api/whatsapp/auto-reply/queue/:id — cancel a queued message
   *  before it goes out. The delay window exists so this is possible. */
  app.delete<{ Params: { id: string } }>(
    '/api/whatsapp/auto-reply/queue/:id',
    {
      preHandler: requireAuth,
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('send_messages') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: send_messages' });
        const { rowCount } = await db.query(
          `UPDATE whatsapp_outbox SET status='skipped', last_error='cancelled by a user'
            WHERE id=$1 AND status='pending'`, [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Nothing pending with that id — it may have already gone out' });
        return { cancelled: true };
      }),
  );

  // ── Data storage: usage, export, delete, retention ──────────────────────

  /** GET /api/whatsapp/storage/summary — what this caller actually holds. */
  app.get('/api/whatsapp/storage/summary', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_messages') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_messages' });
      const scope = await chatScope(db, req.ctx.userId);
      const { rows: [s] } = await db.query(
        `SELECT count(*)::int AS messages,
                count(DISTINCT lead_id)::int AS conversations,
                min(created_at) AS oldest,
                max(created_at) AS newest,
                COALESCE(sum(pg_column_size(notes)), 0)::bigint AS bytes
           FROM lead_activities la
          WHERE la.type = 'whatsapp' AND ($1::uuid IS NULL OR la.user_id = $1)`,
        [scope.ownerId]);
      const { rows: [{ can_manage }] } = await db.query(`SELECT has_permission('manage_settings') AS can_manage`);
      return {
        summary: {
          messages: s.messages, conversations: s.conversations,
          oldest: s.oldest, newest: s.newest, bytes: Number(s.bytes),
          visibility: scope.visibility, retentionDays: scope.retentionDays,
          canManage: !!can_manage,
        },
      };
    }),
  );

  /**
   * GET /api/whatsapp/storage/export — download the caller's own chat history
   * as CSV or JSON. Scoped identically to the inbox, so an export can never
   * become a privacy backdoor around chat_visibility.
   */
  app.get<{ Querystring: { format?: string; leadId?: string; from?: string; to?: string } }>(
    '/api/whatsapp/storage/export',
    {
      preHandler: requireAuth,
      schema: { querystring: { type: 'object', additionalProperties: false, properties: {
        format: { type: 'string', enum: ['csv', 'json'] },
        leadId: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_messages') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_messages' });
        const scope = await chatScope(db, req.ctx.userId);

        const { rows } = await db.query(
          `SELECT la.created_at, l.name AS lead_name, l.phone, la.notes, la.user_id
             FROM lead_activities la
             JOIN leads l ON l.id = la.lead_id
            WHERE la.type = 'whatsapp'
              AND ($1::uuid IS NULL OR la.user_id = $1)
              AND ($2::uuid IS NULL OR la.lead_id = $2)
              AND ($3::date IS NULL OR la.created_at >= $3::date)
              AND ($4::date IS NULL OR la.created_at < ($4::date + 1))
            ORDER BY l.name, la.created_at
            LIMIT 50000`,
          [scope.ownerId, req.query.leadId ?? null, req.query.from ?? null, req.query.to ?? null]);

        // Split the stored "[direction] text" note into columns the recipient
        // can actually filter on in a spreadsheet.
        const split = (notes: string) => {
          const m = String(notes).match(/^\[(sent via [^\]]+|sent from phone|received)\]\s?([\s\S]*)$/);
          return { direction: m ? (m[1] === 'received' ? 'received' : 'sent') : 'unknown', text: m ? m[2] : String(notes) };
        };
        const stamp = new Date().toISOString().slice(0, 10);

        if (req.query.format === 'json') {
          reply.header('Content-Type', 'application/json; charset=utf-8');
          reply.header('Content-Disposition', `attachment; filename="whatsapp-chats-${stamp}.json"`);
          return {
            exportedAt: new Date().toISOString(), scope: scope.visibility, messages: rows.length,
            chats: rows.map(r => ({ at: r.created_at, lead: r.lead_name, phone: r.phone, ...split(r.notes as string) })),
          };
        }

        // CSV: quote every field and double embedded quotes; prefix a cell that
        // starts with =,+,-,@ so a spreadsheet cannot execute it as a formula.
        const esc = (v: unknown) => {
          const s = String(v ?? '');
          const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
          return `"${safe.replace(/"/g, '""')}"`;
        };
        const lines = [['date', 'lead', 'phone', 'direction', 'message'].join(',')];
        for (const r of rows) {
          const { direction, text } = split(r.notes as string);
          lines.push([esc(r.created_at), esc(r.lead_name), esc(r.phone), esc(direction), esc(text)].join(','));
        }
        reply.header('Content-Type', 'text/csv; charset=utf-8');
        reply.header('Content-Disposition', `attachment; filename="whatsapp-chats-${stamp}.csv"`);
        // BOM so Excel reads the emoji/Devanagari as UTF-8 rather than mojibake.
        return '﻿' + lines.join('\r\n');
      }),
  );

  /**
   * DELETE /api/whatsapp/storage — erase chat history. HARD delete, no
   * soft-delete: the UI says so plainly. Only ever touches type='whatsapp'
   * rows inside the caller's own scope, and records the count in the audit log.
   */
  app.delete<{ Body: { leadId?: string; olderThanDays?: number } }>(
    '/api/whatsapp/storage',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', additionalProperties: false, properties: {
        leadId: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
        olderThanDays: { type: 'integer', minimum: 0, maximum: 3650 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_settings') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_settings' });
        if (!req.body.leadId && req.body.olderThanDays === undefined) {
          return reply.code(400).send({ error: 'Specify a conversation or an age in days — refusing to delete everything implicitly' });
        }
        const scope = await chatScope(db, req.ctx.userId);
        const { rowCount } = await db.query(
          `DELETE FROM lead_activities la
            WHERE la.type = 'whatsapp'
              AND ($1::uuid IS NULL OR la.user_id = $1)
              AND ($2::uuid IS NULL OR la.lead_id = $2)
              AND ($3::int IS NULL OR la.created_at < now() - ($3 || ' days')::interval)`,
          [scope.ownerId, req.body.leadId ?? null, req.body.olderThanDays ?? null]);

        await db.query(
          `INSERT INTO audit_logs (tenant_id, table_name, record_id, action, actor_id, new_state)
           VALUES (app_current_tenant(), 'lead_activities', $1, 'delete', $2, $3::jsonb)`,
          [req.body.leadId ?? null, req.ctx.userId || null,
           JSON.stringify({
             channel: 'whatsapp', deleted: rowCount ?? 0,
             leadId: req.body.leadId ?? null,
             olderThanDays: req.body.olderThanDays ?? null,
             scope: scope.visibility,
           })])
          .catch(() => { /* audit is best-effort; never block the erasure */ });

        return { deleted: rowCount ?? 0 };
      }),
  );

  /** POST /api/whatsapp/disconnect — unlink the CALLER's session. */
  app.post('/api/whatsapp/disconnect', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('send_messages') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: send_messages' });
      const { rows } = await db.query('SELECT * FROM whatsapp_user_sessions WHERE user_id = $1', [req.ctx.userId]);
      if (!rows[0]) return reply.code(404).send({ error: 'No WhatsApp session to disconnect' });
      const gw = await resolveGateway(db);
      if (gw) await logoutInstance(gw, rows[0].instance_name);
      const { rows: upd } = await db.query(
        `UPDATE whatsapp_user_sessions SET status = 'disconnected', updated_at = now() WHERE id = $1 RETURNING *`, [rows[0].id]);
      return { session: sessionToApi(upd[0]) };
    }),
  );

  /**
   * POST /api/whatsapp/send — the unified send. Provider resolution order:
   *  1. The CALLER's own connected Evolution session (per-rep number).
   *  2. The tenant's Meta Cloud WABA (shared official number).
   *  3. Click-to-chat link (free fallback — the agent sends manually).
   * Delivered sends are logged to lead_activities when the recipient matches a
   * lead (by leadId when given, else by phone), so the timeline stays complete.
   */
  app.post<{ Body: SendBody }>(
    '/api/whatsapp/send',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['to', 'body'], additionalProperties: false,
          properties: {
            to: { type: 'string', minLength: 3, maxLength: 32 },
            body: { type: 'string', minLength: 1, maxLength: 4096 },
            leadId: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('send_messages') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: send_messages' });
        const digits = normalizePhone(req.body.to);

        const logActivity = async (via: string) => {
          let leadId = req.body.leadId ?? null;
          if (!leadId) {
            const { rows: match } = await db.query(
              `SELECT id FROM leads WHERE RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = RIGHT($1, 10) LIMIT 1`, [digits]);
            leadId = match[0]?.id ?? null;
          }
          if (!leadId) return;
          await db.query(
            `INSERT INTO lead_activities (tenant_id, lead_id, user_id, type, notes)
             VALUES (app_current_tenant(), $1, $2, 'whatsapp', $3)`,
            [leadId, req.ctx.userId || null, `[sent via ${via}] ${req.body.body}`.slice(0, 2000)]);
        };

        // 1 — the caller's own Evolution session.
        const gw = await resolveGateway(db);
        if (gw) {
          const { rows: sess } = await db.query(
            `SELECT status FROM whatsapp_user_sessions WHERE user_id = $1`, [req.ctx.userId]);
          if (sess[0]?.status === 'connected') {
            try {
              const sent = await sendWhatsAppMessage(db, gw, req.ctx.userId!, digits, req.body.body);
              await logActivity('my WhatsApp');
              return { delivered: true, provider: 'evolution', messageId: sent.messageId };
            } catch (err) {
              return reply.code(502).send({ error: err instanceof Error ? err.message : 'WhatsApp gateway error', fallbackLink: waLink(digits, req.body.body) });
            }
          }
        }

        const { rows } = await db.query('SELECT * FROM whatsapp_instances WHERE tenant_id = app_current_tenant()');
        const inst = rows[0];

        // 3 — free / not-configured path.
        if (!inst || inst.provider_type === 'click_to_chat' || (inst.provider_type === 'meta_cloud_waba' && (!inst.access_token || !inst.phone_number_id)) || inst.provider_type === 'evolution') {
          return { delivered: false, provider: 'click_to_chat', link: waLink(digits, req.body.body) };
        }

        // 2 — the tenant's official Meta Cloud number.
        try {
          const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${inst.phone_number_id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${inst.access_token}` },
            body: JSON.stringify({ messaging_product: 'whatsapp', to: digits, type: 'text', text: { preview_url: false, body: req.body.body } }),
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            const detail = (payload as { error?: { message?: string } })?.error?.message || `Meta API error ${res.status}`;
            return reply.code(502).send({ error: `WhatsApp API rejected the message: ${detail}`, fallbackLink: waLink(digits, req.body.body) });
          }
          const messageId = (payload as { messages?: { id?: string }[] })?.messages?.[0]?.id;
          await logActivity('Business API');
          return { delivered: true, provider: 'meta_cloud_waba', messageId };
        } catch (err) {
          return reply.code(502).send({ error: err instanceof Error ? err.message : 'WhatsApp API unreachable', fallbackLink: waLink(digits, req.body.body) });
        }
      }),
  );

  /**
   * POST /api/whatsapp/send-media — send an attachment from the rep's own
   * number. Evolution-only: the click-to-chat link cannot carry a file, and
   * the Meta path needs a hosted media id, so this fails loudly rather than
   * pretending. The file rides as base64 (10 MB cap; the route's bodyLimit is
   * raised to cover base64's ~33% inflation).
   *
   * The file itself is NOT stored — the ERP has no blob store — so the
   * timeline records a descriptor ("📄 floorplan.pdf"), the same shape the
   * webhook writes for inbound attachments.
   */
  app.post<{ Body: { to: string; leadId?: string; mediatype: string; mimetype: string; fileName?: string; caption?: string; base64: string } }>(
    '/api/whatsapp/send-media',
    {
      preHandler: requireAuth,
      bodyLimit: 15 * 1024 * 1024,
      schema: {
        body: {
          type: 'object', required: ['to', 'mediatype', 'mimetype', 'base64'], additionalProperties: false,
          properties: {
            to: { type: 'string', minLength: 3, maxLength: 32 },
            leadId: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
            mediatype: { type: 'string', enum: ['image', 'document', 'video', 'audio'] },
            mimetype: { type: 'string', maxLength: 128 },
            fileName: { type: 'string', maxLength: 200 },
            caption: { type: 'string', maxLength: 1024 },
            base64: { type: 'string', minLength: 8, maxLength: 14 * 1024 * 1024 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('send_messages') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: send_messages' });

        const gw = await resolveGateway(db);
        if (!gw) return reply.code(503).send({ error: 'Attachments need your own linked WhatsApp — the gateway is not configured' });

        const digits = normalizePhone(req.body.to);
        try {
          const sent = await sendWhatsAppMedia(db, gw, req.ctx.userId!, digits, {
            mediatype: req.body.mediatype as MediaKind,
            mimetype: req.body.mimetype,
            fileName: req.body.fileName,
            caption: req.body.caption,
            base64: req.body.base64,
          });

          const icon = req.body.mediatype === 'image' ? '📷'
            : req.body.mediatype === 'video' ? '🎥'
            : req.body.mediatype === 'audio' ? '🎵' : '📄';
          const label = req.body.fileName || (req.body.mediatype === 'image' ? 'Photo' : 'File');
          const descriptor = `${icon} ${label}${req.body.caption ? ` — ${req.body.caption}` : ''}`;

          let leadId = req.body.leadId ?? null;
          if (!leadId) {
            const { rows: match } = await db.query(
              `SELECT id FROM leads WHERE RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = RIGHT($1, 10) LIMIT 1`, [digits]);
            leadId = match[0]?.id ?? null;
          }
          if (leadId) {
            await db.query(
              `INSERT INTO lead_activities (tenant_id, lead_id, user_id, type, notes)
               VALUES (app_current_tenant(), $1, $2, 'whatsapp', $3)`,
              [leadId, req.ctx.userId || null, `[sent via my WhatsApp] ${descriptor}`.slice(0, 2000)]);
          }
          return { delivered: true, provider: 'evolution', messageId: sent.messageId, descriptor };
        } catch (err) {
          return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not send the attachment' });
        }
      }),
  );

  /**
   * POST /api/whatsapp/webhook/:token — inbound events from the Evolution
   * container. PUBLIC by necessity; authenticated by the per-session token in
   * the URL (unguessable, unique, revoked with the session row). The token
   * resolves which tenant + rep the event belongs to via the platform pool —
   * exactly the portal-login pattern.
   *
   * Handled events:
   *  • connection.update — keeps the session status live (QR scanned on the
   *    phone → 'open' arrives here → the profile chip flips to Connected).
   *  • messages.upsert — matches the counterpart number to a lead and logs the
   *    message into lead_activities (inbound AND the rep's replies typed on
   *    their phone, so the timeline is complete either way).
   * Always 200 on handled tokens: a webhook retry storm must never build.
   */
  app.post<{ Params: { token: string }; Body: Record<string, unknown> }>(
    '/api/whatsapp/webhook/:token',
    {
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
      schema: { params: { type: 'object', required: ['token'], properties: { token: { type: 'string', minLength: 16, maxLength: 96 } } } },
    },
    async (req, reply) => {
      const { rows } = await platformPool.query(
        'SELECT * FROM whatsapp_user_sessions WHERE webhook_token = $1', [req.params.token]);
      const session = rows[0];
      if (!session) return reply.code(401).send({ error: 'Unknown webhook token' });

      const event = String((req.body as { event?: string }).event ?? '').toLowerCase().replace(/_/g, '.');
      const data = ((req.body as { data?: unknown }).data ?? {}) as Record<string, unknown>;
      const ctx = { tenantId: session.tenant_id as string, userId: session.user_id as string, ip: req.ip };

      if (event === 'connection.update') {
        const state = String((data.state ?? data.status ?? '')).toLowerCase();
        const status = state === 'open' ? 'connected' : state === 'connecting' ? 'connecting' : 'disconnected';
        await withTenantContext(ctx, async (db) => {
          await db.query(
            `UPDATE whatsapp_user_sessions SET status = $1,
               phone = COALESCE(NULLIF($2,''), phone),
               last_connected_at = CASE WHEN $1 = 'connected' THEN now() ELSE last_connected_at END,
               updated_at = now()
             WHERE id = $3`,
            [status, String(data.wuid ?? '').replace(/\D/g, ''), session.id]);
        });
        return { ok: true };
      }

      if (event === 'messages.upsert') {
        // Evolution sends either the message object directly or {messages:[…]}.
        const messages = Array.isArray(data.messages) ? data.messages as Record<string, unknown>[] : [data];
        await withTenantContext(ctx, async (db) => {
          for (const m of messages) {
            const key = (m.key ?? {}) as { remoteJid?: string; fromMe?: boolean };
            const text = messageText(m.message as Record<string, unknown>);
            const jid = String(key.remoteJid ?? '');
            if (!text || !jid || jid.endsWith('@g.us')) continue;   // skip empty + group chats
            const digits = jid.replace(/@.*$/, '').replace(/\D/g, '');
            const { rows: match } = await db.query(
              `SELECT id FROM leads WHERE RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = RIGHT($1, 10) LIMIT 1`, [digits]);
            if (!match[0]) continue;   // not a known lead — nothing to log
            const direction = key.fromMe ? 'sent from phone' : 'received';
            await db.query(
              `INSERT INTO lead_activities (tenant_id, lead_id, user_id, type, notes)
               VALUES (app_current_tenant(), $1, $2, 'whatsapp', $3)`,
              [match[0].id, session.user_id, `[${direction}] ${text}`.slice(0, 2000)]);
            // Only acknowledge messages the CUSTOMER sent — never our own.
            if (!key.fromMe) {
              await enqueueAutoReply(db, { leadId: match[0].id, trigger: 'inbound', phone: digits })
                .catch(() => { /* the webhook must always 200 */ });
            }
          }
        });
        return { ok: true };
      }

      return { ok: true };   // qrcode.updated etc. — acknowledged, nothing to do
    },
  );
}
