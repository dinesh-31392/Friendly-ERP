-- ============================================================================
-- 036: the rental side of the business — leases, CAM billing, owner payouts.
--
-- WHY THIS EXISTS
--
-- Everything in this schema so far models a unit being SOLD: lead → quotation →
-- booking → payment schedule → registration. A unit that is RENTED has no
-- representation at all. There is no lease, no lessee, no recurring rent, no
-- society/CAM charge, and no way to record that the company collected rent on
-- behalf of a flat's owner and owes them the balance less a management fee.
--
-- For a developer who keeps a rental portfolio, or a brokerage that manages
-- units for owners, that is not a missing report — it is a missing third of the
-- business, currently living in somebody's spreadsheet.
--
-- NAMING: "occupant", never "tenant"
--
-- `tenant` in this database means a SUBSCRIBING COMPANY (the SaaS sense) and is
-- the column every RLS policy keys on. The renter is therefore an `occupant`.
-- Calling them a tenant here would put two different meanings on the same word
-- in the same schema, and the one that loses that collision is row-level
-- security.
--
-- CONVENTIONS (see 001 §8, 003, 033)
--   * FORCE RLS on every table; no tenant context = zero rows.
--   * Composite (id, tenant_id) FKs — a plain FK is checked by the system and
--     BYPASSES RLS, so it happily accepts another tenant's row.
--   * Reference-only FKs into tables that also cascade from `tenants` are
--     DEFERRABLE INITIALLY DEFERRED, so tenant teardown settles at commit
--     instead of failing on delete order (the `bookings` pattern).
--   * tenant_id leads every composite index.
--   * GRANTS ARE THE LAST SECTION. A GRANT ON ALL TABLES earlier in the file
--     misses every table created after it.
-- ============================================================================

-- ─── 1. Occupants (the lessee) ──────────────────────────────────────────────
-- Deliberately separate from `customers`. A customer is a BUYER: they hold a
-- booking, a payment schedule and eventually a registered sale. An occupant
-- holds a lease and pays rent. The same human can be both, and reusing one
-- table with a type flag would put nullable buyer columns on every renter and
-- nullable lease columns on every buyer.

CREATE TABLE IF NOT EXISTS occupants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  email         citext,
  phone         text NOT NULL DEFAULT '',
  occupant_type text NOT NULL DEFAULT 'individual'
                CHECK (occupant_type IN ('individual', 'company')),
  company_name  text,                    -- set when occupant_type = 'company'
  kyc_status    text NOT NULL DEFAULT 'pending'
                CHECK (kyc_status IN ('pending', 'verified')),
  -- Provenance, same as customers.lead_id: the rental enquiry this came from.
  lead_id       uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (lead_id, tenant_id) REFERENCES leads (id, tenant_id) ON DELETE SET NULL (lead_id)
);

-- ─── 2. Lease agreements ────────────────────────────────────────────────────
-- `owner_customer_id` is the LANDLORD — the person the company collects rent
-- for. NULL means the company owns the unit itself (its own rental portfolio),
-- in which case there is nobody to pay out and §6 generates nothing.

CREATE TABLE IF NOT EXISTS lease_agreements (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unit_id                uuid NOT NULL,
  occupant_id            uuid NOT NULL,
  owner_customer_id      uuid,
  lease_code             text NOT NULL,              -- 'L-2026-0043'
  start_date             date NOT NULL,
  end_date               date NOT NULL,
  rent_amount            numeric(14,2) NOT NULL CHECK (rent_amount >= 0),
  deposit_amount         numeric(14,2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  -- Escalation compounds every `escalation_months` from the start date, which
  -- is how Indian residential leases are actually written ("10% every 11
  -- months"). 0% leaves rent flat and costs nothing to carry.
  escalation_percent     numeric(5,2) NOT NULL DEFAULT 0
                         CHECK (escalation_percent >= 0 AND escalation_percent <= 100),
  escalation_months      integer NOT NULL DEFAULT 12 CHECK (escalation_months > 0),
  -- CAM (common area maintenance / society charge), quoted per sqft per month.
  -- Whether it rides on the rent invoice or is billed to the owner separately
  -- is a term of the lease, not a global setting.
  cam_rate_per_sqft      numeric(10,2) NOT NULL DEFAULT 0 CHECK (cam_rate_per_sqft >= 0),
  cam_billed_to          text NOT NULL DEFAULT 'occupant'
                         CHECK (cam_billed_to IN ('occupant', 'owner')),
  -- What the managing company keeps out of collected rent.
  management_fee_percent numeric(5,2) NOT NULL DEFAULT 0
                         CHECK (management_fee_percent >= 0 AND management_fee_percent <= 100),
  notice_period_days     integer NOT NULL DEFAULT 30 CHECK (notice_period_days >= 0),
  status                 text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'active', 'terminated', 'expired', 'renewed')),
  terminated_on          date,
  termination_reason     text,
  renewed_from_id        uuid,                       -- previous lease in the chain
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, lease_code),
  CHECK (end_date > start_date),
  -- Same reasoning as leads_lost_needs_reason in 003: a terminated agreement
  -- without a reason is a dispute waiting to happen.
  CHECK (status <> 'terminated' OR termination_reason IS NOT NULL),
  -- Reference-only into tables that also cascade from tenants → deferred, so a
  -- tenant teardown checks after the whole cascade has settled (003 §6).
  FOREIGN KEY (unit_id, tenant_id)     REFERENCES units (id, tenant_id)     DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (occupant_id, tenant_id) REFERENCES occupants (id, tenant_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_customer_id, tenant_id) REFERENCES customers (id, tenant_id)
    ON DELETE SET NULL (owner_customer_id),
  FOREIGN KEY (renewed_from_id, tenant_id)   REFERENCES lease_agreements (id, tenant_id)
    ON DELETE SET NULL (renewed_from_id)
);

-- The letting equivalent of bookings_one_live_per_unit (003 §6): a unit cannot
-- be let to two people at once, enforced by the database under concurrency
-- rather than by whichever request happened to check first.
--
-- DRAFT leases are deliberately NOT in the index — negotiating with three
-- prospects for the same flat is normal, and only one of them can be signed.
CREATE UNIQUE INDEX IF NOT EXISTS lease_one_active_per_unit
  ON lease_agreements (unit_id) WHERE status = 'active';

-- ─── 3. Rent invoices ───────────────────────────────────────────────────────
-- One row per lease per billing period. This is what the spec's "Auto Repeat"
-- would produce; here the generator is an idempotent INSERT … ON CONFLICT
-- (see UNIQUE below), so a nightly run that fires twice bills once.

CREATE TABLE IF NOT EXISTS lease_invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lease_id      uuid NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  due_date      date NOT NULL,
  rent_amount   numeric(14,2) NOT NULL CHECK (rent_amount >= 0),
  cam_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (cam_amount >= 0),
  -- Signed on purpose: a waiver or a credit for a broken geyser is negative.
  other_charges numeric(14,2) NOT NULL DEFAULT 0,
  total_amount  numeric(14,2) GENERATED ALWAYS AS (rent_amount + cam_amount + other_charges) STORED,
  amount_paid   numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'partially_paid', 'paid', 'cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  -- THE idempotency key. Without it the monthly job double-bills every tenant
  -- the first time it is retried after a timeout.
  UNIQUE (lease_id, period_start),
  CHECK (period_end >= period_start),
  FOREIGN KEY (lease_id, tenant_id) REFERENCES lease_agreements (id, tenant_id) ON DELETE CASCADE
);

-- ─── 4. Rent receipts ───────────────────────────────────────────────────────
-- Kept separate from `payments` (003 §6), which hangs off payment_schedule_id
-- NOT NULL — a sale milestone. Rent is not a sale milestone.

CREATE TABLE IF NOT EXISTS lease_receipts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lease_invoice_id uuid NOT NULL,
  amount           numeric(14,2) NOT NULL CHECK (amount > 0),
  payment_date     date NOT NULL DEFAULT CURRENT_DATE,
  mode             text NOT NULL DEFAULT 'bank_transfer'
                   CHECK (mode IN ('cheque', 'bank_transfer', 'upi', 'cash', 'card')),
  reference_no     text,
  received_by      uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (lease_invoice_id, tenant_id) REFERENCES lease_invoices (id, tenant_id) ON DELETE CASCADE
);

/**
 * Keep the invoice's paid figure derived, not asserted.
 *
 * The alternative — every route that inserts a receipt also updating the
 * invoice — is one forgotten UPDATE away from an invoice that says "pending"
 * while the money is in the bank, and owner payouts (§6) are computed from
 * collections. Deriving it in the database means a receipt inserted by ANY
 * path, including a future import script, keeps the invoice honest.
 *
 * Not SECURITY DEFINER: the invoice is in the same tenant as its receipt, so
 * the caller's own RLS context reaches it. A definer here would be a way to
 * write across tenants, for no benefit.
 */
CREATE OR REPLACE FUNCTION lease_invoice_recalc() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_invoice uuid := COALESCE(NEW.lease_invoice_id, OLD.lease_invoice_id);
  v_paid    numeric(14,2);
BEGIN
  SELECT COALESCE(sum(amount), 0) INTO v_paid
    FROM lease_receipts WHERE lease_invoice_id = v_invoice;

  UPDATE lease_invoices i
     SET amount_paid = v_paid,
         status = CASE
           -- A cancelled invoice stays cancelled; money against it is a
           -- reconciliation problem for a human, not a status flip.
           WHEN i.status = 'cancelled'      THEN 'cancelled'
           WHEN v_paid >= i.total_amount    THEN 'paid'
           WHEN v_paid > 0                  THEN 'partially_paid'
           ELSE 'pending'
         END
   WHERE i.id = v_invoice;

  RETURN NULL;   -- AFTER trigger: the return value is discarded
END $$;

DROP TRIGGER IF EXISTS lease_receipts_recalc ON lease_receipts;
CREATE TRIGGER lease_receipts_recalc
  AFTER INSERT OR UPDATE OR DELETE ON lease_receipts
  FOR EACH ROW EXECUTE FUNCTION lease_invoice_recalc();

-- ─── 5. Maintenance / CAM bills ─────────────────────────────────────────────
-- Two sources, one table:
--   * generated monthly for active leases whose CAM is billed to the OWNER
--     (occupant-billed CAM rides on the rent invoice instead — §3);
--   * created by hand for a vacant or owner-occupied unit, where there is no
--     lease to hang a rate off. Hence lease_id is nullable rather than a second
--     configuration surface nobody would keep in step.

CREATE TABLE IF NOT EXISTS maintenance_bills (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unit_id           uuid NOT NULL,
  lease_id          uuid,
  bill_to           text NOT NULL DEFAULT 'occupant'
                    CHECK (bill_to IN ('occupant', 'owner')),
  occupant_id       uuid,
  owner_customer_id uuid,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  rate_per_sqft     numeric(10,2) NOT NULL DEFAULT 0 CHECK (rate_per_sqft >= 0),
  amount            numeric(14,2) NOT NULL CHECK (amount >= 0),
  due_date          date NOT NULL,
  amount_paid       numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'partially_paid', 'paid', 'waived')),
  notes             text NOT NULL DEFAULT '',
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  -- Idempotency for the monthly run, and a genuine business rule: one CAM bill
  -- per unit per period, whoever it is addressed to.
  UNIQUE (unit_id, period_start),
  CHECK (period_end >= period_start),
  FOREIGN KEY (unit_id, tenant_id)  REFERENCES units (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (lease_id, tenant_id) REFERENCES lease_agreements (id, tenant_id)
    ON DELETE SET NULL (lease_id),
  FOREIGN KEY (occupant_id, tenant_id) REFERENCES occupants (id, tenant_id)
    ON DELETE SET NULL (occupant_id),
  FOREIGN KEY (owner_customer_id, tenant_id) REFERENCES customers (id, tenant_id)
    ON DELETE SET NULL (owner_customer_id)
);

-- ─── 6. Owner payouts ───────────────────────────────────────────────────────
-- What the company owes a unit's owner for a period: rent actually COLLECTED,
-- less the management fee, less any deduction (a repair paid on their behalf).
--
-- Computed from receipts, never from invoices raised. Paying an owner for rent
-- the occupant has not paid is how a managing agent funds a shortfall out of
-- its own pocket without noticing.

CREATE TABLE IF NOT EXISTS owner_payouts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lease_id               uuid NOT NULL,
  owner_customer_id      uuid,
  period_start           date NOT NULL,
  period_end             date NOT NULL,
  gross_collected        numeric(14,2) NOT NULL DEFAULT 0 CHECK (gross_collected >= 0),
  management_fee_percent numeric(5,2)  NOT NULL DEFAULT 0,
  management_fee_amount  numeric(14,2) NOT NULL DEFAULT 0 CHECK (management_fee_amount >= 0),
  other_deductions       numeric(14,2) NOT NULL DEFAULT 0 CHECK (other_deductions >= 0),
  net_payable            numeric(14,2)
                         GENERATED ALWAYS AS (gross_collected - management_fee_amount - other_deductions) STORED,
  status                 text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'paid', 'on_hold')),
  approved_by            uuid REFERENCES users(id),
  approved_at            timestamptz,
  paid_at                timestamptz,
  payment_reference      text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (lease_id, period_start),
  CHECK (period_end >= period_start),
  -- Maker-checker, enforced by the database rather than by remembering to
  -- check in the route: money cannot leave without a named approver. This
  -- mirrors how 028 keeps every approve_* right a SEPARATE grant.
  CHECK (status NOT IN ('approved', 'paid') OR approved_by IS NOT NULL),
  FOREIGN KEY (lease_id, tenant_id) REFERENCES lease_agreements (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_customer_id, tenant_id) REFERENCES customers (id, tenant_id)
    ON DELETE SET NULL (owner_customer_id)
);

-- ─── 7. RLS: FORCE on everything, fail closed without tenant context ────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'occupants', 'lease_agreements', 'lease_invoices', 'lease_receipts',
    'maintenance_bills', 'owner_payouts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_rows ON %I', t);
    EXECUTE format('CREATE POLICY tenant_rows ON %I USING (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

-- ─── 8. Audit + updated_at triggers ─────────────────────────────────────────
-- All six carry money or a commitment, so all six are in the trail.

DROP TRIGGER IF EXISTS audit_occupants ON occupants;
CREATE TRIGGER audit_occupants         AFTER INSERT OR UPDATE OR DELETE ON occupants         FOR EACH ROW EXECUTE FUNCTION audit_row_change();
DROP TRIGGER IF EXISTS audit_lease_agreements ON lease_agreements;
CREATE TRIGGER audit_lease_agreements  AFTER INSERT OR UPDATE OR DELETE ON lease_agreements  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
DROP TRIGGER IF EXISTS audit_lease_invoices ON lease_invoices;
CREATE TRIGGER audit_lease_invoices    AFTER INSERT OR UPDATE OR DELETE ON lease_invoices    FOR EACH ROW EXECUTE FUNCTION audit_row_change();
DROP TRIGGER IF EXISTS audit_lease_receipts ON lease_receipts;
CREATE TRIGGER audit_lease_receipts    AFTER INSERT OR UPDATE OR DELETE ON lease_receipts    FOR EACH ROW EXECUTE FUNCTION audit_row_change();
DROP TRIGGER IF EXISTS audit_maintenance_bills ON maintenance_bills;
CREATE TRIGGER audit_maintenance_bills AFTER INSERT OR UPDATE OR DELETE ON maintenance_bills FOR EACH ROW EXECUTE FUNCTION audit_row_change();
DROP TRIGGER IF EXISTS audit_owner_payouts ON owner_payouts;
CREATE TRIGGER audit_owner_payouts     AFTER INSERT OR UPDATE OR DELETE ON owner_payouts     FOR EACH ROW EXECUTE FUNCTION audit_row_change();

DROP TRIGGER IF EXISTS lease_agreements_touch ON lease_agreements;
CREATE TRIGGER lease_agreements_touch BEFORE UPDATE ON lease_agreements
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ─── 9. Indexes (tenant-leading — 001 §8) ───────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_occupants_tenant_created ON occupants (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_occupants_tenant_phone   ON occupants (tenant_id, phone);

CREATE INDEX IF NOT EXISTS idx_leases_tenant_status ON lease_agreements (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_leases_tenant_unit   ON lease_agreements (tenant_id, unit_id);
CREATE INDEX IF NOT EXISTS idx_leases_tenant_owner  ON lease_agreements (tenant_id, owner_customer_id);
-- "What expires in the next 90 days" is the one query a letting desk runs daily.
CREATE INDEX IF NOT EXISTS idx_leases_tenant_expiry ON lease_agreements (tenant_id, end_date)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_lease_inv_tenant_lease ON lease_invoices (tenant_id, lease_id, period_start DESC);
-- Collections scan: what is owed and overdue.
CREATE INDEX IF NOT EXISTS idx_lease_inv_tenant_due   ON lease_invoices (tenant_id, due_date)
  WHERE status IN ('pending', 'partially_paid');

CREATE INDEX IF NOT EXISTS idx_lease_receipts_tenant_invoice ON lease_receipts (tenant_id, lease_invoice_id);
CREATE INDEX IF NOT EXISTS idx_lease_receipts_tenant_date    ON lease_receipts (tenant_id, payment_date DESC);

CREATE INDEX IF NOT EXISTS idx_maint_tenant_unit ON maintenance_bills (tenant_id, unit_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_maint_tenant_due  ON maintenance_bills (tenant_id, due_date)
  WHERE status IN ('pending', 'partially_paid');

CREATE INDEX IF NOT EXISTS idx_payouts_tenant_status ON owner_payouts (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_payouts_tenant_lease  ON owner_payouts (tenant_id, lease_id, period_start DESC);

-- ─── 10. Permissions ────────────────────────────────────────────────────────
-- Five new keys. Mirrors PERMISSIONS in scripts/seed.ts and the role map in
-- src/services/authService.ts — all three must be changed together (see 028).
--
-- Payouts are separated from leasing because they are the point money leaves
-- the company: a letting executive should be able to run a lease end to end
-- without being able to release a payment to an owner.

INSERT INTO permissions (key, description)
SELECT k, d FROM (VALUES
  ('view_leasing',          'View leases, occupants, rent invoices and CAM bills'),
  ('manage_leasing',        'Create and amend leases, run rent/CAM billing, record receipts'),
  ('view_owner_payouts',    'View owner payout statements'),
  ('manage_owner_payouts',  'Generate and adjust owner payouts'),
  ('approve_owner_payouts', 'Approve and release an owner payout')
) AS t(k, d)
ON CONFLICT (key) DO NOTHING;

-- Additive only, system roles only — a tenant's custom role is left alone,
-- because guessing its intent would be privilege escalation, not a fix (028).
CREATE TEMP TABLE _leasing_grant (role_name text, permission_key text) ON COMMIT DROP;

INSERT INTO _leasing_grant
SELECT 'super_admin', k FROM (VALUES
  ('view_leasing'), ('manage_leasing'),
  ('view_owner_payouts'), ('manage_owner_payouts'), ('approve_owner_payouts')
) AS t(k);

-- The account owner holds every gate, including the payout release.
INSERT INTO _leasing_grant
SELECT 'builder_admin', k FROM (VALUES
  ('view_leasing'), ('manage_leasing'),
  ('view_owner_payouts'), ('manage_owner_payouts'), ('approve_owner_payouts')
) AS t(k);

INSERT INTO _leasing_grant (role_name, permission_key) VALUES
  -- Letting is a sales function: the desk that fills a unit also papers it.
  ('sales_manager',   'view_leasing'),
  ('sales_manager',   'manage_leasing'),
  -- Finance sees the money and prepares the payout — but cannot approve its
  -- own preparation. approve_owner_payouts is deliberately absent.
  ('accountant',      'view_leasing'),
  ('accountant',      'view_owner_payouts'),
  ('accountant',      'manage_owner_payouts'),
  -- Read-only everywhere, as ever.
  ('auditor',         'view_leasing'),
  ('auditor',         'view_owner_payouts');

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, g.permission_key
  FROM roles r
  JOIN _leasing_grant g ON g.role_name = r.name
 WHERE EXISTS (SELECT 1 FROM permissions p WHERE p.key = g.permission_key)
ON CONFLICT DO NOTHING;

-- ─── 11. Grants (MUST stay the last section of this file) ───────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON
  occupants, lease_agreements, lease_invoices, lease_receipts,
  maintenance_bills, owner_payouts
TO app_user;

GRANT ALL ON
  occupants, lease_agreements, lease_invoices, lease_receipts,
  maintenance_bills, owner_payouts
TO app_platform;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM permissions
   WHERE key IN ('view_leasing', 'manage_leasing', 'view_owner_payouts',
                 'manage_owner_payouts', 'approve_owner_payouts');
  RAISE NOTICE '036: leasing schema installed; % of 5 permission keys present', n;
END $$;
