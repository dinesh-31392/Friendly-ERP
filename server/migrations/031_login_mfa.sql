-- 031: email one-time codes as a second factor at login.
--
-- The platform admin can reach every workspace on the deployment, so a stolen
-- password there is not one tenant's problem — it is all of them. This adds a
-- second factor for that account by default, and lets any user opt in.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_email_enabled boolean NOT NULL DEFAULT false;

-- Platform staff are enrolled automatically; everyone else opts in.
UPDATE users u SET mfa_email_enabled = true
  FROM roles r, tenants t
 WHERE r.id = u.role_id AND t.id = u.tenant_id
   AND t.slug = 'platform' AND r.name IN ('super_admin', 'tech_team');

CREATE TABLE IF NOT EXISTS login_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The code is NEVER stored. Only an HMAC of it, keyed by the app's JWT
  -- secret: six digits is a 10^6 space, so a plain hash in a leaked dump falls
  -- to a wordlist instantly. With the key held outside the database, a reader
  -- who has the table still cannot turn a row into a working code.
  code_hash    text NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  -- Single use. Set the moment a code is accepted, so a code observed in a
  -- mailbox cannot be replayed after the real login has already used it.
  consumed_at  timestamptz,
  request_ip   inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Verification looks a challenge up by id and checks it is live.
CREATE INDEX IF NOT EXISTS idx_login_challenges_live
  ON login_challenges (id) WHERE consumed_at IS NULL;
-- Sweeping expired rows, and counting recent ones per user to cap resends.
CREATE INDEX IF NOT EXISTS idx_login_challenges_user_created
  ON login_challenges (user_id, created_at DESC);

-- Deliberately NOT granted to app_user and deliberately NOT under RLS.
--
-- Challenges are created and read BEFORE a session exists — there is no tenant
-- context to scope them by, which is why login already runs on the platform
-- pool. Granting the RLS-bound runtime role access to a table it can never
-- correctly scope would be a false sense of safety; instead the tenant runtime
-- cannot see this table at all.
GRANT SELECT, INSERT, UPDATE, DELETE ON login_challenges TO app_platform;
