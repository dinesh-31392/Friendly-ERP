-- ============================================================================
-- FRIENDLY ERP — Finance schema (Friendly Finance addendum): chart of
-- accounts, double-entry journal, vendors & bills, contractor RA billing,
-- AP payments, budgets, bank reconciliation, tax postings, loans.
--
-- The addendum's database-level rules are enforced HERE:
--   • a journal entry cannot COMMIT as 'posted' unless Σdebit = Σcredit
--     (deferred constraint trigger — valid regardless of insert order)
--   • lines of a posted entry are immutable; posted never reverts to draft
--   • contractor_ra_bills.ra_number is unique per (vendor, project)
--   • payments_made settles exactly one of vendor_bill / ra_bill
-- Conventions as in 001/003: FORCE RLS, composite tenant FKs, grants last.
-- ============================================================================

-- ─── 1. Chart of accounts & cost centers ────────────────────────────────────

CREATE TABLE chart_of_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code              text NOT NULL,             -- '4000'
  name              text NOT NULL,
  account_type      text NOT NULL
                    CHECK (account_type IN ('asset', 'liability', 'income', 'expense', 'equity')),
  parent_account_id uuid REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  is_system         boolean NOT NULL DEFAULT false,  -- seeded accounts auto-posting relies on
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, code)
);

-- Cost centers are usually per-project; tenant-level (HQ) ones have NULL project
CREATE TABLE cost_centers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid,
  name       text NOT NULL,
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);

-- ─── 2. Journal: entries + lines, balance enforced at COMMIT ────────────────

CREATE TABLE journal_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_date     date NOT NULL DEFAULT CURRENT_DATE,
  reference      text,
  narration      text NOT NULL,
  source_type    text NOT NULL DEFAULT 'manual'
                 CHECK (source_type IN ('manual', 'vendor_bill', 'ra_bill', 'customer_payment',
                                        'ap_payment', 'payroll', 'system')),
  source_id      uuid,                        -- polymorphic link to the origin record
  cost_center_id uuid,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'reversed')),
  created_by     uuid REFERENCES users(id),
  posted_by      uuid REFERENCES users(id),
  posted_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (cost_center_id, tenant_id) REFERENCES cost_centers (id, tenant_id) ON DELETE SET NULL (cost_center_id)
);

CREATE TABLE journal_entry_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,             -- denormalized: RLS + composite FKs
  journal_entry_id uuid NOT NULL,
  account_id       uuid NOT NULL,
  cost_center_id   uuid,
  debit            numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit           numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  note             text,
  -- exactly one side per line — mixed lines make statements unreadable
  CHECK (debit = 0 OR credit = 0),
  CHECK (debit > 0 OR credit > 0),
  FOREIGN KEY (journal_entry_id, tenant_id) REFERENCES journal_entries (id, tenant_id)   ON DELETE CASCADE,
  -- Deferred: on tenant teardown these lines die via their entry's cascade,
  -- and the account check must wait for that (cascade diamond via tenants).
  FOREIGN KEY (account_id, tenant_id)       REFERENCES chart_of_accounts (id, tenant_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (cost_center_id, tenant_id)   REFERENCES cost_centers (id, tenant_id) ON DELETE SET NULL (cost_center_id)
);

-- Balance rule. A DEFERRED constraint trigger validates at COMMIT, so any
-- insert order works (header-then-lines, lines-then-post, single statement)
-- while an unbalanced 'posted' entry can never survive a transaction.
--
-- One checker + one thin wrapper PER TABLE. A single trigger function shared
-- by two tables is a plpgsql trap: NEW/OLD are cached per-function with the
-- FIRST caller's rowtype, so the second table's rows blow up with
-- `record "new" has no field …` (reproduced against PostgreSQL 18 here).
CREATE OR REPLACE FUNCTION check_je_balanced(p_entry uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_dr numeric;
  v_cr numeric;
  v_count int;
BEGIN
  SELECT status INTO v_status FROM journal_entries WHERE id = p_entry;
  IF v_status IS NULL OR v_status = 'draft' THEN RETURN; END IF;
  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0), count(*)
    INTO v_dr, v_cr, v_count
    FROM journal_entry_lines WHERE journal_entry_id = p_entry;
  IF v_count < 2 THEN
    RAISE EXCEPTION 'journal entry % is % with fewer than two lines', p_entry, v_status
      USING ERRCODE = '23514';
  END IF;
  IF v_dr <> v_cr THEN
    RAISE EXCEPTION 'journal entry % does not balance: debits % <> credits %', p_entry, v_dr, v_cr
      USING ERRCODE = '23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION trg_je_balanced_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- INSERT/UPDATE only (no DELETE trigger on entries), so NEW is always set
  PERFORM check_je_balanced(NEW.id);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION trg_je_balanced_line() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM check_je_balanced(OLD.journal_entry_id);
  ELSE
    PERFORM check_je_balanced(NEW.journal_entry_id);
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER je_balanced_entries
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_je_balanced_entry();

CREATE CONSTRAINT TRIGGER je_balanced_lines
  AFTER INSERT OR UPDATE OR DELETE ON journal_entry_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_je_balanced_line();

-- Immutability: a posted entry's lines cannot be edited or removed, and a
-- posted entry cannot slip back to draft (reversal is the only way out).
CREATE OR REPLACE FUNCTION forbid_posted_line_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM journal_entries
    WHERE id = COALESCE(OLD.journal_entry_id, NEW.journal_entry_id);
  IF v_status = 'posted' THEN
    RAISE EXCEPTION 'lines of a posted journal entry are immutable — reverse the entry instead'
      USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER je_lines_immutable
  BEFORE UPDATE OR DELETE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_line_change();

CREATE OR REPLACE FUNCTION forbid_unposting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'a posted journal entry cannot return to draft — reverse it'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER je_no_unpost
  BEFORE UPDATE OF status ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_unposting();

-- ─── 3. Vendors, bills, RA billing, AP payments ─────────────────────────────

CREATE TABLE vendors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  vendor_type  text NOT NULL DEFAULT 'supplier'
               CHECK (vendor_type IN ('supplier', 'contractor', 'service_provider')),
  tax_id       text,                          -- GSTIN or local equivalent
  bank_details jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'blacklisted', 'inactive')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE TABLE vendor_bills (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor_id         uuid NOT NULL,
  project_id        uuid,
  purchase_order_id uuid,                     -- Procurement link (browser-store today)
  bill_no           text NOT NULL DEFAULT '',
  bill_date         date NOT NULL DEFAULT CURRENT_DATE,
  due_date          date,
  amount            numeric(14,2) NOT NULL,
  tax_amount        numeric(14,2) NOT NULL DEFAULT 0,
  total_amount      numeric(14,2) NOT NULL,
  status            text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'submitted', 'approved', 'paid', 'disputed')),
  approved_by       uuid REFERENCES users(id),
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (vendor_id, tenant_id)  REFERENCES vendors (id, tenant_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE SET NULL (project_id)
);

CREATE TABLE vendor_bill_line_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  vendor_bill_id uuid NOT NULL,
  description    text NOT NULL,
  quantity       numeric(12,3) NOT NULL DEFAULT 1,
  unit_rate      numeric(14,2) NOT NULL DEFAULT 0,
  amount         numeric(14,2) NOT NULL,
  account_id     uuid,                        -- which expense account this hits
  FOREIGN KEY (vendor_bill_id, tenant_id) REFERENCES vendor_bills (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, tenant_id)     REFERENCES chart_of_accounts (id, tenant_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE contractor_ra_bills (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor_id                uuid NOT NULL,     -- vendor_type = 'contractor'
  project_id               uuid NOT NULL,
  ra_number                integer NOT NULL,  -- sequential per contractor per project
  work_progress_percentage numeric(5,2) NOT NULL CHECK (work_progress_percentage BETWEEN 0 AND 100),
  site_progress_percentage numeric(5,2),      -- Execution's logged % at submission
  override_reason          text,              -- required when claim exceeds site log
  gross_amount             numeric(14,2) NOT NULL,
  retention_amount         numeric(14,2) NOT NULL DEFAULT 0,
  deductions               jsonb NOT NULL DEFAULT '[]',  -- [{ "label": "TDS", "amount": ... }]
  net_payable              numeric(14,2) NOT NULL CHECK (net_payable >= 0),
  -- Two-stage approval by design: site/PMC verification, THEN finance.
  pmc_approved_by          uuid REFERENCES users(id),
  finance_approved_by      uuid REFERENCES users(id),
  status                   text NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'submitted', 'pmc_approved', 'finance_approved', 'paid')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  -- Addendum: ra_number unique per (vendor, project) — tenant-led for RLS-friendly lookups
  UNIQUE (tenant_id, vendor_id, project_id, ra_number),
  FOREIGN KEY (vendor_id, tenant_id)  REFERENCES vendors (id, tenant_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE payments_made (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor_bill_id         uuid,
  contractor_ra_bill_id  uuid,
  amount                 numeric(14,2) NOT NULL CHECK (amount > 0),
  payment_date           date NOT NULL DEFAULT CURRENT_DATE,
  mode                   text NOT NULL DEFAULT 'bank_transfer'
                         CHECK (mode IN ('cheque', 'bank_transfer', 'upi', 'cash')),
  reference_no           text,
  paid_by                uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  -- Exactly one of the two references is set
  CHECK ((vendor_bill_id IS NULL) <> (contractor_ra_bill_id IS NULL)),
  FOREIGN KEY (vendor_bill_id, tenant_id)        REFERENCES vendor_bills (id, tenant_id)        ON DELETE SET NULL (vendor_bill_id),
  FOREIGN KEY (contractor_ra_bill_id, tenant_id) REFERENCES contractor_ra_bills (id, tenant_id) ON DELETE SET NULL (contractor_ra_bill_id)
);

-- ─── 4. Budgets ─────────────────────────────────────────────────────────────

CREATE TABLE budgets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id       uuid NOT NULL,
  budget_code      text NOT NULL DEFAULT '',
  category         text NOT NULL,             -- 'Civil Works', 'MEP', 'Marketing'
  fiscal_year      text NOT NULL DEFAULT '',
  allocated_amount numeric(14,2) NOT NULL,
  cost_center_id   uuid,                      -- actuals roll up via journal_entry_lines
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id)     REFERENCES projects (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (cost_center_id, tenant_id) REFERENCES cost_centers (id, tenant_id) ON DELETE SET NULL (cost_center_id)
);

CREATE TABLE budget_revisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  budget_id      uuid NOT NULL,
  revised_amount numeric(14,2) NOT NULL,
  reason         text NOT NULL,
  approved_by    uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (budget_id, tenant_id) REFERENCES budgets (id, tenant_id) ON DELETE CASCADE
);

-- ─── 5. Bank accounts & reconciliation ──────────────────────────────────────

CREATE TABLE bank_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_name    text NOT NULL,
  account_number  text,
  bank_name       text,
  opening_balance numeric(14,2) NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE TABLE bank_transactions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL,
  bank_account_id          uuid NOT NULL,
  txn_date                 date NOT NULL,
  description              text NOT NULL DEFAULT '',
  amount                   numeric(14,2) NOT NULL CHECK (amount > 0),
  txn_type                 text NOT NULL CHECK (txn_type IN ('debit', 'credit')),
  reconciled               boolean NOT NULL DEFAULT false,
  matched_journal_entry_id uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (bank_account_id, tenant_id)          REFERENCES bank_accounts (id, tenant_id)   ON DELETE CASCADE,
  FOREIGN KEY (matched_journal_entry_id, tenant_id) REFERENCES journal_entries (id, tenant_id) ON DELETE SET NULL (matched_journal_entry_id)
);

-- A journal entry settles at most one statement line
CREATE UNIQUE INDEX bank_txn_one_match_per_je
  ON bank_transactions (matched_journal_entry_id) WHERE matched_journal_entry_id IS NOT NULL;

-- 003 declared payments.bank_transaction_id ahead of this table — add the FK now
ALTER TABLE payments
  ADD CONSTRAINT payments_bank_txn_fk
  FOREIGN KEY (bank_transaction_id, tenant_id)
  REFERENCES bank_transactions (id, tenant_id) ON DELETE SET NULL (bank_transaction_id);

-- ─── 6. Tax postings ────────────────────────────────────────────────────────

CREATE TABLE tax_postings (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tax_type  text NOT NULL CHECK (tax_type IN ('gst', 'tds', 'other')),
  period    text NOT NULL,                    -- '2026-Q2', '2026-07'
  amount    numeric(14,2) NOT NULL,
  status    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'filed', 'paid')),
  filed_by  uuid REFERENCES users(id),
  filed_at  timestamptz,
  UNIQUE (tenant_id, tax_type, period)
);

-- ─── 7. Loans ───────────────────────────────────────────────────────────────

CREATE TABLE loans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id       uuid,
  lender_name      text NOT NULL,
  loan_type        text NOT NULL DEFAULT 'term_loan'
                   CHECK (loan_type IN ('term_loan', 'overdraft', 'mortgage', 'inter_company')),
  principal_amount numeric(14,2) NOT NULL CHECK (principal_amount > 0),
  interest_rate    numeric(6,3) NOT NULL DEFAULT 0,
  start_date       date NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'defaulted')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE SET NULL (project_id)
);

CREATE TABLE loan_repayment_schedule (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  loan_id             uuid NOT NULL,
  installment_no      integer NOT NULL,
  due_date            date NOT NULL,
  principal_component numeric(14,2) NOT NULL DEFAULT 0,
  interest_component  numeric(14,2) NOT NULL DEFAULT 0,
  tds_deducted        numeric(14,2) NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'overdue')),
  UNIQUE (loan_id, installment_no),
  FOREIGN KEY (loan_id, tenant_id) REFERENCES loans (id, tenant_id) ON DELETE CASCADE
);

-- ─── 8. RLS, audit, indexes ─────────────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'chart_of_accounts', 'cost_centers', 'journal_entries', 'journal_entry_lines',
    'vendors', 'vendor_bills', 'vendor_bill_line_items', 'contractor_ra_bills',
    'payments_made', 'budgets', 'budget_revisions', 'bank_accounts',
    'bank_transactions', 'tax_postings', 'loans', 'loan_repayment_schedule'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_rows ON %I', t);
    EXECUTE format('CREATE POLICY tenant_rows ON %I USING (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

CREATE TRIGGER audit_journal_entries AFTER INSERT OR UPDATE OR DELETE ON journal_entries    FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_vendor_bills    AFTER INSERT OR UPDATE OR DELETE ON vendor_bills       FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_ra_bills        AFTER INSERT OR UPDATE OR DELETE ON contractor_ra_bills FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_payments_made   AFTER INSERT OR UPDATE OR DELETE ON payments_made      FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_budgets         AFTER INSERT OR UPDATE OR DELETE ON budgets            FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_loans           AFTER INSERT OR UPDATE OR DELETE ON loans              FOR EACH ROW EXECUTE FUNCTION audit_row_change();

CREATE INDEX idx_coa_tenant_type        ON chart_of_accounts (tenant_id, account_type) WHERE is_active;
CREATE INDEX idx_je_tenant_date         ON journal_entries (tenant_id, entry_date DESC);
CREATE INDEX idx_je_tenant_source       ON journal_entries (tenant_id, source_type, source_id);
CREATE INDEX idx_jel_tenant_entry       ON journal_entry_lines (tenant_id, journal_entry_id);
CREATE INDEX idx_jel_tenant_account     ON journal_entry_lines (tenant_id, account_id);
CREATE INDEX idx_jel_tenant_costcenter  ON journal_entry_lines (tenant_id, cost_center_id);  -- budget-vs-actual rollup
CREATE INDEX idx_vbills_tenant_status   ON vendor_bills (tenant_id, status);
CREATE INDEX idx_rabills_tenant_status  ON contractor_ra_bills (tenant_id, status);
CREATE INDEX idx_paymade_tenant_date    ON payments_made (tenant_id, payment_date DESC);
CREATE INDEX idx_budgets_tenant_project ON budgets (tenant_id, project_id);
CREATE INDEX idx_banktxn_unreconciled   ON bank_transactions (tenant_id, bank_account_id) WHERE NOT reconciled;
CREATE INDEX idx_loansched_tenant_due   ON loan_repayment_schedule (tenant_id, due_date) WHERE status = 'pending';

-- ─── 9. Grants (MUST stay the last section of this file) ────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON
  chart_of_accounts, cost_centers, journal_entries, journal_entry_lines,
  vendors, vendor_bills, vendor_bill_line_items, contractor_ra_bills,
  payments_made, budgets, budget_revisions, bank_accounts, bank_transactions,
  tax_postings, loans, loan_repayment_schedule
TO app_user;

GRANT ALL ON
  chart_of_accounts, cost_centers, journal_entries, journal_entry_lines,
  vendors, vendor_bills, vendor_bill_line_items, contractor_ra_bills,
  payments_made, budgets, budget_revisions, bank_accounts, bank_transactions,
  tax_postings, loans, loan_repayment_schedule
TO app_platform;
