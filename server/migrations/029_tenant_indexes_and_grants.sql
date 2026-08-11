-- 029: composite indexes led by tenant_id, and drop a privilege the app never needs.
--
-- WHY THE INDEXES
--
-- Under row-level security every read carries an implicit
-- `WHERE tenant_id = app_current_tenant()`. Without an index LEADING on
-- tenant_id, Postgres has no way to jump straight to one tenant's rows — it
-- scans the whole table and discards everyone else's. With a single tenant in
-- development that is invisible. With two hundred tenants sharing a table, each
-- one pays to read past the other 199, and that cost lands on the shared
-- connection pool where it becomes everybody's problem.
--
-- The second column in each index is the one that table is actually queried by
-- (checked against the ORDER BY / WHERE clauses in src/routes), so these serve
-- the sort as well as the tenant filter and the planner can skip the sort step
-- entirely.
--
-- Plain CREATE INDEX, not CONCURRENTLY: migrate.ts wraps each migration in a
-- transaction and CONCURRENTLY cannot run inside one. These tables are small
-- pre-launch so the brief write lock is free. If you ever add an index to a
-- large live table, do it by hand with CONCURRENTLY and outside the runner.

-- ── Directories: sorted by name ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_vendors_tenant_name        ON vendors        (tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_employees_tenant_name      ON employees      (tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_materials_tenant_name      ON materials      (tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_machines_tenant_name       ON machines       (tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_towers_tenant_name         ON towers         (tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_cost_centers_tenant_name   ON cost_centers   (tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_tenant_name  ON bank_accounts  (tenant_id, account_name);

-- brokers is read by id far more than listed, but the tenant guard still needs
-- a leading tenant_id to avoid the scan; name keeps the directory view sorted.
CREATE INDEX IF NOT EXISTS idx_brokers_tenant_name        ON brokers        (tenant_id, name);

-- ── Time-ordered feeds: newest first ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_customers_tenant_created   ON customers      (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_reports_tenant_created ON market_reports (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loans_tenant_start         ON loans          (tenant_id, start_date DESC);
CREATE INDEX IF NOT EXISTS idx_export_jobs_tenant_created ON export_jobs    (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_batches_tenant_created ON import_batches (tenant_id, created_at DESC);

-- ── Child rows: always fetched through their parent ─────────────────────────
-- Three columns so the index answers the whole predicate: tenant guard, the
-- parent filter, then the sort.
CREATE INDEX IF NOT EXISTS idx_inspections_tenant_project_date
  ON inspections (tenant_id, project_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_progress_updates_tenant_project_date
  ON progress_updates (tenant_id, project_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_land_documents_tenant_lead_created
  ON land_documents (tenant_id, land_lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feasibility_tenant_lead_computed
  ON feasibility_records (tenant_id, land_lead_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_bill_lines_tenant_bill
  ON vendor_bill_line_items (tenant_id, vendor_bill_id);
CREATE INDEX IF NOT EXISTS idx_budget_revisions_tenant_budget
  ON budget_revisions (tenant_id, budget_id);
CREATE INDEX IF NOT EXISTS idx_import_rows_tenant_batch
  ON import_rows_staging (tenant_id, batch_id);

-- ── Drop a privilege the runtime never uses ─────────────────────────────────
--
-- app_user held INSERT/UPDATE/DELETE on _migrations. Only the migrator writes
-- that table, and the migrator connects as the admin role. Leaving the grant in
-- place means any flaw that reaches arbitrary SQL through the application could
-- forge or erase schema history — and a later migration would then run against
-- a database it believes is in a state it is not, which is how a routine deploy
-- turns destructive.
--
-- SELECT stays: a health check that reports the applied schema version is
-- reasonable, and reading the ledger leaks nothing.
REVOKE INSERT, UPDATE, DELETE ON _migrations FROM app_user;
