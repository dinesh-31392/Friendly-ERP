-- ─── 002: admin-issued temporary passwords ──────────────────────────────────
--
-- When an administrator creates a colleague's account the server generates a
-- one-time password and hands it over exactly once. This flag is what forces
-- the recipient off that shared secret: the SPA blocks the app behind
-- ForcePasswordChange until they choose their own. Without the column an admin
-- can create an account but has no way to require a reset, so the temporary
-- password quietly becomes the user's permanent one.
--
-- Idempotent (IF NOT EXISTS) so re-running the migration set is safe; the
-- runner also records applied files in _migrations.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN users.must_change_password IS
  'Set when an admin issues a temporary password; cleared once the user sets their own.';

-- No new GRANTs needed: privileges on `users` are table-level (001 section 12),
-- and a new column inherits them.
