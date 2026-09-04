-- ─── 061: HR, one project at a time ────────────────────────────────────────
--
-- A builder runs several sites at once. Each has its own crew, its own
-- supervisor, its own muster roll and — this is the part the product got
-- wrong — its own HR manager.
--
-- Until now every HR key was company-wide. `manage_hr` let a person read,
-- edit and pay ANY employee in the workspace. A builder with four projects
-- and four site HR managers had no way to say "you look after Skyline, you
-- look after Riverfront": all four saw all four crews, all four salaries and
-- all four payrolls.
--
-- WHAT THIS ADDS
--
--   app_project_ids()  the posting, readable from SQL.
--   app_hr_all()       whether this person is company-wide anyway.
--   payroll_runs.project_id  so a run belongs to a site, and labour cost
--                            lands against the project that incurred it.
--
-- WHAT IT DOES NOT ADD, DELIBERATELY
--
-- A table. `user_project_assignments` has been in the schema since migration
-- 003 — RLS enabled, both legs tenant-scoped, described in its own comment as
-- "project-level scoping for front-line staff". It had no rows and no route
-- ever wrote to it: the table was built and then never connected to anything.
-- This migration connects it rather than adding a second table that means the
-- same thing, which is how a schema ends up with two answers to one question.
--
-- THE RULE, AND WHY IT IS SHAPED THIS WAY
--
--   no assignments        company-wide. This is deliberate and it is what
--                         makes the change safe: the table has no rows at
--                         all today, so nothing narrows until somebody
--                         chooses to narrow it.
--   one or more           restricted to exactly those projects.
--   manage_hr_all         company-wide regardless. For the HR head, who may
--                         also be posted to a site for other modules and
--                         must not be narrowed by that posting.
--
-- Read it as: an unassigned manager is company-wide, not blind. The opposite
-- default would lock every existing workspace out of its own HR on upgrade.
--
-- HEAD OFFICE IS NOT A PROJECT
--
-- Employees with project_id IS NULL are head office — accountants, sales,
-- the people who do not belong to a site. A site HR manager does not see
-- them, because they are not that manager's crew. Only a company-wide reader
-- does. This is why the scope test is `project_id = ANY(...)` and not
-- `project_id IS NULL OR project_id = ANY(...)`.

-- What the posting is FOR. A person may be on a site to run execution and
-- have nothing to do with its HR; the column records the intent so a later
-- module can ask a narrower question than "is this person on this site".
ALTER TABLE user_project_assignments
  ADD COLUMN IF NOT EXISTS role_note text NOT NULL DEFAULT '';

-- 003 created the table but never granted on it, because nothing read it.
GRANT SELECT, INSERT, UPDATE, DELETE ON user_project_assignments TO app_user;
GRANT ALL ON user_project_assignments TO app_platform;

CREATE INDEX IF NOT EXISTS idx_upa_user
  ON user_project_assignments (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_upa_project
  ON user_project_assignments (tenant_id, project_id);

-- `assigned_by` blocks deleting the user who made the posting, and through
-- the tenant cascade it blocks deleting the WORKSPACE. Every other user
-- reference in this schema uses SET NULL for exactly this reason.
ALTER TABLE user_project_assignments
  DROP CONSTRAINT IF EXISTS user_project_assignments_assigned_by_fkey;
ALTER TABLE user_project_assignments
  ADD CONSTRAINT user_project_assignments_assigned_by_fkey
  FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL;

-- ─── The posting, readable from SQL ────────────────────────────────────────
--
-- SECURITY DEFINER with a pinned search_path, for the same reason
-- has_permission is: it is called from inside queries that run as app_user,
-- and pg_temp must come last so nothing can shadow the table it reads.
--
-- Returns an EMPTY ARRAY for a person with no postings — not NULL. Callers
-- test cardinality (`array_length(...) IS NULL` vs `> 0`), and a NULL here
-- would silently turn `project_id = ANY(NULL)` into "no rows" — the exact
-- opposite of the intended "no restriction".

CREATE OR REPLACE FUNCTION app_project_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT COALESCE(array_agg(up.project_id), ARRAY[]::uuid[])
    FROM user_project_assignments up
   WHERE up.user_id   = app_current_user()
     AND up.tenant_id = app_current_tenant()
$$;

-- Whether this reader sees the whole company.
--
--   manage_hr_all    the HR head, explicitly.
--   view_audit_log   the auditor. Auditing three sites out of four is not
--                    auditing.
--   no postings      nobody has narrowed them, so they are not narrowed.
CREATE OR REPLACE FUNCTION app_hr_all() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT has_permission('manage_hr_all')
      OR has_permission('view_audit_log')
      OR cardinality(app_project_ids()) = 0
$$;

REVOKE ALL ON FUNCTION app_project_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_hr_all()      FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_project_ids() TO app_user, app_platform;
GRANT EXECUTE ON FUNCTION app_hr_all()      TO app_user, app_platform;

-- ─── The new permission ────────────────────────────────────────────────────

INSERT INTO permissions (key, description) VALUES
  ('manage_hr_all', 'See and manage HR across every project, not only assigned sites')
ON CONFLICT (key) DO NOTHING;

-- Granted to the roles that must never be narrowed by a site posting.
-- Deliberately NOT granted to hr_manager: a company HR manager already sees
-- everything by having no postings, and one that IS posted to a site is
-- exactly the case this migration exists to serve.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key
  FROM roles r
  CROSS JOIN (VALUES ('manage_hr_all')) AS p(key)
 WHERE r.is_system
   AND r.name IN ('builder_admin', 'auditor')
ON CONFLICT DO NOTHING;

-- ─── A payroll run belongs to a site ───────────────────────────────────────
--
-- `project_id IS NULL` is the company-wide run, which is what every existing
-- row is and what a single-site builder will keep using.
--
-- The uniqueness has to move with it. UNIQUE (tenant_id, month) allowed one
-- run a month for the whole workspace; four sites need four. NULLS NOT
-- DISTINCT (PG15+) is required, because without it the NULL project_id of a
-- company-wide run never collides with itself and a workspace could create
-- an unlimited number of runs for the same month.

ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS project_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'payroll_runs'::regclass
       AND conname  = 'payroll_runs_project_fkey'
  ) THEN
    ALTER TABLE payroll_runs
      ADD CONSTRAINT payroll_runs_project_fkey
      FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id)
      ON DELETE SET NULL (project_id);
  END IF;
END $$;

ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_tenant_id_month_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'payroll_runs'::regclass
       AND conname  = 'payroll_runs_tenant_month_project_key'
  ) THEN
    ALTER TABLE payroll_runs
      ADD CONSTRAINT payroll_runs_tenant_month_project_key
      UNIQUE NULLS NOT DISTINCT (tenant_id, month, project_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payroll_runs_project
  ON payroll_runs (tenant_id, project_id, month DESC);

COMMENT ON COLUMN payroll_runs.project_id IS
  'The site this run pays. NULL is the company-wide run — head office, or a '
  'builder who does not split payroll by project.';

-- ─── Proof ─────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'user_project_assignments' AND column_name = 'role_note'
  ) THEN
    RAISE EXCEPTION 'user_project_assignments.role_note was not added';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_project_ids') THEN
    RAISE EXCEPTION 'app_project_ids() was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_hr_all') THEN
    RAISE EXCEPTION 'app_hr_all() was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'payroll_runs' AND column_name = 'project_id'
  ) THEN
    RAISE EXCEPTION 'payroll_runs.project_id was not added';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE key = 'manage_hr_all') THEN
    RAISE EXCEPTION 'manage_hr_all was not catalogued';
  END IF;
END $$;
