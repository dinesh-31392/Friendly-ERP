-- ─── 027: WhatsApp auto-reply + durable send queue ─────────────────────────
-- Two DIFFERENT things, deliberately separated because their risk is not the
-- same:
--
--   • inbound_*  — auto-acknowledge a customer who messaged US. This is a
--     reply inside a conversation the customer opened; it is the low-risk
--     pattern and is ON by default.
--   • new_lead_* — greet a lead the moment it lands from any source. This is
--     an OUTBOUND first contact to someone who has not messaged us, which is
--     the pattern that actually attracts blocks on an unofficial gateway. It
--     is therefore OFF by default and rate-limited even when enabled.
--
-- Sends are queued, never fired inline: the human-like delay must survive a
-- restart, and a lead insert must not block on a gateway round trip.

ALTER TABLE whatsapp_instances
  ADD COLUMN IF NOT EXISTS auto_new_lead_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_new_lead_template text NOT NULL DEFAULT
    'Hi {{name}}, thanks for your enquiry with {{company}}. I''m {{agent}} and I''ll help you personally — when is a good time to talk?',
  ADD COLUMN IF NOT EXISTS auto_inbound_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_inbound_template text NOT NULL DEFAULT
    'Thanks for your message! I''ve received it and will reply personally very shortly.',
  -- Human-like pacing between queued sends (seconds). The defaults are the
  -- 20–60s window that keeps automated activity from looking machine-timed.
  ADD COLUMN IF NOT EXISTS auto_min_delay_seconds integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS auto_max_delay_seconds integer NOT NULL DEFAULT 60,
  -- Hard ceiling on automated first-contacts per rep per day.
  ADD COLUMN IF NOT EXISTS auto_daily_cap integer NOT NULL DEFAULT 50,
  -- Local quiet hours; nothing automated goes out between these (0-23).
  ADD COLUMN IF NOT EXISTS auto_quiet_from integer NOT NULL DEFAULT 21,
  ADD COLUMN IF NOT EXISTS auto_quiet_to   integer NOT NULL DEFAULT 9;

ALTER TABLE whatsapp_instances DROP CONSTRAINT IF EXISTS whatsapp_instances_auto_delay_check;
ALTER TABLE whatsapp_instances ADD CONSTRAINT whatsapp_instances_auto_delay_check
  CHECK (auto_min_delay_seconds >= 0
         AND auto_max_delay_seconds >= auto_min_delay_seconds
         AND auto_max_delay_seconds <= 3600
         AND auto_daily_cap BETWEEN 0 AND 1000
         AND auto_quiet_from BETWEEN 0 AND 23
         AND auto_quiet_to   BETWEEN 0 AND 23);

/**
 * The outbox. One row per pending automated message.
 *
 * `send_after` carries the randomised human-like delay, so pacing survives a
 * restart (a setTimeout would not). UNIQUE (tenant_id, lead_id, trigger)
 * is the anti-spam guarantee: a lead can only ever be auto-greeted once, no
 * matter how many times it is re-imported or updated.
 */
CREATE TABLE IF NOT EXISTS whatsapp_outbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id      uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,  -- whose number sends it
  trigger      text NOT NULL CHECK (trigger IN ('new_lead', 'inbound')),
  phone        text NOT NULL,
  body         text NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  send_after   timestamptz NOT NULL,
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, lead_id, trigger)
);

CREATE INDEX IF NOT EXISTS whatsapp_outbox_due_idx
  ON whatsapp_outbox (tenant_id, send_after) WHERE status = 'pending';

ALTER TABLE whatsapp_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON whatsapp_outbox USING (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_outbox TO app_user;
GRANT ALL ON whatsapp_outbox TO app_platform;
