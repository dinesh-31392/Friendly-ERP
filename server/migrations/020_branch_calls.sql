-- ─── 020: Platform branches + telephony call logs ──────────────────────────
-- branches: PLATFORM-level org units (regions/offices) that group builder
-- tenants — deliberately NOT tenant-scoped and granted ONLY to app_platform,
-- so the RLS-bound builder runtime (app_user) has zero access even before any
-- route gate. tenants.branch_id links a workspace to its owning branch.
-- call_logs: tenant-scoped telephony history per lead (SIM / cloud calls).

CREATE TABLE IF NOT EXISTS branches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  manager_id uuid REFERENCES users(id),        -- a platform super_admin/tech_team user
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Platform-only: no RLS policy, no app_user grant — the tenant runtime cannot
-- even SELECT this table. All access goes through platform-gated routes.
GRANT SELECT, INSERT, UPDATE, DELETE ON branches TO app_platform;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS call_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id          uuid NOT NULL,
  user_id          uuid,
  mode             text NOT NULL DEFAULT 'SIM_NATIVE' CHECK (mode IN ('SIM_NATIVE', 'API_CLOUD')),
  status           text NOT NULL DEFAULT 'connected'
                   CHECK (status IN ('connected', 'no_answer', 'busy', 'wrong_number', 'callback_requested')),
  duration_seconds integer NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  notes            text,
  recording_url    text,                        -- cloud-telephony recording (when available)
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (lead_id, tenant_id) REFERENCES leads (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE SET NULL (user_id)
);

ALTER TABLE call_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON call_logs;
CREATE POLICY tenant_rows ON call_logs USING (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON call_logs TO app_user;
GRANT ALL ON call_logs TO app_platform;

CREATE INDEX IF NOT EXISTS idx_call_logs_tenant_lead ON call_logs (tenant_id, lead_id);
