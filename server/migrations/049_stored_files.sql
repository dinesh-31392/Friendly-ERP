-- ─── 049: real file storage ────────────────────────────────────────────────
--
-- The documents module was a register, not a repository. `documents.url` is a
-- text column and there was no upload endpoint anywhere in the API, so the only
-- way to attach an agreement to a booking was to host the PDF somewhere else
-- and paste a link. Every KYC document, allotment letter and RA bill in the
-- product therefore lived outside it — which defeats the audit trail the
-- register exists to provide, and means a customer file cannot be produced on
-- demand from the system of record.
--
-- This is the metadata half. Bytes live on disk under FILE_STORAGE_DIR, keyed
-- by a server-generated path that no client value ever reaches; the row is what
-- makes a file findable, permissioned and tenant-scoped.
--
-- One table, many owners. Documents needs it first, but land title deeds,
-- booking KYC, vendor invoices and snag photos all want the same thing, and a
-- per-module blob column would mean five upload paths to secure instead of one.

CREATE TABLE IF NOT EXISTS stored_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Path relative to FILE_STORAGE_DIR, generated from a uuid. The uploader's
  -- filename never appears here: it is attacker-controlled and would carry
  -- `../` and NUL bytes straight into a path join.
  storage_key   text NOT NULL UNIQUE,

  -- What the uploader called it. Display only — echoed back in
  -- Content-Disposition, never used to build a path.
  original_name text NOT NULL,

  -- The type the CLIENT declared. Untrusted: the download route decides for
  -- itself what Content-Type to serve, and anything outside a small
  -- safe-to-inline set goes out as an octet-stream attachment.
  content_type  text NOT NULL DEFAULT 'application/octet-stream',

  size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),

  -- Integrity, and the basis for de-duplication later. Computed server-side
  -- from the bytes actually written, not supplied by the client.
  sha256        text NOT NULL,

  uploaded_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, tenant_id),
  FOREIGN KEY (uploaded_by, tenant_id) REFERENCES users (id, tenant_id)
);

ALTER TABLE stored_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE stored_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON stored_files;
CREATE POLICY tenant_rows ON stored_files USING (tenant_id = app_current_tenant());

CREATE INDEX IF NOT EXISTS idx_stored_files_tenant_created
  ON stored_files (tenant_id, created_at DESC);

-- Attach a stored file to a register entry. Nullable, because the register
-- keeps its existing rows: a document that is only a link is still a document,
-- and 008's `url` column keeps working for them.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_id uuid;

DO $$ BEGIN
  ALTER TABLE documents
    ADD CONSTRAINT documents_file_tenant_fk
    FOREIGN KEY (file_id, tenant_id) REFERENCES stored_files (id, tenant_id)
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The composite FK is the point: a plain `REFERENCES stored_files(id)` would
-- let a row in tenant A cite a file belonging to tenant B, and the download
-- route resolves the file through the document. Carrying tenant_id into the
-- reference makes that impossible at the storage layer rather than relying on
-- every handler to re-check.

-- 001's blanket GRANT ran before this table existed (see 003 §12).
GRANT SELECT, INSERT, UPDATE, DELETE ON stored_files TO app_user;
GRANT ALL ON stored_files TO app_platform;

-- Deleting a workspace must not be blocked by its files (see 048).
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM pg_constraint
   WHERE contype = 'f'
     AND confrelid = 'tenants'::regclass
     AND conrelid  = 'stored_files'::regclass
     AND confdeltype <> 'c';
  IF bad > 0 THEN
    RAISE EXCEPTION 'stored_files.tenant_id must cascade on tenant delete';
  END IF;
END $$;
