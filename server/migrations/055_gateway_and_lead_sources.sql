-- ─── 055: payment gateway, and machine-to-machine lead sources ─────────────
--
-- Two integrations that both come down to the same question: how does this
-- system safely accept something an outsider sends it?
--
-- ═══ PART 1 — THE PAYMENT GATEWAY ═══
--
-- A buyer paying online is the one place where money enters the system from
-- outside it, and the rule is that the CLIENT NEVER SAYS A PAYMENT SUCCEEDED.
-- The browser can be told anything; only the gateway's own signed webhook is
-- evidence. So an order is created server-side with an amount the server
-- computed, and nothing is recorded as received until a webhook arrives whose
-- signature verifies against the shared secret.
--
-- Two properties this table exists to give:
--
--   IDEMPOTENCY. Razorpay retries a webhook until it gets a 2xx, and it will
--   happily deliver the same event three times. Without a unique key on the
--   event id, a buyer's 10 lakh instalment lands three times, the milestone
--   shows overpaid, and somebody has to work out which two receipts are ghosts.
--
--   EVIDENCE. The raw payload is kept because a payment dispute is settled by
--   what the gateway actually sent, not by what this system made of it.

CREATE TABLE IF NOT EXISTS gateway_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  provider      text NOT NULL DEFAULT 'razorpay'
                CHECK (provider IN ('razorpay', 'payu')),

  -- The gateway's own order id. Unique per provider so a webhook can resolve
  -- back to the milestone it was raised against.
  order_ref     text NOT NULL,

  payment_schedule_id uuid NOT NULL,

  -- Stored in the major unit (rupees), converted to paise only at the gateway
  -- boundary. Keeping paise in the database would mean every report and every
  -- join has to remember to divide, and one that forgets is out by a hundred.
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  currency      text NOT NULL DEFAULT 'INR',

  status        text NOT NULL DEFAULT 'created'
                CHECK (status IN ('created', 'paid', 'failed', 'expired')),

  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, tenant_id),
  UNIQUE (provider, order_ref),
  FOREIGN KEY (payment_schedule_id, tenant_id) REFERENCES payment_schedules (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gateway_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  provider      text NOT NULL DEFAULT 'razorpay',

  -- The gateway's event id. THIS is the idempotency key, and it is unique
  -- across the whole table rather than per tenant: an event id is the
  -- gateway's, not ours, and the same one must never be processed twice
  -- regardless of which workspace it resolves to.
  event_id      text NOT NULL,
  event_type    text NOT NULL DEFAULT '',

  order_ref     text NOT NULL DEFAULT '',
  payment_ref   text NOT NULL DEFAULT '',
  amount        numeric(14,2) NOT NULL DEFAULT 0,

  -- Never true for an unverified payload. Kept as a column rather than implied
  -- by the row's existence because a FAILED verification is worth storing —
  -- a run of them is somebody probing the endpoint.
  signature_verified boolean NOT NULL DEFAULT false,

  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Set once the event has actually moved money in this system. An event that
  -- arrives, verifies, and then fails to apply must be findable.
  applied_at    timestamptz,
  payment_id    uuid,
  error         text NOT NULL DEFAULT '',

  received_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, tenant_id),
  UNIQUE (provider, event_id),
  -- An event may only be applied if its signature verified. The check is here
  -- as well as in the handler because this is the one that cannot be forgotten
  -- by a future code path.
  CONSTRAINT gateway_event_applied_needs_signature
    CHECK (applied_at IS NULL OR signature_verified)
);

CREATE INDEX IF NOT EXISTS idx_gateway_orders_tenant   ON gateway_orders (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gateway_events_tenant   ON gateway_events (tenant_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_gateway_events_order    ON gateway_events (order_ref);

-- ═══ PART 2 — LEAD SOURCES ═══
--
-- 99acres, MagicBricks and Housing all push leads server-to-server. They have
-- no session, no user and no workspace slug — just a URL a builder gives them
-- and, if the builder is lucky, somewhere to put a secret.
--
-- Each source gets its OWN credential. One shared key across every portal
-- means rotating a leaked one takes every integration down at once, and it
-- makes "which portal is sending us rubbish" unanswerable.
--
-- The secret is stored as a SHA-256 digest, not in the clear and not under
-- argon2. It is a 32-byte machine-generated token with no brute-force surface
-- worth defending against, and it is presented on every single inbound lead —
-- a password hash there would cost 100ms of CPU per lead for no benefit.

CREATE TABLE IF NOT EXISTS lead_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  source_key    text NOT NULL
                CHECK (source_key IN ('99acres', 'magicbricks', 'housing',
                                      'website', 'landing_page', 'custom')),
  label         text NOT NULL DEFAULT '',

  -- SHA-256 of the token. The plaintext is shown exactly once, at creation,
  -- and is not recoverable afterwards — the same rule as any other credential.
  secret_hash   text NOT NULL,

  active        boolean NOT NULL DEFAULT true,

  -- Operational, not decorative: "we stopped getting leads from MagicBricks
  -- three weeks ago" is a question a builder asks, and without this the only
  -- answer is a guess.
  received_count integer NOT NULL DEFAULT 0,
  last_seen_at  timestamptz,

  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, tenant_id),
  -- One live credential per portal per workspace. A second would make rotation
  -- ambiguous and leave a revoked key working.
  UNIQUE (tenant_id, source_key)
);

CREATE INDEX IF NOT EXISTS idx_lead_sources_hash ON lead_sources (secret_hash) WHERE active;

ALTER TABLE gateway_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_orders FORCE  ROW LEVEL SECURITY;
ALTER TABLE gateway_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_events FORCE  ROW LEVEL SECURITY;
ALTER TABLE lead_sources   ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_sources   FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_rows ON gateway_orders;
CREATE POLICY tenant_rows ON gateway_orders USING (tenant_id = app_current_tenant());
DROP POLICY IF EXISTS tenant_rows ON gateway_events;
CREATE POLICY tenant_rows ON gateway_events USING (tenant_id = app_current_tenant());
DROP POLICY IF EXISTS tenant_rows ON lead_sources;
CREATE POLICY tenant_rows ON lead_sources   USING (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON gateway_orders TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON gateway_events TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_sources   TO app_user;
GRANT ALL ON gateway_orders TO app_platform;
GRANT ALL ON gateway_events TO app_platform;
GRANT ALL ON lead_sources   TO app_platform;

DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM pg_constraint
   WHERE contype = 'f'
     AND confrelid = 'tenants'::regclass
     AND conrelid IN ('gateway_orders'::regclass, 'gateway_events'::regclass,
                      'lead_sources'::regclass)
     AND confdeltype <> 'c';
  IF bad > 0 THEN
    RAISE EXCEPTION 'gateway and lead-source tables must cascade on tenant delete';
  END IF;
END $$;
