-- ─── 018: Statutory compliance ─────────────────────────────────────────────
-- Filing tracker for GST / RERA / Income Tax / EPFO-ESIC etc — due dates,
-- frequency, and filed/paid status. Previously localStorage-only.

CREATE TABLE IF NOT EXISTS compliance_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title      text NOT NULL,
  authority  text NOT NULL DEFAULT '',            -- 'GST','RERA','Income Tax','EPFO/ESIC'
  due_date   date NOT NULL,
  frequency  text NOT NULL DEFAULT 'one_time' CHECK (frequency IN ('one_time', 'monthly', 'quarterly', 'annual')),
  project_id uuid,                                 -- RERA filings are per-project
  amount     numeric(14,2),
  notes      text,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'filed', 'paid')),
  filed_at   timestamptz,
  filed_by   uuid REFERENCES users(id),
  paid_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE SET NULL (project_id)
);

ALTER TABLE compliance_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON compliance_items;
CREATE POLICY tenant_rows ON compliance_items USING (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON compliance_items TO app_user;
GRANT ALL ON compliance_items TO app_platform;

CREATE INDEX IF NOT EXISTS idx_compliance_tenant_due ON compliance_items (tenant_id, due_date);
