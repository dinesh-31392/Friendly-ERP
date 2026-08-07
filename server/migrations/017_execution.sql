-- ─── 017: Site execution (construction) ────────────────────────────────────
-- Site tasks & milestones, daily progress updates, RFIs, change orders, and
-- inspections. Previously localStorage-only; site milestones here are what the
-- construction-linked demand automation reads. FORCE RLS + grants per table.

CREATE TABLE IF NOT EXISTS site_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL,
  title        text NOT NULL,
  description  text,
  is_milestone boolean NOT NULL DEFAULT false,
  start_date   date,
  due_date     date NOT NULL DEFAULT CURRENT_DATE,
  completed_at timestamptz,
  status       text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'blocked', 'done')),
  progress     integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  assigned_to  uuid,
  depends_on   jsonb NOT NULL DEFAULT '[]',    -- array of site_task ids
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id)  REFERENCES projects (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_to, tenant_id) REFERENCES users (id, tenant_id)    ON DELETE SET NULL (assigned_to)
);

CREATE TABLE IF NOT EXISTS progress_updates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  project_id uuid NOT NULL,
  user_id    uuid,
  date       date NOT NULL DEFAULT CURRENT_DATE,
  summary    text NOT NULL DEFAULT '',
  workforce  integer,
  photos     jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rfis (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  project_id  uuid NOT NULL,
  number      integer NOT NULL,
  subject     text NOT NULL DEFAULT '',
  question    text NOT NULL DEFAULT '',
  raised_by   uuid,
  assigned_to uuid,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  answer      text,
  answered_at timestamptz,
  due_date    date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, number),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS change_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  project_id       uuid NOT NULL,
  number           integer NOT NULL,
  title            text NOT NULL DEFAULT '',
  reason           text NOT NULL DEFAULT '',
  cost_impact      numeric(14,2) NOT NULL DEFAULT 0,   -- signed
  time_impact_days integer NOT NULL DEFAULT 0,         -- signed
  status           text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'approved', 'rejected')),
  requested_by     uuid,
  decided_by       uuid,
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, number),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inspections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  project_id   uuid NOT NULL,
  type         text NOT NULL DEFAULT 'quality' CHECK (type IN ('quality', 'safety')),
  title        text NOT NULL DEFAULT '',
  date         date NOT NULL DEFAULT CURRENT_DATE,
  inspector_id uuid,
  status       text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'passed', 'failed')),
  items        jsonb NOT NULL DEFAULT '[]',
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_tasks', 'progress_updates', 'rfis', 'change_orders', 'inspections'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_rows ON %I USING (tenant_id = app_current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
    EXECUTE format('GRANT ALL ON %I TO app_platform', t);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_site_tasks_tenant_project ON site_tasks (tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_rfis_tenant_status ON rfis (tenant_id, status);
