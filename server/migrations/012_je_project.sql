-- ─── 012: project cost-center dimension on journal entries ──────────────────
-- The CRM ledger tags each journal entry with the project it belongs to (the
-- SPA's JournalEntry.projectId — "projects are the cost centers"), used for the
-- per-project P&L. The 004 schema modelled cost centers as a separate table the
-- SPA doesn't populate, so we add a loose project_id the ledger routes can carry
-- 1:1 (kept as text — the SPA treats it as an opaque grouping id and already
-- tolerates orphaned refs; no FK friction on projects that get archived).

ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS project_id text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_je_tenant_project ON journal_entries (tenant_id, project_id);
