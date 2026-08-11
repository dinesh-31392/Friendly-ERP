-- ─── 021: Customer / channel-partner portal ────────────────────────────────
-- External portal accounts — a SEPARATE auth realm from staff `users`. Each
-- account is a buyer (linked to their lead) or a channel partner (linked to
-- their broker). Passwords are argon2 HASHES here (the demo's plaintext temp
-- passwords never reach the server). One portal account per lead / broker.

CREATE TABLE IF NOT EXISTS portal_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('customer', 'partner')),
  email         citext NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL DEFAULT '',
  lead_id       uuid,
  broker_id     uuid,
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  CHECK ((role = 'customer' AND lead_id IS NOT NULL AND broker_id IS NULL)
      OR (role = 'partner'  AND broker_id IS NOT NULL AND lead_id IS NULL)),
  FOREIGN KEY (lead_id, tenant_id)   REFERENCES leads (id, tenant_id)   ON DELETE CASCADE,
  FOREIGN KEY (broker_id, tenant_id) REFERENCES brokers (id, tenant_id) ON DELETE CASCADE
);

-- One portal account per lead / per broker (enables invite upsert).
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_lead   ON portal_users (tenant_id, lead_id)   WHERE lead_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_broker ON portal_users (tenant_id, broker_id) WHERE broker_id IS NOT NULL;

ALTER TABLE portal_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON portal_users;
CREATE POLICY tenant_rows ON portal_users USING (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON portal_users TO app_user;
-- app_platform (BYPASSRLS) performs the pre-auth login lookup, like staff login.
GRANT ALL ON portal_users TO app_platform;
