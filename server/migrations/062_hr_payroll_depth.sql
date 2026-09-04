-- ─── 062: what a payslip needs that the product did not hold ───────────────
--
-- Payroll produced ONE number per person: gross. `buildPayrollItemsFrom`
-- multiplied a daily wage by days present, or copied a monthly salary, and
-- stopped. That is not a payslip and it is not what leaves the bank account.
--
-- Between gross and net, an Indian construction payroll has to answer:
--
--   Overtime      site work runs late. Hours beyond the shift are paid at a
--                 multiple of the ordinary rate.
--   PF            Employees' Provident Fund. 12% of basic, employee side,
--                 matched by the employer. Statutory wage ceiling ₹15,000
--                 unless the member has opted above it.
--   ESI           Employees' State Insurance. 0.75% employee / 3.25%
--                 employer, and only while gross is at or under ₹21,000.
--   PT            Professional Tax. A state subject — Maharashtra's slab is
--                 not Karnataka's — so it is stored per employee, not
--                 computed from a table this product does not own.
--   Advances      a site worker who drew ₹5,000 mid-month is paid ₹5,000
--                 less at the end of it. Unrecovered advances are the single
--                 most common thing a paper muster roll loses.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- Income-tax (s.192) withholding. Doing it properly needs each person's
-- declared investments, regime election and year-to-date position, and a
-- wrong TDS figure is worse than none: it is deducted from a real person and
-- reconciled against a real return. The column exists so a figure computed
-- elsewhere can be recorded; nothing in this product computes it.

-- ─── Statutory identity ────────────────────────────────────────────────────
--
-- A payslip and a PF/ESI return cannot be filed without these. They were not
-- in the product at all, so payroll could be prepared and then not paid.
--
-- Aadhaar is stored as its LAST FOUR DIGITS ONLY. It is the identifier most
-- often demanded and least often needed in full: four digits confirm which
-- person a bank line refers to, and the full number would put a UIDAI-
-- regulated identifier in every backup of this table for no working benefit.

ALTER TABLE employees ADD COLUMN IF NOT EXISTS uan          text NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS esic_number  text NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pan          text NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS aadhaar_last4 text NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_account text NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_ifsc    text NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pf_opted     boolean NOT NULL DEFAULT true;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pt_monthly   numeric(10,2) NOT NULL DEFAULT 0;

-- UAN is 12 digits, ESIC 17, IFSC is four letters, a zero, six alphanumerics.
-- Each check admits the empty string, because a crew is hired before its
-- paperwork arrives and a half-filled record must still be storable.
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_uan_shape;
ALTER TABLE employees ADD CONSTRAINT employees_uan_shape
  CHECK (uan = '' OR uan ~ '^[0-9]{12}$');

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_esic_shape;
ALTER TABLE employees ADD CONSTRAINT employees_esic_shape
  CHECK (esic_number = '' OR esic_number ~ '^[0-9]{17}$');

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_pan_shape;
ALTER TABLE employees ADD CONSTRAINT employees_pan_shape
  CHECK (pan = '' OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_aadhaar_last4_shape;
ALTER TABLE employees ADD CONSTRAINT employees_aadhaar_last4_shape
  CHECK (aadhaar_last4 = '' OR aadhaar_last4 ~ '^[0-9]{4}$');

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_ifsc_shape;
ALTER TABLE employees ADD CONSTRAINT employees_ifsc_shape
  CHECK (bank_ifsc = '' OR bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$');

COMMENT ON COLUMN employees.aadhaar_last4 IS
  'Last four digits only, never the full number — enough to identify a bank '
  'line, not enough to be a UIDAI identifier sitting in every backup.';
COMMENT ON COLUMN employees.pt_monthly IS
  'Professional tax per month. A state subject with different slabs in every '
  'state, so it is recorded per employee rather than computed here.';

-- ─── Overtime, on the row that records the day ─────────────────────────────
--
-- Hours, not a rupee figure: the rate belongs to the employee and may change
-- between the day worked and the day paid. Storing money here would freeze a
-- rate onto an attendance row, which is not what an attendance row is for.

ALTER TABLE attendance ADD COLUMN IF NOT EXISTS overtime_hours numeric(5,2) NOT NULL DEFAULT 0;

ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_overtime_sane;
ALTER TABLE attendance ADD CONSTRAINT attendance_overtime_sane
  -- 16 hours of overtime in one day is not overtime, it is a typo or a
  -- wage claim nobody should be able to enter by accident.
  CHECK (overtime_hours >= 0 AND overtime_hours <= 16);

-- ─── Advances ──────────────────────────────────────────────────────────────
--
-- Money handed to a worker before payday, recovered from it. Site crews draw
-- advances constantly and it is where cash goes missing on paper systems.
--
-- `recovered` moves as payroll runs are processed and never exceeds the
-- amount — a worker cannot repay more than they took, and a bug that made
-- them appear to would take real money off a real payslip.

CREATE TABLE IF NOT EXISTS employee_advances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,

  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  recovered   numeric(14,2) NOT NULL DEFAULT 0 CHECK (recovered >= 0),

  -- How much comes off each month. 0 means "recover it all next payroll",
  -- which is the common case for a small advance.
  per_month   numeric(14,2) NOT NULL DEFAULT 0 CHECK (per_month >= 0),

  reason      text NOT NULL DEFAULT '',
  issued_on   date NOT NULL DEFAULT CURRENT_DATE,
  issued_by   uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, tenant_id),
  CONSTRAINT employee_advances_not_overrecovered CHECK (recovered <= amount),

  FOREIGN KEY (employee_id, tenant_id) REFERENCES employees (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (issued_by, tenant_id)   REFERENCES users     (id, tenant_id) ON DELETE SET NULL (issued_by)
);

ALTER TABLE employee_advances ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_advances FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_rows ON employee_advances;
CREATE POLICY tenant_rows ON employee_advances USING (tenant_id = app_current_tenant());

CREATE INDEX IF NOT EXISTS idx_employee_advances_employee
  ON employee_advances (tenant_id, employee_id);
-- Outstanding advances, which is the only question payroll asks of this table.
CREATE INDEX IF NOT EXISTS idx_employee_advances_open
  ON employee_advances (tenant_id, employee_id) WHERE recovered < amount;

GRANT SELECT, INSERT, UPDATE, DELETE ON employee_advances TO app_user;
GRANT ALL ON employee_advances TO app_platform;

-- ─── The statutory rates, so they are data and not a constant in a file ────
--
-- Wage ceilings and rates move by notification. A rate compiled into the
-- server means a payroll run cannot be reproduced after the next change:
-- re-opening last March would compute it with this March's numbers. Rows
-- carry the date they took effect, and a run resolves the row that was in
-- force for its own month.

CREATE TABLE IF NOT EXISTS statutory_rates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenants(id) ON DELETE CASCADE,

  effective_from date NOT NULL,

  pf_employee_pct numeric(5,2) NOT NULL DEFAULT 12.00,
  pf_employer_pct numeric(5,2) NOT NULL DEFAULT 12.00,
  pf_wage_ceiling numeric(14,2) NOT NULL DEFAULT 15000,

  esi_employee_pct numeric(5,2) NOT NULL DEFAULT 0.75,
  esi_employer_pct numeric(5,2) NOT NULL DEFAULT 3.25,
  esi_wage_ceiling numeric(14,2) NOT NULL DEFAULT 21000,

  -- Overtime multiple. 2.0 is the Factories Act figure and the one the BOCW
  -- rules follow for construction.
  overtime_multiple numeric(4,2) NOT NULL DEFAULT 2.00,

  created_at     timestamptz NOT NULL DEFAULT now(),

  -- tenant_id NULL is the platform default every workspace falls back to.
  UNIQUE NULLS NOT DISTINCT (tenant_id, effective_from)
);

ALTER TABLE statutory_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE statutory_rates FORCE  ROW LEVEL SECURITY;

-- The platform row (tenant_id IS NULL) is readable by everyone: it is the
-- fallback, it holds no workspace's data, and a tenant that cannot read it
-- has no rates at all.
DROP POLICY IF EXISTS tenant_rows ON statutory_rates;
CREATE POLICY tenant_rows ON statutory_rates
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant());

GRANT SELECT ON statutory_rates TO app_user;
GRANT ALL ON statutory_rates TO app_platform;

-- The rates in force at the time of writing. A workspace overrides them by
-- inserting its own row; nothing here is edited in place, because editing a
-- rate would silently restate every payroll ever run against it.
INSERT INTO statutory_rates (tenant_id, effective_from)
SELECT NULL, DATE '2014-09-01'
 WHERE NOT EXISTS (SELECT 1 FROM statutory_rates WHERE tenant_id IS NULL);

-- ─── Payroll runs carry the whole computation ──────────────────────────────
--
-- `items` already held the per-person lines. These columns hold what the run
-- totals to, so a list of runs can be read without re-adding every line, and
-- so the employer's own liability — which never appears on a payslip and is
-- real money — is recorded rather than inferred.

ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS gross_total    numeric(16,2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS deduction_total numeric(16,2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS net_total      numeric(16,2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS employer_cost  numeric(16,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN payroll_runs.employer_cost IS
  'Gross plus the employer''s own PF and ESI. What the company pays, which is '
  'more than what the workforce receives and never appears on a payslip.';

-- ─── The two HR references that block deleting a workspace ─────────────────
--
-- `leave_requests.decided_by` and `payroll_runs.processed_by` reference users
-- with NO on-delete action. So:
--
--   * the HR manager who approved a leave request can never be deleted, and
--   * deleting the TENANT fails, because the cascade tries to remove its users
--     and these two rows refuse to let go.
--
-- The second is the serious one. It is not theoretical: it is what stopped the
-- demo seeder, whose first act is to drop and recreate its own workspace. Any
-- workspace where somebody had approved one leave request could not be
-- deleted at all.
--
-- SET NULL, not CASCADE. The decision was made and the run was processed;
-- those facts survive the person leaving. What is lost is only the name
-- attached to them, which is the correct thing to lose when the account is
-- deleted rather than deactivated.
--
-- THIRTY-FOUR MORE LIKE THIS
--
-- The same omission exists on 34 other user references across bookings,
-- invoices, journal entries, purchase orders, quotations, vendor bills and
-- more. They are the same one-line fix and the same consequence. Only the two
-- HR ones are corrected here, because this migration is the HR module and a
-- schema-wide sweep deserves its own change and its own verification.

ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_decided_by_fkey;
ALTER TABLE leave_requests
  ADD CONSTRAINT leave_requests_decided_by_fkey
  FOREIGN KEY (decided_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (decided_by);

ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_processed_by_fkey;
ALTER TABLE payroll_runs
  ADD CONSTRAINT payroll_runs_processed_by_fkey
  FOREIGN KEY (processed_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (processed_by);

-- ─── Proof ─────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'employee_advances') THEN
    RAISE EXCEPTION 'employee_advances was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'statutory_rates') THEN
    RAISE EXCEPTION 'statutory_rates was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM statutory_rates WHERE tenant_id IS NULL) THEN
    RAISE EXCEPTION 'the platform default rates were not seeded';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'attendance' AND column_name = 'overtime_hours'
  ) THEN
    RAISE EXCEPTION 'attendance.overtime_hours was not added';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'employees' AND column_name = 'uan'
  ) THEN
    RAISE EXCEPTION 'the statutory identity columns were not added';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname IN ('leave_requests_decided_by_fkey', 'payroll_runs_processed_by_fkey')
       AND pg_get_constraintdef(oid) NOT LIKE '%ON DELETE%'
  ) THEN
    RAISE EXCEPTION 'a workspace still cannot be deleted — an HR user reference has no on-delete action';
  END IF;
END $$;
