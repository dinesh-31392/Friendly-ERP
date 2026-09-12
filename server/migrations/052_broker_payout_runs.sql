-- ─── 052: broker payout runs ────────────────────────────────────────────────
--
-- `commission_ledger` recorded what a broker had earned and what had been paid,
-- and that was the whole of it. There was no run: no way to take a period's
-- approved brokerage, deduct what the law requires, produce an advice the
-- broker can reconcile against, and mark the lot paid in one auditable act.
-- Builders were doing it in a spreadsheet and paying by NEFT from memory.
--
-- TWO DEDUCTIONS, PULLING OPPOSITE WAYS
--
-- GST is ADDED. A registered broker charges 18% on their brokerage and the
-- builder claims input credit. It increases the cheque.
--
-- TDS under section 194-H is SUBTRACTED. The builder deducts it from the
-- broker's payment and remits it to the government against the broker's PAN.
-- It reduces the cheque without reducing what the broker has earned.
--
-- Getting the order wrong is not a rounding difference: TDS is computed on the
-- brokerage, NOT on the GST-inclusive figure, because GST is not the broker's
-- income. Deducting on the gross overcharges the broker by 2% of the GST every
-- single run.
--
-- THE THRESHOLD IS AGGREGATE, AND IT CATCHES UP
--
-- 194-H bites on the total credited to a broker in a FINANCIAL YEAR, not on
-- each payment. A broker paid 18,000 in June with no deduction, who then earns
-- 5,000 in September, has crossed the threshold — and the deduction due now is
-- on the WHOLE 23,000, not on the 5,000. The earlier payments do not become
-- exempt because nobody deducted at the time; the shortfall is caught up in
-- the run that crosses the line, and it is the builder who is liable for it if
-- it is missed.
--
-- Rates and thresholds under 194-H are statutory and have moved twice in
-- recent years, so both are frozen per run rather than read from a constant.
-- A run must keep explaining itself under the numbers it was computed with.

CREATE TABLE IF NOT EXISTS broker_payout_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  run_no        integer NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,

  -- The financial year the threshold is measured against. Indian FY runs
  -- 1 April to 31 March, so a run in February and a run in May sit in
  -- different years and each starts the aggregate again.
  fy_start      date NOT NULL,

  tds_pct       numeric(5,2)  NOT NULL DEFAULT 2.00,
  tds_threshold numeric(14,2) NOT NULL DEFAULT 20000,

  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'approved', 'paid', 'cancelled')),

  gross_total   numeric(14,2) NOT NULL DEFAULT 0,
  gst_total     numeric(14,2) NOT NULL DEFAULT 0,
  tds_total     numeric(14,2) NOT NULL DEFAULT 0,
  net_total     numeric(14,2) NOT NULL DEFAULT 0,

  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  approved_by   uuid,
  approved_at   timestamptz,
  paid_on       date,
  payment_reference text NOT NULL DEFAULT '',

  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, run_no),
  CHECK (period_end >= period_start)
);

CREATE TABLE IF NOT EXISTS broker_payout_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL,
  broker_id     uuid NOT NULL,

  -- One line per broker per run, aggregating their commissions — that is how
  -- a payment advice reads and how the threshold is applied.
  gross_amount  numeric(14,2) NOT NULL DEFAULT 0,

  gst_pct       numeric(5,2)  NOT NULL DEFAULT 0,
  gst_amount    numeric(14,2) NOT NULL DEFAULT 0,

  -- What this broker had already been credited earlier in the same financial
  -- year, and what had already been deducted on it. Stored rather than
  -- recomputed, because the catch-up depends on the state at the moment of the
  -- run and later runs change it.
  fy_prior_gross numeric(14,2) NOT NULL DEFAULT 0,
  fy_prior_tds   numeric(14,2) NOT NULL DEFAULT 0,

  tds_pct       numeric(5,2)  NOT NULL DEFAULT 0,
  tds_amount    numeric(14,2) NOT NULL DEFAULT 0,

  net_amount    numeric(14,2) NOT NULL DEFAULT 0,

  UNIQUE (id, tenant_id),
  UNIQUE (run_id, broker_id),
  FOREIGN KEY (run_id, tenant_id)    REFERENCES broker_payout_runs (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (broker_id, tenant_id) REFERENCES brokers (id, tenant_id)
);

-- Which commissions a line paid. Kept as its own table rather than a column on
-- commission_ledger so a commission can be traced to its run and a run can be
-- reversed without losing what it covered.
CREATE TABLE IF NOT EXISTS broker_payout_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  line_id       uuid NOT NULL,
  commission_id uuid NOT NULL,
  amount        numeric(14,2) NOT NULL DEFAULT 0,

  -- A commission belongs to at most one run. Paying the same brokerage twice
  -- is the failure this prevents, and it is prevented in the schema because a
  -- payout run is exactly the code path someone will re-run "just to be sure".
  UNIQUE (commission_id),
  FOREIGN KEY (line_id, tenant_id) REFERENCES broker_payout_lines (id, tenant_id) ON DELETE CASCADE
);

ALTER TABLE broker_payout_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_payout_runs  FORCE  ROW LEVEL SECURITY;
ALTER TABLE broker_payout_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_payout_lines FORCE  ROW LEVEL SECURITY;
ALTER TABLE broker_payout_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_payout_items FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_rows ON broker_payout_runs;
CREATE POLICY tenant_rows ON broker_payout_runs  USING (tenant_id = app_current_tenant());
DROP POLICY IF EXISTS tenant_rows ON broker_payout_lines;
CREATE POLICY tenant_rows ON broker_payout_lines USING (tenant_id = app_current_tenant());
DROP POLICY IF EXISTS tenant_rows ON broker_payout_items;
CREATE POLICY tenant_rows ON broker_payout_items USING (tenant_id = app_current_tenant());

CREATE INDEX IF NOT EXISTS idx_payout_runs_tenant_created ON broker_payout_runs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payout_lines_run           ON broker_payout_lines (run_id);
CREATE INDEX IF NOT EXISTS idx_payout_items_line          ON broker_payout_items (line_id);

/**
 * The Indian financial year containing a date: 1 April to 31 March.
 *
 * The threshold is measured against this, so a run in February and a run in
 * May sit in different years and each starts the aggregate again. Getting the
 * boundary wrong understates the deduction for a whole quarter.
 */
CREATE OR REPLACE FUNCTION indian_fy_start(p_on date)
RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  SELECT make_date(
    CASE WHEN EXTRACT(MONTH FROM p_on) >= 4
         THEN EXTRACT(YEAR FROM p_on)::int
         ELSE EXTRACT(YEAR FROM p_on)::int - 1 END,
    4, 1);
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON broker_payout_runs  TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON broker_payout_lines TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON broker_payout_items TO app_user;
GRANT ALL ON broker_payout_runs  TO app_platform;
GRANT ALL ON broker_payout_lines TO app_platform;
GRANT ALL ON broker_payout_items TO app_platform;
GRANT EXECUTE ON FUNCTION indian_fy_start(date) TO app_user, app_platform;

DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM pg_constraint
   WHERE contype = 'f'
     AND confrelid = 'tenants'::regclass
     AND conrelid IN ('broker_payout_runs'::regclass, 'broker_payout_lines'::regclass,
                      'broker_payout_items'::regclass)
     AND confdeltype <> 'c';
  IF bad > 0 THEN
    RAISE EXCEPTION 'broker payout tables must cascade on tenant delete';
  END IF;
END $$;
