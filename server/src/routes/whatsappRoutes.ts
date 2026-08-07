import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

const PROVIDERS = ['click_to_chat', 'meta_cloud_waba'] as const;
const GRAPH_VERSION = 'v21.0';

/** DB row → the SPA-safe view. The access token is NEVER included — the client
 *  only learns WHETHER one is set (hasToken). */
function toApiInstance(r: Record<string, unknown> | undefined) {
  if (!r) return { provider: 'click_to_chat', phoneNumberId: '', displayPhone: '', status: 'disconnected', hasToken: false };
  return {
    provider: r.provider_type,
    phoneNumberId: r.phone_number_id ?? '',
    displayPhone: r.display_phone ?? '',
    status: r.connection_status,
    hasToken: !!(r.access_token as string),
  };
}

function waLink(to: string, body?: string): string {
  const digits = String(to).replace(/\D/g, '');
  return `https://wa.me/${digits}${body ? `?text=${encodeURIComponent(body)}` : ''}`;
}

interface SaveBody { provider?: string; phoneNumberId?: string; accessToken?: string; displayPhone?: string; }
interface SendBody { to: string; body: string; }

export async function whatsappRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/whatsapp/instance — the tenant's WhatsApp config, token stripped. */
  app.get('/api/whatsapp/instance', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_messages') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_messages' });
      const { rows } = await db.query('SELECT * FROM whatsapp_instances WHERE tenant_id = app_current_tenant()');
      return { instance: toApiInstance(rows[0]) };
    }),
  );

  /**
   * PUT /api/whatsapp/instance — set the provider and (for the paid path) the
   * Meta WABA phone-number id + access token. The token is stored server-side
   * only. Switching to click_to_chat leaves any stored token untouched but marks
   * the channel disconnected, so a tenant can toggle back to the API cheaply.
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
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_settings') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_settings' });

        const provider = req.body.provider ?? 'click_to_chat';
        // A meta channel is "connected" only when it has both a sender id AND a
        // token; anything else is disconnected (so the adapter falls back to free).
        const { rows } = await db.query(
          `INSERT INTO whatsapp_instances (tenant_id, provider_type, phone_number_id, display_phone, access_token, connection_status)
           VALUES (app_current_tenant(), $1, COALESCE($2,''), COALESCE($3,''), COALESCE($4,''),
                   CASE WHEN $1 = 'meta_cloud_waba' AND COALESCE($2,'') <> '' AND COALESCE($4,'') <> '' THEN 'connected' ELSE 'disconnected' END)
           ON CONFLICT (tenant_id) DO UPDATE SET
             provider_type   = EXCLUDED.provider_type,
             phone_number_id = COALESCE(NULLIF($2,''), whatsapp_instances.phone_number_id),
             display_phone   = COALESCE(NULLIF($3,''), whatsapp_instances.display_phone),
             -- keep the existing token when the client sends none (it never
             -- round-trips the secret), replace it when a new one is supplied
             access_token    = COALESCE(NULLIF($4,''), whatsapp_instances.access_token),
             connection_status = CASE
               WHEN EXCLUDED.provider_type = 'meta_cloud_waba'
                    AND COALESCE(NULLIF($2,''), whatsapp_instances.phone_number_id) <> ''
                    AND COALESCE(NULLIF($4,''), whatsapp_instances.access_token) <> ''
               THEN 'connected' ELSE 'disconnected' END,
             updated_at = now()
           RETURNING *`,
          [provider, req.body.phoneNumberId ?? null, req.body.displayPhone ?? null, req.body.accessToken ?? null],
        );
        return { instance: toApiInstance(rows[0]) };
      }),
  );

  /**
   * POST /api/whatsapp/send — the unified send. Resolves the tenant's provider:
   *  • meta_cloud_waba (with a token) → dispatches through the Meta Cloud API and
   *    reports delivered=true. The token stays here; the browser never sees it.
   *  • otherwise → returns delivered=false + a click-to-chat link for the agent
   *    to open and send from their own WhatsApp (the free path).
   */
  app.post<{ Body: SendBody }>(
    '/api/whatsapp/send',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['to', 'body'], additionalProperties: false,
          properties: { to: { type: 'string', minLength: 3, maxLength: 32 }, body: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('send_messages') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: send_messages' });
        const { rows } = await db.query('SELECT * FROM whatsapp_instances WHERE tenant_id = app_current_tenant()');
        const inst = rows[0];
        const digits = req.body.to.replace(/\D/g, '');

        // Free / not-configured path — hand back a link for the agent to open.
        if (!inst || inst.provider_type !== 'meta_cloud_waba' || !inst.access_token || !inst.phone_number_id) {
          return { delivered: false, provider: 'click_to_chat', link: waLink(digits, req.body.body) };
        }

        // Paid path — dispatch through the official Meta Cloud API.
        try {
          const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${inst.phone_number_id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${inst.access_token}` },
            body: JSON.stringify({ messaging_product: 'whatsapp', to: digits, type: 'text', text: { preview_url: false, body: req.body.body } }),
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            // Surface Meta's error (bad token, unverified number, 24h window, …)
            // without leaking internals; the caller can fall back to the link.
            const detail = (payload as { error?: { message?: string } })?.error?.message || `Meta API error ${res.status}`;
            return reply.code(502).send({ error: `WhatsApp API rejected the message: ${detail}`, fallbackLink: waLink(digits, req.body.body) });
          }
          const messageId = (payload as { messages?: { id?: string }[] })?.messages?.[0]?.id;
          return { delivered: true, provider: 'meta_cloud_waba', messageId };
        } catch (err) {
          return reply.code(502).send({ error: err instanceof Error ? err.message : 'WhatsApp API unreachable', fallbackLink: waLink(digits, req.body.body) });
        }
      }),
  );
}
