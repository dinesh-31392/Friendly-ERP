-- ─── 015: HR & workforce ───────────────────────────────────────────────────
-- Employees (staff + contract workers), daily attendance (with geo check-in),
-- leave requests (maker-checker approval), and monthly payroll runs. Previously
-- localStorage-only; this makes the workforce module real multi-tenant SaaS.
-- Every table: FORCE RLS + tenant_rows policy + explicit grants (003 §9/§12).

CREATE TABLE IF NOT EXISTS employees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           text NOT NULL,
  phone          text NOT NULL DEFAULT '',
  email          citext,
  designation    text NOT NULL DEFAULT '',
  department     text NOT NULL DEFAULT '',
  type           text NOT NULL DEFAULT 'staff' CHECK (type IN ('staff', 'contract_worker')),
  project_id     uuid,
  monthly_salary numeric(14,2),
  daily_wage     numeric(14,2),
  join_date      date NOT NULL DEFAULT CURRENT_DATE,
  active         boolean NOT NULL DEFAULT true,
  user_id        uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE SET NULL (project_id),
  FOREIGN KEY (user_id, tenant_id)    REFERENCES users (id, tenant_id)    ON DELETE SET NULL (user_id)
);

CREATE TABLE IF NOT EXISTS attendance (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  employee_id uuid NOT NULL,
  date        date NOT NULL,
  check_in    text NOT NULL DEFAULT '',
  check_out   text,
  project_id  uuid,
  lat         numeric(9,6),
  lng         numeric(9,6),
  method      text NOT NULL DEFAULT 'manual' CHECK (method IN ('geo', 'manual')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_id, date),
  FOREIGN KEY (employee_id, tenant_id) REFERENCES employees (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  employee_id uuid NOT NULL,
  type        text NOT NULL DEFAULT 'casual' CHECK (type IN ('casual', 'sick', 'earned', 'unpaid')),
  from_date   date NOT NULL,
  to_date     date NOT NULL,
  days        integer NOT NULL DEFAULT 1,
  reason      text,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by  uuid REFERENCES users(id),
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (employee_id, tenant_id) REFERENCES employees (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month        text NOT NULL,                 -- 'YYYY-MM'
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'processed')),
  items        jsonb NOT NULL DEFAULT '[]',   -- [{employeeId,name,gross,daysPresent,...}]
  processed_by uuid REFERENCES users(id),
  processed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, month)
);

-- RLS + grants for each.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employees', 'attendance', 'leave_requests', 'payroll_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_rows ON %I', t);
    EXECUTE format('CREATE POLICY tenant_rows ON %I USING (tenant_id = app_current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
    EXECUTE format('GRANT ALL ON %I TO app_platform', t);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_attendance_tenant_date ON attendance (tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_leave_tenant_status ON leave_requests (tenant_id, status);
