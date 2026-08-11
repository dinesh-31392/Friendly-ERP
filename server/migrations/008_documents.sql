-- ─── 008: documents (deal/project document register) ───────────────────────
-- The CRM UI keeps a document register (brochures, agreements, KYC, …) that had
-- no server table — it lived only in the browser store. This is a greenfield
-- table shaped 1:1 to the SPA `Document` type so the documents API can persist
-- it. `date` and `size` are display strings the UI already formats (e.g.
-- "2.4 MB", "12 Aug 2026"); we store them verbatim rather than re-deriving.

CREATE TABLE IF NOT EXISTS documents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  type       text NOT NULL DEFAULT '',
  project    text NOT NULL DEFAULT '',
  doc_date   text NOT NULL DEFAULT '',   -- SPA Document.date (display string)
  size       text NOT NULL DEFAULT '',   -- SPA Document.size (display string)
  status     text NOT NULL DEFAULT '',
  url        text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS: FORCE + tenant policy, matching every other tenant table (003 §9).
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON documents;
CREATE POLICY tenant_rows ON documents USING (tenant_id = app_current_tenant());

CREATE INDEX idx_documents_tenant_created ON documents (tenant_id, created_at DESC);

-- 001's blanket GRANT ran before this table existed, so grant it explicitly
-- (see 003 §12).
GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO app_user;
GRANT ALL ON documents TO app_platform;
