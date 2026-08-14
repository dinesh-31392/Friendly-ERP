-- 037: make a session killable.
--
-- THE GAP
--
-- A staff token was valid for its full 24 hours no matter what happened in
-- between. There was no jti, no deny-list, and no way to end a session. If a
-- token leaked — a shared laptop, a phone left in a taxi, a token pasted into
-- a support chat — the only remedy was to deactivate the whole user account and
-- hope nobody needed it before morning.
--
-- Deactivating the user did take effect immediately, because has_permission()
-- checks users.active on every request. But that is a blunt instrument: it
-- locks the person out of their own job to contain one leaked credential, and
-- it does nothing at all for a route that happens not to check a permission.
--
-- TWO MECHANISMS, BECAUSE THEY ANSWER DIFFERENT QUESTIONS
--
--   revoked_tokens          — kill ONE token. This is what signing out of a
--                             single device means. Keyed by the jti now carried
--                             in every staff token.
--
--   users.sessions_valid_from — kill EVERY token issued before an instant. This
--                             is what "sign out everywhere" and "the password
--                             just changed" mean. A deny-list cannot express it,
--                             because the outstanding jtis were never stored.
--
-- WHERE IT IS ENFORCED
--
-- In withTenantContext, folded into the set_config round-trip that already runs
-- on every authenticated request — so this costs no additional query. That is
-- also why token_is_live() takes its subject as ARGUMENTS rather than reading
-- app_current_user(): the evaluation order of a SELECT list is not guaranteed,
-- so a function depending on set_config in the same statement could run before
-- the settings landed. Explicit arguments make the order irrelevant.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sessions_valid_from timestamptz;

COMMENT ON COLUMN users.sessions_valid_from IS
  'Tokens issued before this instant are refused. NULL means never bulk-revoked. '
  'Set to date_trunc(''second'', now()) — see 037 for why the truncation matters.';

CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti         uuid        PRIMARY KEY,
  tenant_id   uuid        NOT NULL REFERENCES tenants(id),
  user_id     uuid        NOT NULL,
  -- The token's own expiry. Once it passes, the row is dead weight: the token
  -- would be refused by signature verification anyway. Pruned opportunistically
  -- on sign-out rather than by a scheduled job, so there is nothing to forget
  -- to deploy.
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz NOT NULL DEFAULT now(),
  reason      text        NOT NULL DEFAULT 'logout',
  UNIQUE (jti, tenant_id)
);

-- Composite, per invariant 9: a plain REFERENCES users(id) would let one
-- tenant's revocation row name another tenant's user.
ALTER TABLE revoked_tokens DROP CONSTRAINT IF EXISTS revoked_tokens_user_fkey;
ALTER TABLE revoked_tokens ADD CONSTRAINT revoked_tokens_user_fkey
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE revoked_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE revoked_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON revoked_tokens;
CREATE POLICY tenant_rows ON revoked_tokens
  USING (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, DELETE ON revoked_tokens TO app_user;
GRANT SELECT, INSERT, DELETE ON revoked_tokens TO app_platform;

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_tenant_expiry
  ON revoked_tokens (tenant_id, expires_at);

/**
 * Is this token still live?
 *
 * SECURITY DEFINER because it reads users and revoked_tokens for a subject
 * whose RLS context has not been established yet — this is the call that
 * decides whether that context should be honoured at all.
 *
 * STABLE, not VOLATILE: it runs once per request and the planner may cache it
 * within the statement.
 *
 * Returns false rather than raising, so the caller decides the status code.
 */
CREATE OR REPLACE FUNCTION token_is_live(
  p_tenant    uuid,
  p_user      uuid,
  p_jti       uuid,
  p_issued_at bigint
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM users u
     WHERE u.id = p_user
       AND u.tenant_id = p_tenant
       AND u.active
       -- Bulk revocation. p_issued_at is the JWT `iat`, whole seconds since the
       -- epoch, so "issued just before the revocation" and "issued just after"
       -- are indistinguishable inside one second. Writers set the watermark to
       -- the START OF THE NEXT SECOND, which breaks that ambiguity closed: a
       -- token stamped with this second or earlier is refused. The cost is that
       -- signing back in during the same second yields an already-dead token;
       -- the alternative was a one-second window in which a stolen one worked.
       AND (u.sessions_valid_from IS NULL
            OR to_timestamp(p_issued_at) >= u.sessions_valid_from)
  )
  -- Single-token revocation. A token minted before this migration carries no
  -- jti; it is not on any deny-list and is left alone, so deploying this does
  -- not sign the whole company out.
  AND NOT EXISTS (
    SELECT 1 FROM revoked_tokens r
     WHERE p_jti IS NOT NULL
       AND r.jti = p_jti
       AND r.tenant_id = p_tenant
  )
$$;

REVOKE ALL ON FUNCTION token_is_live(uuid, uuid, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION token_is_live(uuid, uuid, uuid, bigint) TO app_user;
GRANT EXECUTE ON FUNCTION token_is_live(uuid, uuid, uuid, bigint) TO app_platform;

DO $$
DECLARE has_col boolean; has_fn boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='users' AND column_name='sessions_valid_from') INTO has_col;
  SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='token_is_live') INTO has_fn;
  IF has_col AND has_fn THEN
    RAISE NOTICE '037: sessions are revocable — per-token and per-user';
  ELSE
    RAISE WARNING '037: incomplete (column=% function=%)', has_col, has_fn;
  END IF;
END $$;
