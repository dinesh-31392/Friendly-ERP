-- ─── 064: one secret, one workspace ────────────────────────────────────────
--
-- Three integrations let an outside system reach in with no session at all —
-- a portal posting a lead, a telephony provider reporting a call, a WhatsApp
-- gateway delivering a message. None of them can name the workspace they are
-- posting to (asking them to would let anybody post into anybody's), so in
-- every case THE SECRET IS THE IDENTITY: the tenant is resolved from it.
--
-- That makes the secret's uniqueness a tenant-isolation guarantee, not a
-- convenience. And two of the three were only unique by luck.
--
--   lead_sources.secret_hash             indexed, NOT unique
--   telephony_settings.callback_secret_hash  indexed, NOT unique
--   whatsapp_user_sessions.webhook_token     UNIQUE already
--
-- Both lookups take the first row they find:
--
--   SELECT ... FROM lead_sources WHERE secret_hash = $1 AND source_key = $2 AND active
--   candidates.find(c => secretMatches(presented, c.callback_secret_hash))
--
-- With a duplicate, neither has a defined answer. The enquiry lands in
-- whichever workspace Postgres happened to return first, and the call event
-- attaches to whichever row the scan reached first — silently, and differently
-- between runs.
--
-- WHY THIS WAS NOT ALREADY A BUG
--
-- Both secrets are 32 bytes from randomBytes, so an accidental collision will
-- not happen in the life of the product. That is a probabilistic argument, and
-- it stops holding the moment somebody sets a secret by hand, restores one
-- workspace's row into another, or writes a fixture that reuses a constant.
--
-- A unique index costs nothing and replaces "will not happen" with "the
-- database will not permit it" — which is the standard the rest of the tenant
-- isolation in this schema is held to.
--
-- PARTIAL, MIRRORING EACH LOOKUP EXACTLY
--
-- Each index carries the same predicate as the query it protects. A rotated
-- secret is left behind on an inactive row and must not block a workspace from
-- minting a new one, and an empty hash means "no callback configured yet",
-- which every workspace shares until it configures one.

-- The portals: 99acres, Housing, MagicBricks, the builder's own website.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_sources_secret_active
  ON lead_sources (secret_hash) WHERE active;

-- Click-to-call status callbacks.
CREATE UNIQUE INDEX IF NOT EXISTS uq_telephony_secret_active
  ON telephony_settings (callback_secret_hash)
  WHERE active AND callback_secret_hash <> '';

-- ─── Proof ─────────────────────────────────────────────────────────────────
--
-- Asserted rather than assumed: if either index failed to build because live
-- data already holds a duplicate, that is a cross-tenant defect happening NOW
-- and the migration must stop rather than report success.

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(want, ', ')
    INTO missing
    FROM (VALUES ('uq_lead_sources_secret_active'), ('uq_telephony_secret_active')) AS v(want)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = v.want
        AND indexdef ILIKE '%UNIQUE%');

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'integration secrets are not uniquely constrained: %', missing;
  END IF;
END $$;
