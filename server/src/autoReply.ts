import type { PoolClient } from 'pg';
import { resolveGateway, sendWhatsAppMessage } from './evolution.js';

/**
 * WhatsApp auto-reply (027).
 *
 * Two triggers with deliberately different defaults, because their risk is
 * different:
 *
 *   • 'inbound'  — acknowledge a customer who messaged US. A reply inside a
 *     conversation the customer opened; low risk.
 *   • 'new_lead' — greet a lead the moment it arrives from any source. This is
 *     an OUTBOUND first contact to someone who has not messaged us, which is
 *     the pattern that actually attracts blocks. Off by default, and even when
 *     enabled it is paced, capped, and silenced during quiet hours.
 *
 * Nothing sends inline. Everything is queued with a randomised `send_after`,
 * so the human-like delay survives a restart and a lead insert never blocks on
 * a gateway round trip.
 */

export type AutoTrigger = 'new_lead' | 'inbound';

interface AutoConfig {
  newLeadEnabled: boolean; newLeadTemplate: string;
  inboundEnabled: boolean; inboundTemplate: string;
  minDelay: number; maxDelay: number;
  dailyCap: number; quietFrom: number; quietTo: number;
}

async function loadConfig(db: PoolClient): Promise<AutoConfig | null> {
  const { rows } = await db.query(
    `SELECT auto_new_lead_enabled, auto_new_lead_template, auto_inbound_enabled, auto_inbound_template,
            auto_min_delay_seconds, auto_max_delay_seconds, auto_daily_cap, auto_quiet_from, auto_quiet_to
       FROM whatsapp_instances WHERE tenant_id = app_current_tenant()`);
  const r = rows[0];
  if (!r) return null;
  return {
    newLeadEnabled: !!r.auto_new_lead_enabled, newLeadTemplate: String(r.auto_new_lead_template ?? ''),
    inboundEnabled: !!r.auto_inbound_enabled, inboundTemplate: String(r.auto_inbound_template ?? ''),
    minDelay: Number(r.auto_min_delay_seconds ?? 20), maxDelay: Number(r.auto_max_delay_seconds ?? 60),
    dailyCap: Number(r.auto_daily_cap ?? 50),
    quietFrom: Number(r.auto_quiet_from ?? 21), quietTo: Number(r.auto_quiet_to ?? 9),
  };
}

/** {{name}} / {{agent}} / {{company}} / {{project}} — anything else is left as-is. */
function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
}

/** Quiet hours wrap midnight (e.g. 21 → 9), so the test is a range OR its complement. */
function inQuietHours(hour: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** Next moment outside quiet hours, given "now". */
function nextAllowed(now: Date, from: number, to: number): Date {
  const d = new Date(now);
  let guard = 0;
  while (inQuietHours(d.getHours(), from, to) && guard++ < 48) {
    d.setHours(d.getHours() + 1, 0, 0, 0);
  }
  return d;
}

/**
 * Queue an automated message. Silently does nothing when the trigger is
 * disabled, the lead has no phone, or one was already queued for this
 * (lead, trigger) — the UNIQUE constraint is the anti-spam guarantee, so a
 * re-imported lead is never greeted twice.
 */
export async function enqueueAutoReply(
  db: PoolClient,
  opts: { leadId: string; trigger: AutoTrigger; phone: string; leadName?: string; project?: string; userId?: string | null },
): Promise<'queued' | 'disabled' | 'duplicate' | 'no_phone'> {
  const cfg = await loadConfig(db);
  if (!cfg) return 'disabled';
  const enabled = opts.trigger === 'new_lead' ? cfg.newLeadEnabled : cfg.inboundEnabled;
  if (!enabled) return 'disabled';

  const digits = String(opts.phone ?? '').replace(/\D/g, '');
  if (digits.length < 8) return 'no_phone';

  // Who sends it: the lead's owner when they have a live session, else any
  // connected rep in the tenant. Without a session there is nothing to send from.
  const { rows: sender } = await db.query(
    `SELECT w.user_id FROM whatsapp_user_sessions w
      WHERE w.status = 'connected'
      ORDER BY (w.user_id = (SELECT assigned_to FROM leads WHERE id = $1)) DESC, w.last_connected_at DESC
      LIMIT 1`, [opts.leadId]);
  const userId = sender[0]?.user_id ?? null;
  if (!userId) return 'disabled';

  const { rows: meta } = await db.query(
    `SELECT l.name, l.project, COALESCE(u.name, '') AS agent, t.name AS company
       FROM leads l
       LEFT JOIN users u ON u.id = $2
       CROSS JOIN tenants t
      WHERE l.id = $1 AND t.id = app_current_tenant()`, [opts.leadId, userId]);
  const m = meta[0] ?? {};
  const body = render(
    opts.trigger === 'new_lead' ? cfg.newLeadTemplate : cfg.inboundTemplate,
    {
      name: String(opts.leadName ?? m.name ?? 'there').split(' ')[0],
      agent: String(m.agent ?? 'your advisor'),
      company: String(m.company ?? 'our team'),
      project: String(opts.project ?? m.project ?? ''),
    },
  );

  // Randomised human-like delay, pushed past quiet hours if needed.
  const spread = Math.max(0, cfg.maxDelay - cfg.minDelay);
  const delay = cfg.minDelay + Math.floor(Math.random() * (spread + 1));
  const sendAfter = nextAllowed(new Date(Date.now() + delay * 1000), cfg.quietFrom, cfg.quietTo);

  const { rowCount } = await db.query(
    `INSERT INTO whatsapp_outbox (tenant_id, lead_id, user_id, trigger, phone, body, send_after)
     VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, lead_id, trigger) DO NOTHING`,
    [opts.leadId, userId, opts.trigger, digits, body, sendAfter]);

  return rowCount ? 'queued' : 'duplicate';
}

/**
 * Send whatever is due. There is no scheduler in this stack, so this is called
 * opportunistically (the inbox poll, and an explicit endpoint). Bounded per
 * call, and it sends ONE message per invocation per sender so automated
 * traffic stays paced rather than bursting the moment someone opens the app.
 */
export async function drainOutbox(db: PoolClient, limit = 5): Promise<{ sent: number; failed: number; skipped: number }> {
  const cfg = await loadConfig(db);
  if (!cfg) return { sent: 0, failed: 0, skipped: 0 };

  const gw = await resolveGateway(db);
  if (!gw) return { sent: 0, failed: 0, skipped: 0 };

  const { rows: due } = await db.query(
    `SELECT * FROM whatsapp_outbox
      WHERE status = 'pending' AND send_after <= now()
      ORDER BY send_after
      LIMIT $1`, [limit]);

  let sent = 0, failed = 0, skipped = 0;
  for (const row of due) {
    // Daily cap is per sender, counted from what actually went out.
    const { rows: [{ n }] } = await db.query(
      `SELECT count(*)::int AS n FROM whatsapp_outbox
        WHERE user_id = $1 AND status = 'sent' AND sent_at > now() - interval '1 day'`, [row.user_id]);
    if (cfg.dailyCap > 0 && n >= cfg.dailyCap) {
      await db.query(
        `UPDATE whatsapp_outbox SET status='skipped', last_error='daily cap reached' WHERE id=$1`, [row.id]);
      skipped++;
      continue;
    }
    // A rep who has since replied by hand makes the canned message redundant.
    const { rows: [{ replied }] } = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM lead_activities
          WHERE lead_id = $1 AND type = 'whatsapp'
            AND notes LIKE '[sent%' AND created_at > $2) AS replied`,
      [row.lead_id, row.created_at]);
    if (replied) {
      await db.query(
        `UPDATE whatsapp_outbox SET status='skipped', last_error='a human replied first' WHERE id=$1`, [row.id]);
      skipped++;
      continue;
    }

    try {
      await sendWhatsAppMessage(db, gw, row.user_id, row.phone, row.body);
      await db.query(`UPDATE whatsapp_outbox SET status='sent', sent_at=now() WHERE id=$1`, [row.id]);
      await db.query(
        `INSERT INTO lead_activities (tenant_id, lead_id, user_id, type, notes)
         VALUES (app_current_tenant(), $1, $2, 'whatsapp', $3)`,
        [row.lead_id, row.user_id, `[sent via my WhatsApp] ${row.body}`.slice(0, 2000)]);
      sent++;
    } catch (err) {
      const attempts = Number(row.attempts) + 1;
      // Three strikes, then stop — a permanently bad number must not be retried forever.
      await db.query(
        `UPDATE whatsapp_outbox
            SET attempts = $2,
                status = CASE WHEN $2 >= 3 THEN 'failed' ELSE 'pending' END,
                send_after = now() + ($2 * interval '5 minutes'),
                last_error = $3
          WHERE id = $1`,
        [row.id, attempts, err instanceof Error ? err.message.slice(0, 300) : 'send failed']);
      failed++;
    }
    // One send per sender per drain — the pacing the delay window exists for.
    break;
  }
  return { sent, failed, skipped };
}
