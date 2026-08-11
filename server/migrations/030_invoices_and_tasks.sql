-- 030: the last two tables the SPA kept only in localStorage.
--
-- Billing raised invoices and Calendar tracked tasks entirely in the browser.
-- Both were invisible to every other user: a token invoice existed on one
-- salesperson's laptop and finance never saw it, and a task assigned to a
-- colleague never reached them. There was no server table to write to, so the
-- dispatchers had nowhere to send them.
--
-- `crm_tasks`, not `tasks` — `site_tasks` (migration 017) is construction work
-- on a project. This is the CRM follow-up: call this lead, collect this
-- payment. Different owners, different lifecycles, deliberately separate.

-- ── Invoices ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id      uuid,
  booking_id   uuid,
  -- Denormalised for the list view. The lead can be renamed or deleted; an
  -- issued invoice must still read correctly years later, so these are a
  -- snapshot at issue time, not a join.
  lead_name    text NOT NULL DEFAULT '',
  project      text NOT NULL DEFAULT '',
  type         text NOT NULL DEFAULT 'Booking Token',
  amount       numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  issue_date   date NOT NULL DEFAULT CURRENT_DATE,
  due_date     date,
  status       text NOT NULL DEFAULT 'Pending'
                 CHECK (status IN ('Paid', 'Pending', 'Generated', 'Overdue')),
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (lead_id, tenant_id)    REFERENCES leads(id, tenant_id)    ON DELETE SET NULL,
  FOREIGN KEY (booking_id, tenant_id) REFERENCES bookings(id, tenant_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_invoices_tenant_issued ON invoices (tenant_id, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_status ON invoices (tenant_id, status);

-- ── CRM tasks ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Whose task it is. NOT the creator: a manager assigns work to a rep, and the
  -- calendar filters on the assignee.
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  lead_id      uuid,
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  due_date     timestamptz,
  priority     text NOT NULL DEFAULT 'warm' CHECK (priority IN ('hot', 'warm', 'cold')),
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'in_progress', 'completed')),
  category     text NOT NULL DEFAULT 'follow_up'
                 CHECK (category IN ('follow_up', 'visit', 'payment', 'service', 'other')),
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (lead_id, tenant_id) REFERENCES leads(id, tenant_id) ON DELETE SET NULL
);

-- The calendar's only real query: my open work, soonest first.
CREATE INDEX IF NOT EXISTS idx_crm_tasks_tenant_user_due ON crm_tasks (tenant_id, user_id, due_date);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_tenant_status   ON crm_tasks (tenant_id, status);

-- ── RLS ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'crm_tasks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_rows ON %I', t);
    EXECUTE format('CREATE POLICY tenant_rows ON %I USING (tenant_id = app_current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
    EXECUTE format('GRANT ALL ON %I TO app_platform', t);
  END LOOP;
END $$;

-- ── Audit ───────────────────────────────────────────────────────────────────
-- Money and commitments both belong in the trail.
DROP TRIGGER IF EXISTS audit_invoices ON invoices;
CREATE TRIGGER audit_invoices AFTER INSERT OR UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- ── Permissions ─────────────────────────────────────────────────────────────
-- Reuse the existing finance and calendar keys rather than minting new ones:
-- whoever can see the money can see the invoices, and the calendar already has
-- its own pair. No role gains anything it did not already have.
INSERT INTO permissions (key, description)
SELECT k, k FROM (VALUES ('view_invoices'), ('manage_invoices')) AS t(k)
ON CONFLICT (key) DO NOTHING;

-- Grant the new invoice keys wherever the equivalent finance key already sits,
-- so an accountant keeps working and a sales executive does not suddenly see
-- the whole receivables ledger.
INSERT INTO role_permissions (role_id, permission_key)
SELECT rp.role_id, 'view_invoices' FROM role_permissions rp WHERE rp.permission_key = 'view_finance'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT rp.role_id, 'manage_invoices' FROM role_permissions rp WHERE rp.permission_key = 'manage_finance'
ON CONFLICT DO NOTHING;
