-- ─── 065: one builder's webhook could silence another's ────────────────────
--
-- Both webhook tables deduplicate redeliveries on a key that does not include
-- the workspace:
--
--   telephony_events  UNIQUE (provider, provider_call_id, event_status)
--   gateway_events    UNIQUE (provider, event_id)
--
-- Each handler inserts with ON CONFLICT DO NOTHING and treats "no row
-- returned" as "already seen", answering 200 and applying nothing. That is the
-- correct shape for a redelivery — a provider retries until it gets a 2xx, so
-- an error would become an infinite loop — but the key it rests on is global.
--
-- SO THE FIRST WORKSPACE TO CLAIM AN ID OWNS IT FOREVER, FOR EVERYONE.
--
-- Once tenant B has recorded ('exotel', <call id>, 'connected'), the real
-- callback for tenant A's call with that id inserts nothing, is reported as a
-- duplicate, and A's call log is never updated. No error anywhere: the
-- provider got its 200, the row simply never moved.
--
-- THIS DOES NOT NEED AN ATTACKER
--
-- Every builder connects their OWN Exotel and Razorpay account. Provider ids
-- are unique within an account, not across accounts — nothing stops two
-- accounts issuing the same CallSid or event id, and the product is built on
-- the assumption that every builder brings their own credentials. The second
-- builder to receive a colliding id silently loses that event.
--
-- With an attacker it is worse and it is money: a workspace can pre-insert
-- plausible ids through its own legitimate webhook and suppress another
-- builder's payment confirmations, so a payment captured at the gateway never
-- marks the demand paid.
--
-- THE FIX
--
-- Idempotency is a property of ONE workspace's integration, so the key is
-- scoped to the workspace. A redelivery is still deduplicated exactly as
-- before, within the tenant that owns it; a collision across tenants is now
-- two separate events, which is what it always was.
--
-- The composite (id, tenant_id) keys are left alone — those exist so child
-- tables can carry a tenant-scoped foreign key, which is a different job.

ALTER TABLE telephony_events
  DROP CONSTRAINT IF EXISTS telephony_events_provider_provider_call_id_event_status_key;
ALTER TABLE telephony_events
  ADD CONSTRAINT telephony_events_tenant_call_status_key
  UNIQUE (tenant_id, provider, provider_call_id, event_status);

ALTER TABLE gateway_events
  DROP CONSTRAINT IF EXISTS gateway_events_provider_event_id_key;
ALTER TABLE gateway_events
  ADD CONSTRAINT gateway_events_tenant_event_key
  UNIQUE (tenant_id, provider, event_id);

-- ─── Proof ─────────────────────────────────────────────────────────────────
--
-- Both halves are asserted: the tenant-scoped key must exist, AND the global
-- one must be gone. Adding the first while leaving the second in place would
-- change nothing — the old constraint would still reject the second tenant's
-- row, and the bug would survive a migration that looked like it fixed it.

DO $$
DECLARE problem text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'telephony_events'::regclass
       AND conname = 'telephony_events_tenant_call_status_key'
  ) THEN problem := 'telephony_events is not tenant-scoped';
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'gateway_events'::regclass
       AND conname = 'gateway_events_tenant_event_key'
  ) THEN problem := 'gateway_events is not tenant-scoped';
  ELSIF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'telephony_events'::regclass AND contype = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (provider, provider_call_id, event_status)'
  ) THEN problem := 'the global telephony key still exists and still blocks';
  ELSIF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'gateway_events'::regclass AND contype = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (provider, event_id)'
  ) THEN problem := 'the global gateway key still exists and still blocks';
  END IF;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'webhook idempotency is still cross-tenant: %', problem;
  END IF;
END $$;
