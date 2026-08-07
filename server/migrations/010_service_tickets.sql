-- ─── 010: service tickets (internal support desk) ──────────────────────────
-- The service desk UI manages support tickets keyed to LEADS with free-text
-- customer/project labels and a priority — a different model from the existing
-- customer-portal `service_requests` table (003), which is keyed to a
-- `customers` record. Rather than reshape that table, this is a greenfield
-- table shaped 1:1 to the SPA `Ticket` type. `lead_id` and `assigned_to` are
-- kept as loose text ids (the UI resolves them against its lead/user lists and
-- already tolerates orphaned refs), so no FK friction on empty values.

CREATE TABLE IF NOT EXISTS service_tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title       text NOT NULL,
  lead_id     text NOT NULL DEFAULT '',
  customer    text NOT NULL DEFAULT '',
  project     text NOT NULL DEFAULT '',
  category    text NOT NULL DEFAULT 'Other',
  priority    text NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  status      text NOT NULL DEFAULT 'open'   CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  assigned_to text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- RLS: FORCE + tenant policy, matching every other tenant table (003 §9).
ALTER TABLE service_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON service_tickets USING (tenant_id = app_current_tenant());

CREATE INDEX idx_service_tickets_tenant_created ON service_tickets (tenant_id, created_at DESC);

-- 001's blanket GRANT ran before this table existed (see 003 §12).
GRANT SELECT, INSERT, UPDATE, DELETE ON service_tickets TO app_user;
GRANT ALL ON service_tickets TO app_platform;
