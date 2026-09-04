-- ─── 057: click-to-call ────────────────────────────────────────────────────
--
-- `call_logs` recorded a call a salesperson had already made and typed in
-- afterwards. It had no link to a provider, no in-flight state, and no notion
-- of an inbound call at all — so the table the review described as "already
-- there waiting for a telephony provider" could not actually hold a call the
-- system had placed.
--
-- WHY CLOUD TELEPHONY RATHER THAN A tel: LINK
--
-- The product already opens the dialler. What that cannot do is the thing a
-- sales desk actually needs: keep the rep's personal mobile number off the
-- customer's phone. A rep who calls from their own SIM has handed a stranger
-- their number permanently — and when they leave, the customer keeps ringing
-- them instead of the builder. Cloud telephony calls the agent first, then the
-- customer, and the customer only ever sees the builder's own line.
--
-- IN-FLIGHT IS A STATE, NOT AN ABSENCE
--
-- A placed call is real before it is answered. Without `ringing` and
-- `in_progress` the row either does not exist until the call ends — losing
-- every call that never connects, which is most of them — or exists as
-- `connected` and lies. Both are recorded, and a call that ends without being
-- answered keeps its own status rather than being deleted.

ALTER TABLE call_logs
  ADD COLUMN IF NOT EXISTS provider          text NOT NULL DEFAULT 'manual'
                           CHECK (provider IN ('manual', 'exotel')),
  -- The provider's own call id. This is what a webhook arrives carrying, and
  -- the only way to find the row it belongs to.
  ADD COLUMN IF NOT EXISTS provider_call_id  text,

  ADD COLUMN IF NOT EXISTS direction         text NOT NULL DEFAULT 'outbound'
                           CHECK (direction IN ('outbound', 'inbound')),

  -- Kept apart. `initiated_at` is when the button was pressed; `answered_at`
  -- is when the customer picked up. The gap between them is the only honest
  -- measure of whether a number is reachable, and a single created_at cannot
  -- express it.
  ADD COLUMN IF NOT EXISTS initiated_at      timestamptz,
  ADD COLUMN IF NOT EXISTS answered_at       timestamptz,
  ADD COLUMN IF NOT EXISTS ended_at          timestamptz,

  -- The builder's own line the customer saw. Recorded because a workspace may
  -- run several, and "which number did we call them from" is asked whenever a
  -- customer rings one back.
  ADD COLUMN IF NOT EXISTS caller_id         text;

-- A provider call id belongs to exactly one row. A webhook is delivered more
-- than once, and without this a retry creates a second call that never happened.
CREATE UNIQUE INDEX IF NOT EXISTS uq_call_logs_provider_call
  ON call_logs (provider, provider_call_id)
  WHERE provider_call_id IS NOT NULL;

-- The existing statuses describe a FINISHED call. A placed one needs the states
-- before that, and a provider can also simply fail to place it.
ALTER TABLE call_logs DROP CONSTRAINT IF EXISTS call_logs_status_check;
ALTER TABLE call_logs ADD CONSTRAINT call_logs_status_check
  CHECK (status IN ('ringing', 'in_progress', 'connected', 'no_answer', 'busy',
                    'failed', 'wrong_number', 'callback_requested'));

CREATE INDEX IF NOT EXISTS idx_call_logs_tenant_created
  ON call_logs (tenant_id, created_at DESC);

/**
 * Provider callbacks, kept for the same reasons as gateway events.
 *
 * Idempotency, because a provider retries until it gets a 2xx and will deliver
 * the same status twice. And evidence, because a dispute about whether a
 * customer was called is settled by what the provider said, not by what this
 * system made of it.
 */
CREATE TABLE IF NOT EXISTS telephony_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  provider      text NOT NULL DEFAULT 'exotel',
  -- Provider call id plus the status it reported. The same call legitimately
  -- produces several callbacks; the same call AND status is a redelivery.
  provider_call_id text NOT NULL,
  event_status  text NOT NULL DEFAULT '',

  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  call_log_id   uuid,
  applied_at    timestamptz,
  received_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, tenant_id),
  UNIQUE (provider, provider_call_id, event_status)
);

ALTER TABLE telephony_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE telephony_events FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON telephony_events;
CREATE POLICY tenant_rows ON telephony_events USING (tenant_id = app_current_tenant());

CREATE INDEX IF NOT EXISTS idx_telephony_events_tenant
  ON telephony_events (tenant_id, received_at DESC);

/**
 * The workspace's telephony settings.
 *
 * Per tenant rather than per deployment: each builder has their own Exotel
 * account and their own numbers, and one shared credential would let any
 * workspace place calls billed to another.
 *
 * The API token is a digest, never the token. It is presented by US to the
 * provider, so unlike a webhook secret it has to be recoverable — which is
 * exactly why it does NOT live here: it belongs in the environment, and this
 * row only says which account and which number to use.
 */
CREATE TABLE IF NOT EXISTS telephony_settings (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  provider      text NOT NULL DEFAULT 'exotel' CHECK (provider IN ('exotel')),
  account_sid   text NOT NULL DEFAULT '',
  -- The ExoPhone: the builder's own line, and the number a customer sees.
  caller_id     text NOT NULL DEFAULT '',
  -- Shared secret the provider presents on its callbacks. Stored as a digest;
  -- a callback URL leaks into logs and browser history far too easily for the
  -- secret in it to be recoverable from the database as well.
  callback_secret_hash text NOT NULL DEFAULT '',
  -- India requires the caller to be told a call is recorded. Off by default,
  -- because turning it on is a decision with a legal consequence and nobody
  -- should inherit it from a migration.
  record_calls  boolean NOT NULL DEFAULT false,
  active        boolean NOT NULL DEFAULT false,
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE telephony_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE telephony_settings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON telephony_settings;
CREATE POLICY tenant_rows ON telephony_settings USING (tenant_id = app_current_tenant());

CREATE INDEX IF NOT EXISTS idx_telephony_settings_secret
  ON telephony_settings (callback_secret_hash) WHERE active;

GRANT SELECT, INSERT, UPDATE, DELETE ON telephony_events   TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON telephony_settings TO app_user;
GRANT ALL ON telephony_events   TO app_platform;
GRANT ALL ON telephony_settings TO app_platform;

DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM pg_constraint
   WHERE contype = 'f'
     AND confrelid = 'tenants'::regclass
     AND conrelid IN ('telephony_events'::regclass, 'telephony_settings'::regclass)
     AND confdeltype <> 'c';
  IF bad > 0 THEN
    RAISE EXCEPTION 'telephony tables must cascade on tenant delete';
  END IF;
END $$;
