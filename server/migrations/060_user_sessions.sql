-- ─── 060: login and logout times, and what they may be used for ────────────
--
-- The product knew `users.last_login_at` — one timestamp, overwritten on every
-- sign-in. It could answer "has this person ever logged in" and nothing else.
-- No history, no logout, no way to ask when somebody was actually in the
-- system on a given day.
--
-- WHAT THIS IS FOR
--
-- Three different questions, and they deserve different answers:
--
--   Security   which sessions are open right now, from where, and when did
--              this account last sign in. `revoked_tokens` records a logout
--              but is pruned once the token would have expired anyway, so it
--              cannot answer anything historical.
--   HR         when did office staff start and finish. This is a RECORD OF
--              PRESENCE in the system, which is a different claim from
--              attendance and a very different claim from hours worked.
--   Payroll    see the warning below. Short version: not directly.
--
-- THE WARNING, BECAUSE THIS IS WHERE IT WOULD GO WRONG
--
-- Payroll pays two kinds of people differently (see buildPayrollItemsFrom):
--
--   staff             a monthly salary. Attendance does not enter the figure
--                     at all — that is what a salary means.
--   contract_worker   days present × daily wage. Attendance IS the pay.
--
-- Contract workers are site crew. They have no ERP account: `employees.user_id`
-- is null for them, and their attendance is marked present by a site engineer
-- with geo check-in. If pay were derived from logins they would each show zero
-- days and be paid nothing.
--
-- So sessions may PROPOSE an attendance row and may never silently become one.
-- Derivation is explicit, refuses to overwrite a row a human recorded, and
-- stamps `method = 'session'` so the origin is visible on the row forever.
--
-- AN OPEN SESSION IS NOT AN INFINITE ONE
--
-- Most sessions never see a logout: the browser closes, the laptop sleeps, the
-- token quietly expires. Counting such a session up to `now()` would show
-- somebody as having worked for eleven days. `expires_at` is stored so an
-- unclosed session is capped at the moment its token stopped working, which is
-- the last instant it could have been used.

CREATE TABLE IF NOT EXISTS user_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  user_id     uuid NOT NULL,
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE,

  -- The token's own id, so a sign-out can close the exact session it ended
  -- rather than guessing at the most recent one. A person signed in on a phone
  -- and a laptop has two open sessions and closing the wrong one is a lie.
  jti         uuid,

  login_at    timestamptz NOT NULL DEFAULT now(),
  logout_at   timestamptz,

  -- When the token stops being usable. An unclosed session is capped here.
  expires_at  timestamptz NOT NULL,

  ended_by    text NOT NULL DEFAULT 'open'
              CHECK (ended_by IN ('open', 'logout', 'logout_all', 'revoked', 'expired')),

  ip          text NOT NULL DEFAULT '',
  user_agent  text NOT NULL DEFAULT '',

  UNIQUE (id, tenant_id),

  -- A logout cannot precede its login, and a closed session must say how.
  CONSTRAINT user_sessions_order CHECK (logout_at IS NULL OR logout_at >= login_at),
  CONSTRAINT user_sessions_closed_shape CHECK (
    (ended_by = 'open') = (logout_at IS NULL)
  )
);

-- One live session per token. Two rows for one jti would double-count a day.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_sessions_jti
  ON user_sessions (jti) WHERE jti IS NOT NULL;

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_rows ON user_sessions;
CREATE POLICY tenant_rows ON user_sessions USING (tenant_id = app_current_tenant());

CREATE INDEX IF NOT EXISTS idx_user_sessions_tenant_login
  ON user_sessions (tenant_id, login_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_day
  ON user_sessions (tenant_id, user_id, login_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_sessions TO app_user;
GRANT ALL ON user_sessions TO app_platform;

-- ─── Attendance gains a third origin ───────────────────────────────────────
--
-- 'geo' is a site check-in with coordinates, 'manual' is somebody typing it in.
-- 'session' is derived from sign-in times and is deliberately distinguishable
-- from both: it is the weakest of the three as evidence of having worked, and
-- anyone reading the row — or auditing a payroll run — should be able to see
-- that at a glance rather than inferring it.

ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_method_check;
ALTER TABLE attendance
  ADD CONSTRAINT attendance_method_check
  CHECK (method IN ('geo', 'manual', 'session'));

COMMENT ON COLUMN attendance.method IS
  'geo = site check-in with coordinates; manual = entered by a person; '
  'session = derived from ERP sign-in times, the weakest evidence of the three.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'user_sessions'
  ) THEN
    RAISE EXCEPTION 'user_sessions was not created';
  END IF;
END $$;
