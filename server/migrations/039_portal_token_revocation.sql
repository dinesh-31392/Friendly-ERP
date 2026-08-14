-- 039: portal sessions become revocable too.
--
-- 037 made a STAFF session killable and left the portal realm as the named gap.
-- This closes it, mirroring that design rather than inventing a second one:
--
--   revoked_portal_tokens             kill ONE token   — "sign out this device"
--   portal_users.sessions_valid_from  kill EVERY token — "sign out everywhere"
--
-- WHY A SECOND TABLE RATHER THAN A `realm` COLUMN ON revoked_tokens
--
-- Because revoked_tokens carries a composite foreign key to users, and a portal
-- subject is not a row in users. Generalising would mean dropping that key and
-- keeping a nullable pair of columns pointing at two different parents — the
-- referential integrity would become a comment instead of a constraint. Two
-- realms already means two user tables and two auth guards; two deny-lists is
-- the same shape, and each keeps a real foreign key.
--
-- The blast radius here is smaller than for staff — a portal subject sees only
-- their own bookings and payments — but "smaller" is how the crm_tasks hole
-- looked too.

-- Prerequisite. Every other tenant table carries UNIQUE (id, tenant_id) so
-- children can reference it compositely; portal_users never got one, which is
-- why the sweeps in 033 and 038 could not have fixed a key pointing at it even
-- if one had existed. Added first so the deny-list below can reference it.
ALTER TABLE portal_users DROP CONSTRAINT IF EXISTS portal_users_id_tenant_id_key;
ALTER TABLE portal_users ADD CONSTRAINT portal_users_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE portal_users
  ADD COLUMN IF NOT EXISTS sessions_valid_from timestamptz;

COMMENT ON COLUMN portal_users.sessions_valid_from IS
  'Portal tokens issued before this instant are refused. NULL means never '
  'bulk-revoked. Set to the START OF THE NEXT SECOND — see 037.';

CREATE TABLE IF NOT EXISTS revoked_portal_tokens (
  jti            uuid        PRIMARY KEY,
  tenant_id      uuid        NOT NULL REFERENCES tenants(id),
  portal_user_id uuid        NOT NULL,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz NOT NULL DEFAULT now(),
  reason         text        NOT NULL DEFAULT 'logout',
  UNIQUE (jti, tenant_id)
);

ALTER TABLE revoked_portal_tokens DROP CONSTRAINT IF EXISTS revoked_portal_tokens_user_fkey;
ALTER TABLE revoked_portal_tokens ADD CONSTRAINT revoked_portal_tokens_user_fkey
  FOREIGN KEY (portal_user_id, tenant_id) REFERENCES portal_users (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE revoked_portal_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE revoked_portal_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON revoked_portal_tokens;
CREATE POLICY tenant_rows ON revoked_portal_tokens
  USING (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, DELETE ON revoked_portal_tokens TO app_user;
GRANT SELECT, INSERT, DELETE ON revoked_portal_tokens TO app_platform;

CREATE INDEX IF NOT EXISTS idx_revoked_portal_tokens_tenant_expiry
  ON revoked_portal_tokens (tenant_id, expires_at);

/**
 * The portal twin of token_is_live(). Same contract, same reasoning:
 * SECURITY DEFINER because it decides whether a tenant context should be
 * honoured at all, STABLE because it runs once per request, and it takes its
 * subject as arguments so it does not depend on set_config calls evaluated
 * beside it in the same SELECT list.
 *
 * `active` is checked here as well as in the routes. The routes already filter
 * on it, but that is per-route and therefore a rule every future portal route
 * has to remember; this makes deactivation structural.
 */
CREATE OR REPLACE FUNCTION portal_token_is_live(
  p_tenant      uuid,
  p_portal_user uuid,
  p_jti         uuid,
  p_issued_at   bigint
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM portal_users p
     WHERE p.id = p_portal_user
       AND p.tenant_id = p_tenant
       AND p.active
       AND (p.sessions_valid_from IS NULL
            OR to_timestamp(p_issued_at) >= p.sessions_valid_from)
  )
  AND NOT EXISTS (
    SELECT 1 FROM revoked_portal_tokens r
     WHERE p_jti IS NOT NULL
       AND r.jti = p_jti
       AND r.tenant_id = p_tenant
  )
$$;

REVOKE ALL ON FUNCTION portal_token_is_live(uuid, uuid, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal_token_is_live(uuid, uuid, uuid, bigint) TO app_user;
GRANT EXECUTE ON FUNCTION portal_token_is_live(uuid, uuid, uuid, bigint) TO app_platform;

DO $$
DECLARE has_col boolean; has_fn boolean; has_key boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='portal_users' AND column_name='sessions_valid_from') INTO has_col;
  SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='portal_token_is_live') INTO has_fn;
  SELECT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname='portal_users_id_tenant_id_key') INTO has_key;
  IF has_col AND has_fn AND has_key THEN
    RAISE NOTICE '039: portal sessions are revocable';
  ELSE
    RAISE WARNING '039: incomplete (column=% function=% key=%)', has_col, has_fn, has_key;
  END IF;
END $$;
