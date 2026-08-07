import type { PoolClient } from 'pg';

/**
 * Thin client for a self-hosted Evolution API container (the open-source
 * WhatsApp gateway). One container serves the whole platform by default
 * (EVOLUTION_API_URL / EVOLUTION_API_KEY env), and any tenant can point at
 * their own container via the evolution_url / evolution_api_key columns on
 * their whatsapp_instances row — the tenant row wins when set.
 *
 * Every function takes the resolved gateway explicitly so the routes decide
 * the tenant context exactly once. Errors are normalized to Error with a
 * human message; callers translate to 502/503.
 */

export interface Gateway { url: string; apiKey: string }

/** Tenant override first, platform env second, null when neither is set
 *  (the feature is then cleanly unavailable, not half-configured). */
export async function resolveGateway(db: PoolClient): Promise<Gateway | null> {
  const { rows } = await db.query(
    `SELECT evolution_url, evolution_api_key FROM whatsapp_instances WHERE tenant_id = app_current_tenant()`);
  const url = (rows[0]?.evolution_url as string) || process.env.EVOLUTION_API_URL || '';
  const apiKey = (rows[0]?.evolution_api_key as string) || process.env.EVOLUTION_API_KEY || '';
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/+$/, ''), apiKey };
}

async function evoFetch(gw: Gateway, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(gw.url + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', apikey: gw.apiKey, ...(init?.headers ?? {}) },
    });
  } catch {
    throw new Error('WhatsApp gateway unreachable — check the Evolution API URL');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (body as { response?: { message?: unknown }; message?: unknown }).response?.message
      ?? (body as { message?: unknown }).message ?? `HTTP ${res.status}`;
    const err = new Error(`Evolution API: ${Array.isArray(detail) ? detail.join('; ') : String(detail)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return body as Record<string, unknown>;
}

/** Create the instance if the container doesn't have it yet. Registering the
 *  per-session webhook at create time means not a single inbound message can
 *  arrive unrouted. Idempotent: "already in use" is success. */
export async function ensureInstance(gw: Gateway, name: string, webhookUrl: string): Promise<void> {
  try {
    await evoFetch(gw, '/instance/create', {
      method: 'POST',
      body: JSON.stringify({
        instanceName: name,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
        webhook: { url: webhookUrl, byEvents: false, base64: false,
          events: ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT'] },
      }),
    });
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    // 403 "name already in use" — the instance exists from a prior connect.
    if (status !== 403 && status !== 409) throw err;
    // Re-point the webhook in case PUBLIC_URL changed since it was created.
    await evoFetch(gw, `/webhook/set/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify({ webhook: { enabled: true, url: webhookUrl, byEvents: false, base64: false,
        events: ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT'] } }),
    }).catch(() => { /* older Evolution versions keep the create-time webhook */ });
  }
}

export interface QrResult { qrcode: string; pairingCode: string }

/** Ask the gateway for a fresh QR (and pairing code when it offers one). */
export async function requestQr(gw: Gateway, name: string): Promise<QrResult> {
  const body = await evoFetch(gw, `/instance/connect/${encodeURIComponent(name)}`);
  const base64 = (body.base64 as string) || ((body.qrcode as Record<string, unknown>)?.base64 as string) || '';
  const pairingCode = (body.pairingCode as string) || ((body.qrcode as Record<string, unknown>)?.pairingCode as string) || '';
  return { qrcode: base64, pairingCode };
}

/** Gateway connection state → our session status vocabulary. */
export async function connectionStatus(gw: Gateway, name: string): Promise<'connected' | 'connecting' | 'disconnected'> {
  const body = await evoFetch(gw, `/instance/connectionState/${encodeURIComponent(name)}`);
  const state = String(((body.instance as Record<string, unknown>)?.state ?? body.state ?? '')).toLowerCase();
  if (state === 'open') return 'connected';
  if (state === 'connecting') return 'connecting';
  return 'disconnected';
}

export async function logoutInstance(gw: Gateway, name: string): Promise<void> {
  await evoFetch(gw, `/instance/logout/${encodeURIComponent(name)}`, { method: 'DELETE' })
    .catch(() => { /* already logged out / never connected — same end state */ });
}

/**
 * The dispatch primitive the spec calls sendWhatsAppMessage(userId, phone,
 * message): sends through the given USER's own session instance. The caller
 * provides the tenant-scoped db client; this resolves the session, refuses
 * when the rep has no connected session, and returns the gateway message id.
 * Used by the /send route today and by any future drip runner ("Call Silent"
 * etc.) — automation goes out from the assigned rep's number, not a shared one.
 */
export async function sendWhatsAppMessage(
  db: PoolClient, gw: Gateway, userId: string, phone: string, message: string,
): Promise<{ messageId: string; instanceName: string }> {
  const session = await requireConnectedSession(db, userId);
  const digits = String(phone).replace(/\D/g, '');
  const body = await evoFetch(gw, `/message/sendText/${encodeURIComponent(session)}`, {
    method: 'POST',
    body: JSON.stringify({ number: digits, text: message }),
  });
  const messageId = String(((body.key as Record<string, unknown>)?.id ?? body.messageId ?? ''));
  return { messageId, instanceName: session };
}

/** Shared precondition: the rep must have a session, and it must be live. */
async function requireConnectedSession(db: PoolClient, userId: string): Promise<string> {
  const { rows } = await db.query(
    `SELECT instance_name, status FROM whatsapp_user_sessions WHERE user_id = $1`, [userId]);
  const session = rows[0];
  if (!session) throw new Error('This user has not linked a WhatsApp session');
  if (session.status !== 'connected') throw new Error('This user\'s WhatsApp session is not connected — scan the QR first');
  return session.instance_name as string;
}

export type MediaKind = 'image' | 'document' | 'video' | 'audio';

/**
 * Send an attachment through the rep's own session. `base64` is the raw file
 * payload WITHOUT a data: prefix — the gateway rejects the prefixed form.
 */
export async function sendWhatsAppMedia(
  db: PoolClient, gw: Gateway, userId: string, phone: string,
  file: { mediatype: MediaKind; mimetype: string; fileName?: string; caption?: string; base64: string },
): Promise<{ messageId: string; instanceName: string }> {
  const session = await requireConnectedSession(db, userId);
  const digits = String(phone).replace(/\D/g, '');
  const body = await evoFetch(gw, `/message/sendMedia/${encodeURIComponent(session)}`, {
    method: 'POST',
    body: JSON.stringify({
      number: digits,
      mediatype: file.mediatype,
      mimetype: file.mimetype,
      caption: file.caption || undefined,
      fileName: file.fileName || undefined,
      media: file.base64.replace(/^data:[^;]+;base64,/, ''),
    }),
  });
  const messageId = String(((body.key as Record<string, unknown>)?.id ?? body.messageId ?? ''));
  return { messageId, instanceName: session };
}
