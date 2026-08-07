import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { withTenantContext, platformPool } from '../db.js';
import { requireAuth } from '../auth.js';
import { resolveGateway, ensureInstance, requestQr, connectionStatus, logoutInstance, sendWhatsAppMessage } from '../evolution.js';

const PROVIDERS = ['click_to_chat', 'meta_cloud_waba', 'evolution'] as const;
const GRAPH_VERSION = 'v21.0';

/** DB row → the SPA-safe view. Secrets (Meta token, Evolution key) are NEVER
 *  included — the client only learns WHETHER each is set. */
function toApiInstance(r: Record<string, unknown> | undefined) {
  if (!r) return { provider: 'click_to_chat', phoneNumberId: '', displayPhone: '', status: 'disconnected', hasToken: false, evolutionUrl: '', hasEvolutionKey: false };
  return {
    provider: r.provider_type,
    phoneNumberId: r.phone_number_id ?? '',
    displayPhone: r.display_phone ?? '',
    status: r.connection_status,
    hasToken: !!(r.access_token as string),
    evolutionUrl: r.evolution_url ?? '',
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

/** Extract the human text out of an Evolution message payload. */
function messageText(msg: Record<string, unknown> | undefined): string {
  if (!msg) return '';
  const m = msg as { conversation?: string; extendedTextMessage?: { text?: string }; imageMessage?: { caption?: string }; documentMessage?: { caption?: string } };
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.documentMessage?.caption || '';
}

interface SaveBody { provider?: string; phoneNumberId?: string; accessToken?: string; displayPhone?: string; evolutionUrl?: string; evolutionApiKey?: string }
interface SendBody { to: string; body: string; leadId?: string }

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
          `INSERT INTO whatsapp_instances (tenant_id, provider_type, phone_number_id, display_phone, access_token, evolution_url, evolution_api_key, connection_status)
           VALUES (app_current_tenant(), $1, COALESCE($2,''), COALESCE($3,''), COALESCE($4,''), COALESCE($5,''), COALESCE($6,''),
                   CASE
                     WHEN $1 = 'meta_cloud_waba' AND COALESCE($2,'') <> '' AND COALESCE($4,'') <> '' THEN 'connected'
                     WHEN $1 = 'evolution' AND ((COALESCE($5,'') <> '' AND COALESCE($6,'') <> '') OR $7) THEN 'connected'
                     ELSE 'disconnected' END)
           ON CONFLICT (tenant_id) DO UPDATE SET
             provider_type   = EXCLUDED.provider_type,
             phone_number_id = COALESCE(NULLIF($2,''), whatsapp_instances.phone_number_id),
             display_phone   = COALESCE(NULLIF($3,''), whatsapp_instances.display_phone),
             -- secrets: keep the stored value when the client sends none (they
             -- never round-trip), replace when a new one is supplied
             access_token      = COALESCE(NULLIF($4,''), whatsapp_instances.access_token),
             evolution_url     = COALESCE(NULLIF($5,''), whatsapp_instances.evolution_url),
             evolution_api_key = COALESCE(NULLIF($6,''), whatsapp_instances.evolution_api_key),
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
           req.body.evolutionUrl ?? null, req.body.evolutionApiKey ?? null, envGateway],
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
          }
        });
        return { ok: true };
      }

      return { ok: true };   // qrcode.updated etc. — acknowledged, nothing to do
    },
  );
}
