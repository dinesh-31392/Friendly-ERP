-- ─── 009: campaigns + message templates ─────────────────────────────────────
-- The marketing page manages broadcast campaigns and reusable message templates.
-- Neither had a server table — both lived only in the browser store. Greenfield
-- tables shaped 1:1 to the SPA `Campaign` / `Template` types.

CREATE TABLE IF NOT EXISTS campaigns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  type         text NOT NULL DEFAULT 'Broadcast',
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'scheduled', 'sent', 'completed')),
  audience     text NOT NULL DEFAULT '',
  channel      text NOT NULL DEFAULT '',
  content      text NOT NULL DEFAULT '',
  scheduled_at timestamptz,
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  category   text NOT NULL DEFAULT 'General',
  channel    text NOT NULL DEFAULT '',
  content    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS: FORCE + tenant policy on both, matching every other tenant table (003 §9).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaigns', 'templates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_rows ON %I', t);
    EXECUTE format('CREATE POLICY tenant_rows ON %I USING (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

CREATE INDEX idx_campaigns_tenant_created ON campaigns (tenant_id, created_at DESC);
CREATE INDEX idx_templates_tenant_created ON templates (tenant_id, created_at DESC);

-- 001's blanket GRANT ran before these tables existed (see 003 §12).
GRANT SELECT, INSERT, UPDATE, DELETE ON campaigns, templates TO app_user;
GRANT ALL ON campaigns, templates TO app_platform;
