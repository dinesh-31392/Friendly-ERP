-- ============================================================================
-- FRIENDLY ERP — CRM/ERP core schema (projects, units, bookings, quotations,
-- brokers, customers, service requests, approval workflows).
--
-- Implements the "Full Data Structures & Role-Based Access" addendum at the
-- DATABASE level: the constraints called out there (one active booking per
-- unit, mandatory lost reason, tenant isolation) live here, not in app code.
-- Conventions follow 001_schema.sql: FORCE RLS everywhere, composite
-- tenant-scoped FKs where a plain FK would accept another tenant's row,
-- tenant-leading indexes, audit triggers, and GRANTS AT THE END (a GRANT ON
-- ALL TABLES earlier in the file misses tables created after it).
-- ============================================================================

-- ─── 0. Composite-FK anchor on leads ────────────────────────────────────────
-- Several tables below reference leads with a tenant-scoped composite FK;
-- the (id, tenant_id) pair must be unique BEFORE any of them is created.
ALTER TABLE leads ADD CONSTRAINT leads_id_tenant_unique UNIQUE (id, tenant_id);

-- ─── 1. Projects & assignments ──────────────────────────────────────────────

CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  city            text,
  location        text NOT NULL DEFAULT '',
  -- App-canonical statuses plus the addendum's on_hold. Mapping to the
  -- addendum enum: planning≈pre_launch, active≈under_construction/
  -- ready_to_move, completed=completed, on_hold=on_hold.
  status          text NOT NULL DEFAULT 'pre_launch'
                  CHECK (status IN ('pre_launch', 'under_construction', 'ready_to_move', 'completed', 'on_hold')),
  rera_number     text,
  total_units     integer NOT NULL DEFAULT 0,
  price_min       numeric(14,2),
  price_max       numeric(14,2),
  launch_date     date,
  completion_date date,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Composite-FK anchor (same reasoning as roles/users in 001)
  UNIQUE (id, tenant_id)
);

-- user_project_assignments: project-level scoping for front-line staff.
-- tenant_id is denormalized so RLS is a plain column check (the
-- import_rows_staging pattern) instead of a join in every policy.
CREATE TABLE user_project_assignments (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  project_id  uuid NOT NULL,
  assigned_by uuid REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id),
  -- Both legs tenant-scoped: a user cannot be assigned to another tenant's
  -- project and vice versa (FK checks bypass RLS — see 001 §3).
  FOREIGN KEY (user_id, tenant_id)    REFERENCES users (id, tenant_id)    ON DELETE CASCADE,
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);

-- ─── 2. Towers & units ──────────────────────────────────────────────────────
-- The addendum puts units directly under projects; the app groups them by
-- tower. Units carry BOTH: project_id (addendum, reporting) and an optional
-- tower_id (app structure).

CREATE TABLE towers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL,
  name            text NOT NULL,
  floors          integer NOT NULL DEFAULT 0,
  units_per_floor integer NOT NULL DEFAULT 0,
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE units (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL,
  tower_id        uuid,
  unit_code       text NOT NULL,                -- 'B-1804'
  unit_type       text NOT NULL DEFAULT '',     -- 'Apartment', 'Shop'
  configuration   text NOT NULL DEFAULT '',     -- '2 BHK'
  floor           integer NOT NULL DEFAULT 0,
  area_sqft       numeric(10,2) NOT NULL DEFAULT 0,
  base_rate       numeric(14,2) NOT NULL DEFAULT 0,  -- unit price
  floor_rise_rate numeric(14,2) NOT NULL DEFAULT 0,
  -- Availability is DERIVED from bookings for booked/sold (the partial unique
  -- index below is the lock); this column carries the sales-side states the
  -- app manages directly and is kept in step by the booking endpoints in one
  -- transaction.
  status          text NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available', 'reserved', 'blocked', 'booked', 'sold', 'on_hold')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, project_id, unit_code),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tower_id, tenant_id)   REFERENCES towers (id, tenant_id)   ON DELETE SET NULL (tower_id)
);

-- ─── 3. Brokers & customers ─────────────────────────────────────────────────

CREATE TABLE brokers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  agency_name          text,
  phone                text NOT NULL DEFAULT '',
  email                citext,
  rera_id              text,
  -- { "type": "percentage" | "flat" | "slab", "value": ... }
  commission_structure jsonb NOT NULL DEFAULT '{"type":"percentage","value":2}',
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE TABLE customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  email      citext,
  phone      text NOT NULL DEFAULT '',
  kyc_status text NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('pending', 'verified')),
  lead_id    uuid,           -- provenance: the lead this buyer converted from
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (lead_id, tenant_id) REFERENCES leads (id, tenant_id) ON DELETE SET NULL (lead_id)
);

-- ─── 4. Lead additions (addendum columns on the existing table) ─────────────

ALTER TABLE leads
  ADD COLUMN unit_id      uuid,
  ADD COLUMN broker_id    uuid,
  ADD COLUMN lost_reason  text,
  ADD COLUMN duplicate_of uuid;

ALTER TABLE leads
  ADD CONSTRAINT leads_unit_fk      FOREIGN KEY (unit_id, tenant_id)      REFERENCES units (id, tenant_id)   ON DELETE SET NULL (unit_id),
  ADD CONSTRAINT leads_broker_fk    FOREIGN KEY (broker_id, tenant_id)    REFERENCES brokers (id, tenant_id) ON DELETE SET NULL (broker_id),
  ADD CONSTRAINT leads_duplicate_fk FOREIGN KEY (duplicate_of, tenant_id) REFERENCES leads (id, tenant_id)   ON DELETE SET NULL (duplicate_of),
  ADD CONSTRAINT leads_project_fk   FOREIGN KEY (project_id, tenant_id)   REFERENCES projects (id, tenant_id) ON DELETE SET NULL (project_id) NOT VALID;
-- leads.project_id predates the projects table ("FK … same pattern" note in
-- 001); NOT VALID grandfathers whatever ids exist while enforcing new writes.

-- Addendum: lost_reason is REQUIRED whenever stage = 'lost'. NOT VALID so a
-- pre-existing lost lead without a reason doesn't brick the migration; every
-- new/updated row is checked.
ALTER TABLE leads
  ADD CONSTRAINT leads_lost_needs_reason
  CHECK (stage <> 'lost' OR lost_reason IS NOT NULL) NOT VALID;

-- lead_activities: the interaction log (calls, visits, notes, stage moves)
CREATE TABLE lead_activities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id      uuid NOT NULL,
  user_id      uuid,
  type         text NOT NULL CHECK (type IN
               ('call', 'site_visit', 'note', 'quotation_sent', 'follow_up_scheduled',
                'stage_change', 'whatsapp', 'email')),
  notes        text NOT NULL DEFAULT '',
  scheduled_at timestamptz,
  outcome      text CHECK (outcome IN ('interested', 'not_interested', 'needs_follow_up', 'no_show')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (lead_id, tenant_id) REFERENCES leads (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE SET NULL (user_id)
);

-- ─── 5. Quotations ──────────────────────────────────────────────────────────

CREATE TABLE quotations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id              uuid NOT NULL,
  unit_id              uuid NOT NULL,
  base_amount          numeric(14,2) NOT NULL,
  additional_charges   jsonb NOT NULL DEFAULT '[]',   -- [{ "label", "amount" }]
  discount_amount      numeric(14,2) NOT NULL DEFAULT 0,
  discount_approved_by uuid REFERENCES users(id),     -- required above the
                                                      -- approval_workflows threshold
  total_amount         numeric(14,2) NOT NULL CHECK (total_amount >= 0),
  valid_until          date NOT NULL,
  status               text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'pending_approval', 'sent', 'accepted', 'rejected', 'expired')),
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (lead_id, tenant_id) REFERENCES leads (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (unit_id, tenant_id) REFERENCES units (id, tenant_id) ON DELETE CASCADE
);

-- ─── 6. Bookings, schedules, payments ───────────────────────────────────────

CREATE TABLE bookings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id             uuid NOT NULL,
  unit_id             uuid NOT NULL,
  customer_id         uuid,
  quotation_id        uuid,
  booking_amount      numeric(14,2) NOT NULL DEFAULT 0,   -- token
  total_consideration numeric(14,2) NOT NULL DEFAULT 0,
  payment_plan        text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'cancelled', 'transferred', 'completed')),
  cancel_requested    boolean NOT NULL DEFAULT false,     -- exec request → manager approval
  booked_at           timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES users(id),
  UNIQUE (id, tenant_id),
  -- Reference-only FKs sit in a cascade diamond (this table AND the target
  -- both cascade from tenants); DEFERRABLE so tenant teardown checks at
  -- commit, after the whole cascade has settled.
  FOREIGN KEY (lead_id, tenant_id)      REFERENCES leads (id, tenant_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (unit_id, tenant_id)      REFERENCES units (id, tenant_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (customer_id, tenant_id)  REFERENCES customers (id, tenant_id)  ON DELETE SET NULL (customer_id),
  FOREIGN KEY (quotation_id, tenant_id) REFERENCES quotations (id, tenant_id) ON DELETE SET NULL (quotation_id)
);

-- THE constraint (addendum: "the hardest thing to retrofit later — build it
-- correctly now"): one ACTIVE (or completed) booking per unit, enforced by
-- the database even under concurrent requests. 'completed' stays in the
-- index because a sold unit is just as unavailable as a booked one.
CREATE UNIQUE INDEX bookings_one_live_per_unit
  ON bookings (unit_id) WHERE status IN ('active', 'completed');

CREATE TABLE payment_schedules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id     uuid NOT NULL,
  milestone_name text NOT NULL,              -- 'Booking', 'Plinth', 'Possession'
  sequence       integer NOT NULL,
  percentage     numeric(5,2) NOT NULL DEFAULT 0,
  amount         numeric(14,2) NOT NULL,
  trigger_type   text NOT NULL DEFAULT 'date'
                 CHECK (trigger_type IN ('date', 'construction_milestone')),
  due_date       date,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'invoiced', 'paid', 'overdue')),
  UNIQUE (id, tenant_id),
  UNIQUE (booking_id, sequence),
  FOREIGN KEY (booking_id, tenant_id) REFERENCES bookings (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_schedule_id uuid NOT NULL,
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  payment_date        date NOT NULL DEFAULT CURRENT_DATE,
  mode                text NOT NULL DEFAULT 'bank_transfer'
                      CHECK (mode IN ('cheque', 'bank_transfer', 'upi', 'cash', 'card')),
  reference_no        text,
  received_by         uuid REFERENCES users(id),
  -- Finance addendum: bank-reconciliation flags live on the shared AR table
  reconciled          boolean NOT NULL DEFAULT false,
  bank_transaction_id uuid,                 -- FK added in 004 (table exists there)
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (payment_schedule_id, tenant_id) REFERENCES payment_schedules (id, tenant_id) ON DELETE CASCADE
);

-- ─── 7. Commission ledger & service requests ────────────────────────────────

CREATE TABLE commission_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  broker_id     uuid NOT NULL,
  booking_id    uuid NOT NULL,
  amount_earned numeric(14,2) NOT NULL,
  amount_paid   numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'partially_paid', 'paid')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (broker_id, tenant_id)  REFERENCES brokers (id, tenant_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (booking_id, tenant_id) REFERENCES bookings (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE service_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  booking_id  uuid,
  category    text NOT NULL DEFAULT 'other'
              CHECK (category IN ('maintenance', 'document_request', 'payment_query', 'transfer_request', 'other')),
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  assigned_to uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  FOREIGN KEY (customer_id, tenant_id) REFERENCES customers (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (booking_id, tenant_id)  REFERENCES bookings (id, tenant_id)  ON DELETE SET NULL (booking_id),
  FOREIGN KEY (assigned_to, tenant_id) REFERENCES users (id, tenant_id)     ON DELETE SET NULL (assigned_to)
);

-- ─── 8. Approval workflows (config, not code) ───────────────────────────────

CREATE TABLE approval_workflows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_type      text NOT NULL
                   CHECK (action_type IN ('discount_approval', 'cancellation_approval', 'transfer_approval',
                                          'vendor_bill_approval', 'ra_bill_approval')),
  threshold_amount numeric(14,2),            -- NULL = always requires approval
  approver_role_id uuid NOT NULL,
  UNIQUE (tenant_id, action_type),
  FOREIGN KEY (approver_role_id, tenant_id) REFERENCES roles (id, tenant_id) ON DELETE CASCADE
);

-- ─── 9. RLS: FORCE on everything, fail closed without tenant context ────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects', 'user_project_assignments', 'towers', 'units', 'brokers',
    'customers', 'lead_activities', 'quotations', 'bookings',
    'payment_schedules', 'payments', 'commission_ledger', 'service_requests',
    'approval_workflows'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_rows ON %I', t);
    EXECUTE format('CREATE POLICY tenant_rows ON %I USING (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

-- ─── 10. Audit triggers (writer is the SECURITY DEFINER fn from 001) ────────

CREATE TRIGGER audit_projects   AFTER INSERT OR UPDATE OR DELETE ON projects   FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_units      AFTER INSERT OR UPDATE OR DELETE ON units      FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_quotations AFTER INSERT OR UPDATE OR DELETE ON quotations FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_bookings   AFTER INSERT OR UPDATE OR DELETE ON bookings   FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_payments   AFTER INSERT OR UPDATE OR DELETE ON payments   FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_commissions AFTER INSERT OR UPDATE OR DELETE ON commission_ledger FOR EACH ROW EXECUTE FUNCTION audit_row_change();

CREATE TRIGGER projects_touch BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ─── 11. Indexes (tenant-leading — see 001 §8) ──────────────────────────────

CREATE INDEX idx_projects_tenant_status    ON projects (tenant_id, status);
CREATE INDEX idx_upa_tenant_project        ON user_project_assignments (tenant_id, project_id);
CREATE INDEX idx_units_tenant_project      ON units (tenant_id, project_id, status);
CREATE INDEX idx_leadact_tenant_lead       ON lead_activities (tenant_id, lead_id, created_at DESC);
CREATE INDEX idx_quotes_tenant_status      ON quotations (tenant_id, status);
CREATE INDEX idx_bookings_tenant_status    ON bookings (tenant_id, status);
CREATE INDEX idx_paysched_tenant_booking   ON payment_schedules (tenant_id, booking_id);
CREATE INDEX idx_paysched_tenant_due       ON payment_schedules (tenant_id, due_date)
  WHERE status IN ('pending', 'invoiced', 'overdue');       -- collections scan
CREATE INDEX idx_payments_tenant_date      ON payments (tenant_id, payment_date DESC);
CREATE INDEX idx_payments_unreconciled     ON payments (tenant_id) WHERE NOT reconciled;
CREATE INDEX idx_commission_tenant_broker  ON commission_ledger (tenant_id, broker_id);
CREATE INDEX idx_service_tenant_status     ON service_requests (tenant_id, status);

-- ─── 12. Grants (MUST stay the last section of this file) ───────────────────
-- 001's GRANT ... ON ALL TABLES ran before these tables existed, so each new
-- migration grants its own tables explicitly.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  projects, user_project_assignments, towers, units, brokers, customers,
  lead_activities, quotations, bookings, payment_schedules, payments,
  commission_ledger, service_requests, approval_workflows
TO app_user;

GRANT ALL ON
  projects, user_project_assignments, towers, units, brokers, customers,
  lead_activities, quotations, bookings, payment_schedules, payments,
  commission_ledger, service_requests, approval_workflows
TO app_platform;
