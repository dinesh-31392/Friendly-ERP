-- ============================================================================
-- FRIENDLY CRM — PostgreSQL Schema (v1)
-- Multi-tenant SaaS for real estate. Defense-in-depth: the DATABASE is the
-- final line of defense — RLS enforces isolation even if app code is buggy.
--
-- Requires PostgreSQL 15+. Run as a migration superuser; the app NEVER
-- connects as this role.
-- ============================================================================

-- ─── 0. Roles: the app runs WITHOUT BYPASSRLS ───────────────────────────────
-- app_user:     the ONLY role the API server uses. Subject to RLS everywhere.
-- app_platform: platform-level jobs (super-admin panel, backups, cross-tenant
--               analytics). Guarded by network policy + separate credentials.
-- Run these two statements ONCE per cluster with real secrets (they are kept
-- out of this migration file on purpose):
--   CREATE ROLE app_user     LOGIN PASSWORD '<secret>' NOBYPASSRLS;
--   CREATE ROLE app_platform LOGIN PASSWORD '<secret>' BYPASSRLS;

CREATE EXTENSION IF NOT EXISTS citext;

-- ─── 1. Helpers ──────────────────────────────────────────────────────────────

-- Current tenant from the per-transaction session variable. Returns NULL
-- (thus zero rows via RLS) when the context was never set — fail closed.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.current_tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ─── 2. Tenants ──────────────────────────────────────────────────────────────

CREATE TABLE tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  company        text NOT NULL,
  slug           text NOT NULL UNIQUE,          -- subdomain: <slug>.friendlycrm.app
  plan           text NOT NULL DEFAULT 'Starter',
  status         text NOT NULL DEFAULT 'trial'
                 CHECK (status IN ('trial', 'active', 'suspended')),
  trial_ends_at  timestamptz,
  country        text NOT NULL DEFAULT 'India',
  currency       char(3) NOT NULL DEFAULT 'INR',
  primary_color  text,                          -- white-label accent
  logo_url       text,                          -- object storage, not inline
  brand_voice    text,
  audience       text,
  channels       jsonb NOT NULL DEFAULT '[]',
  email          text NOT NULL,
  phone          text,
  address        text,
  rera           text,
  gst            text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

-- A tenant's users can see and update ONLY their own tenant row.
CREATE POLICY tenant_isolation_select ON tenants
  FOR SELECT USING (id = app_current_tenant());
CREATE POLICY tenant_isolation_update ON tenants
  FOR UPDATE USING (id = app_current_tenant());
-- No INSERT/DELETE policy for app_user: tenant lifecycle is app_platform-only.

-- ─── 3. RBAC: users → roles → permissions (stored in DB, per-tenant) ────────

CREATE TABLE permissions (
  key         text PRIMARY KEY,        -- e.g. 'view_leads', 'manage_bookings'
  description text NOT NULL
);
-- Seeded from the canonical list (matches src/services/authService.ts today).

CREATE TABLE roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,            -- 'builder_admin', 'sales_manager', custom…
  is_system  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  -- Referenced by users' composite FK below, which is what stops a user from
  -- being given another tenant's role. id is already unique via the PK; this
  -- pair is what a (role_id, tenant_id) FK needs to point at.
  UNIQUE (id, tenant_id)
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role_id       uuid NOT NULL,   -- composite FK to roles below (tenant-scoped)
  name          text NOT NULL,
  email         citext NOT NULL,
  password_hash text NOT NULL,         -- argon2id ONLY. Never plaintext.
  phone         text,
  avatar_url    text,
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  -- Referential integrity checks are performed by the SYSTEM and BYPASS RLS, so
  -- a plain `REFERENCES roles(id)` happily accepted ANOTHER tenant's role id —
  -- and has_permission() joins `rp.role_id = u.role_id` without ever checking
  -- the role's tenant. That combination is a cross-tenant privilege escalation:
  -- point a user at a role in a tenant with wider grants and inherit them.
  -- The composite FK makes a cross-tenant role literally unrepresentable.
  FOREIGN KEY (role_id, tenant_id) REFERENCES roles (id, tenant_id),
  -- Referenced by leads.assigned_to's composite FK (same reasoning).
  UNIQUE (id, tenant_id)
);

ALTER TABLE roles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles            FORCE  ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE  ROW LEVEL SECURITY;
ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE users            FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_rows ON roles
  USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_rows ON role_permissions
  USING (role_id IN (SELECT id FROM roles WHERE tenant_id = app_current_tenant()));
CREATE POLICY tenant_rows ON users
  USING (tenant_id = app_current_tenant());

-- Permission check usable inside SQL (e.g. column-level guards, views):
CREATE OR REPLACE FUNCTION has_permission(p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
-- SECURITY DEFINER runs as the owner. Without a pinned search_path an attacker
-- who can create objects in an earlier schema (incl. pg_temp) can shadow the
-- tables below and execute arbitrary SQL as the owner. pg_temp MUST come last.
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM users u
    JOIN role_permissions rp ON rp.role_id = u.role_id
    WHERE u.id = app_current_user()
      AND u.tenant_id = app_current_tenant()
      AND u.active
      AND rp.permission_key = p_key
  )
$$;

-- ─── 4. Metadata-driven core: schema_definitions + meta_config ──────────────
-- ZERO HARDCODING: pipeline stages, form fields, validations, dropdown options
-- all live here as versioned JSON. Renaming a stage = one UPDATE, no deploy.

CREATE TABLE schema_definitions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity      text NOT NULL,       -- 'lead' | 'booking' | 'unit' | 'ticket' …
  kind        text NOT NULL        -- what this JSON describes
              CHECK (kind IN ('form', 'pipeline', 'validation', 'list_view')),
  version     int  NOT NULL DEFAULT 1,
  is_active   boolean NOT NULL DEFAULT true,
  definition  jsonb NOT NULL,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity, kind, version)
);
-- Example `definition` for (entity='lead', kind='pipeline'):
-- { "stages": [
--     {"key":"new","label":"New","color":"#3b82f6","order":1},
--     {"key":"visit_scheduled","label":"Site Visit","color":"#f59e0b","order":4,
--      "requires":["geo_checkin"]},
--     {"key":"booked","label":"Booked","color":"#10b981","order":6,"terminal":true}
-- ]}
-- Example for (entity='lead', kind='form'):
-- { "fields": [
--     {"key":"name","type":"text","label":"Full Name","required":true,"max":120},
--     {"key":"budget","type":"money","label":"Budget","min":0},
--     {"key":"configuration","type":"select","options_ref":"config_options"},
--     {"key":"custom.facing","type":"select","label":"Facing",
--      "options":["East","West","North","South"]}   -- tenant-added field
-- ]}

CREATE TABLE meta_config (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key        text NOT NULL,           -- 'lead_sources', 'config_options', 'sla_hours'…
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

ALTER TABLE schema_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_definitions FORCE  ROW LEVEL SECURITY;
ALTER TABLE meta_config        ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_config        FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON schema_definitions USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_rows ON meta_config        USING (tenant_id = app_current_tenant());

-- ─── 5. Leads (core entity; custom fields ride in JSONB) ────────────────────

CREATE TABLE leads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  email            citext,
  phone            text NOT NULL,
  phone_normalized text GENERATED ALWAYS AS (regexp_replace(phone, '\D', '', 'g')) STORED,
  source           text NOT NULL DEFAULT 'Manual',
  project_id       uuid,                       -- FK to projects (same pattern)
  project          text NOT NULL DEFAULT '',   -- denormalized project name (SPA display)
  budget           numeric(14,2) NOT NULL DEFAULT 0,
  configuration    text,
  stage            text NOT NULL DEFAULT 'new', -- validated against the tenant's
                                                -- active pipeline definition in
                                                -- the service layer + trigger
  priority         text NOT NULL DEFAULT 'warm'
                   CHECK (priority IN ('hot', 'warm', 'cold')),
  score            smallint NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  assigned_to      uuid,   -- composite FK to users below (tenant-scoped)
  custom_fields    jsonb NOT NULL DEFAULT '{}',  -- metadata-driven extra fields
  last_contact_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Tenant-scoped assignee. A plain `REFERENCES users(id)` bypassed RLS (FK
  -- checks are done by the system) and so allowed assigning a lead to a user in
  -- a DIFFERENT tenant. It also defaulted to ON DELETE NO ACTION, which made
  -- deleting any user who ever held a lead fail outright — offboarding a sales
  -- exec was impossible. The column-list SET NULL (PG15+, and we require 15+)
  -- nulls ONLY assigned_to; a bare SET NULL would try to null tenant_id too and
  -- violate its NOT NULL.
  FOREIGN KEY (assigned_to, tenant_id) REFERENCES users (id, tenant_id)
    ON DELETE SET NULL (assigned_to)
);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON leads USING (tenant_id = app_current_tenant());

-- Stage values must exist in the tenant's ACTIVE pipeline definition:
CREATE OR REPLACE FUNCTION validate_lead_stage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_definitions sd
    WHERE sd.tenant_id = NEW.tenant_id
      AND sd.entity = 'lead' AND sd.kind = 'pipeline' AND sd.is_active
      AND sd.definition->'stages' @> jsonb_build_array(jsonb_build_object('key', NEW.stage))
  ) THEN
    RAISE EXCEPTION 'Invalid stage "%" for tenant % — not in active pipeline', NEW.stage, NEW.tenant_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER leads_stage_valid BEFORE INSERT OR UPDATE OF stage ON leads
  FOR EACH ROW EXECUTE FUNCTION validate_lead_stage();

CREATE TRIGGER leads_touch BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ─── 6. Audit log: every INSERT/UPDATE/DELETE, automatically, immutably ─────

CREATE TABLE audit_logs (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  table_name     text NOT NULL,
  record_id      uuid,
  action         text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  actor_id       uuid,                 -- app.current_user_id (NULL = system job)
  ip_address     inet,                 -- app.request_ip
  previous_state jsonb,                -- full OLD row (UPDATE / DELETE)
  new_state      jsonb,                -- full NEW row (INSERT / UPDATE)
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- On a partitioned table the PK must include the partition key
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);     -- monthly partitions; cheap retention
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE  ROW LEVEL SECURITY;
-- Tenants may READ their own trail. Nobody (via app_user) can write directly,
-- update, or delete: the ONLY writer is the SECURITY DEFINER trigger below.
CREATE POLICY tenant_read ON audit_logs FOR SELECT
  USING (tenant_id = app_current_tenant());
-- FORCE RLS applies to the trigger's definer too, so an INSERT policy must
-- exist. It is safe to keep it permissive because app_user has INSERT revoked
-- at the GRANT level below — the privilege check fails before the policy runs.
CREATE POLICY audit_trigger_insert ON audit_logs FOR INSERT WITH CHECK (true);
REVOKE INSERT, UPDATE, DELETE ON audit_logs FROM app_user;

CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
-- Pinned search_path: this trigger writes the audit trail as the owner, so an
-- unpinned path would let a shadowed `audit_logs` divert or forge the trail.
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
BEGIN
  INSERT INTO audit_logs
    (tenant_id, table_name, record_id, action, actor_id, ip_address, previous_state, new_state)
  VALUES (
    -- `tenants` IS the tenant: it has no tenant_id column, so v_row->>'tenant_id'
    -- is NULL, and with no tenant context (platform pool, seed, migrations)
    -- app_current_tenant() is NULL too -> NOT NULL violation on audit_logs.
    -- That made `npm run db:seed` fail on re-run (its ON CONFLICT DO UPDATE fires
    -- this trigger) and broke super-admin UPDATEs like suspending a tenant.
    CASE WHEN TG_TABLE_NAME = 'tenants'
         THEN (v_row->>'id')::uuid
         ELSE COALESCE((v_row->>'tenant_id')::uuid, app_current_tenant()) END,
    TG_TABLE_NAME,
    (v_row->>'id')::uuid,
    TG_OP,
    app_current_user(),
    nullif(current_setting('app.request_ip', true), '')::inet,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END
  );
  RETURN COALESCE(NEW, OLD);
END $$;

-- Attach to every business table (repeat for bookings, units, invoices, …):
CREATE TRIGGER audit_leads  AFTER INSERT OR UPDATE OR DELETE ON leads
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_users  AFTER INSERT OR UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_tenants AFTER UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_schema_defs AFTER INSERT OR UPDATE OR DELETE ON schema_definitions
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- ─── 7. Import staging & async export jobs ──────────────────────────────────

CREATE TABLE import_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity       text NOT NULL,                    -- 'lead'
  filename     text NOT NULL,
  status       text NOT NULL DEFAULT 'validating'
               CHECK (status IN ('validating', 'ready', 'importing', 'done', 'failed')),
  total_rows   int NOT NULL DEFAULT 0,
  valid_rows   int NOT NULL DEFAULT 0,
  error_rows   int NOT NULL DEFAULT 0,
  dupe_rows    int NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_rows_staging (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  batch_id    uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number  int NOT NULL,
  raw         jsonb NOT NULL,          -- as parsed from CSV, untouched
  normalized  jsonb,                   -- after type coercion
  errors      jsonb NOT NULL DEFAULT '[]',  -- [{field, code, message}]
  is_duplicate boolean NOT NULL DEFAULT false
);

CREATE TABLE export_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id),
  entity       text NOT NULL,
  format       text NOT NULL CHECK (format IN ('csv', 'json')),
  date_from    timestamptz,
  date_to      timestamptz,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'done', 'failed')),
  result_url   text,                   -- signed URL, expires
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

ALTER TABLE import_batches      ENABLE ROW LEVEL SECURITY; ALTER TABLE import_batches      FORCE ROW LEVEL SECURITY;
ALTER TABLE import_rows_staging ENABLE ROW LEVEL SECURITY; ALTER TABLE import_rows_staging FORCE ROW LEVEL SECURITY;
ALTER TABLE export_jobs         ENABLE ROW LEVEL SECURITY; ALTER TABLE export_jobs         FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON import_batches      USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_rows ON import_rows_staging USING (tenant_id = app_current_tenant());
CREATE POLICY tenant_rows ON export_jobs         USING (tenant_id = app_current_tenant());

-- ─── 8. Indexing strategy for multi-tenant performance ──────────────────────
-- RULE: tenant_id is ALWAYS the LEADING column of every composite index.
-- RLS rewrites every query as `WHERE tenant_id = $current AND …`, so a
-- leading tenant_id turns each tenant into a small private index slice.

-- Leads: the hot paths (pipeline board, "my leads", at-risk scan, dedup)
CREATE INDEX idx_leads_tenant_stage    ON leads (tenant_id, stage);
CREATE INDEX idx_leads_tenant_assigned ON leads (tenant_id, assigned_to, stage);
CREATE INDEX idx_leads_tenant_created  ON leads (tenant_id, created_at DESC);
CREATE INDEX idx_leads_tenant_lastcontact ON leads (tenant_id, last_contact_at)
  WHERE stage NOT IN ('booked', 'lost');            -- partial: at-risk scan only
CREATE INDEX idx_leads_tenant_phone    ON leads (tenant_id, phone_normalized);
CREATE INDEX idx_leads_tenant_email    ON leads (tenant_id, email);
CREATE INDEX idx_leads_custom_gin      ON leads USING gin (custom_fields jsonb_path_ops);

-- Users / RBAC lookups (login + permission check are on every request)
-- Login is the one hot query that CANNOT be tenant-scoped (the tenant isn't
-- known until after the credential lookup), so the tenant-leading rule above
-- doesn't serve it: `WHERE email = $1` seq-scanned users on every sign-in.
CREATE INDEX idx_users_email           ON users (email);
-- Exactly one active definition per (tenant, entity, kind). Nothing else
-- enforced this, and a second is_active row makes validate_lead_stage() and the
-- metadata readers pick a stale pipeline non-deterministically.
CREATE UNIQUE INDEX schema_definitions_one_active
  ON schema_definitions (tenant_id, entity, kind) WHERE is_active;
CREATE INDEX idx_roleperm_role         ON role_permissions (role_id);

-- Audit: time-range reads per tenant; BRIN keeps it tiny at huge volume
CREATE INDEX idx_audit_tenant_time     ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX idx_audit_created_brin    ON audit_logs USING brin (created_at);

-- Metadata: fetched on every page load → keep it a single index hit
CREATE INDEX idx_schemadef_lookup      ON schema_definitions (tenant_id, entity, kind)
  WHERE is_active;

-- ─── 9. Grants ───────────────────────────────────────────────────────────────
-- MOVED TO THE END OF THIS FILE (section 12). `GRANT ... ON ALL TABLES` only
-- affects tables that exist when it runs, and sections 10-11 below create two
-- more tables. Granting here silently left app_user with NO privileges on
-- user_preferences and tenant_keys (verified against PostgreSQL 18:
-- `has_table_privilege('app_user','user_preferences','SELECT')` -> false), so
-- the first route to touch them would fail with "permission denied".
-- Grants must always come last.

-- ─── 10. User preferences (dual-mode calling, UI settings) ──────────────────

CREATE TABLE user_preferences (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key          text NOT NULL,          -- e.g. 'calling_mode'
  value        jsonb NOT NULL,         -- e.g. '"SIM_NATIVE"' | '"API_CLOUD"'
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON user_preferences USING (tenant_id = app_current_tenant());
CREATE INDEX idx_userprefs_tenant ON user_preferences (tenant_id, user_id);

-- ─── 11. Tenant keys: third-party credentials, encrypted at rest ────────────
-- Chatbot Engine / telephony / portal API keys. Values are encrypted with
-- pgcrypto (pgp_sym_encrypt) using a key held ONLY in the API's environment —
-- a database dump alone cannot reveal the secrets.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenant_keys (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service       text NOT NULL,         -- 'chatbot_engine' | 'exotel' | 'whatsapp' …
  key_name      text NOT NULL,         -- 'api_key' | 'portal_url' | 'account_sid' …
  value_enc     bytea NOT NULL,        -- pgp_sym_encrypt(value, :app_kms_key)
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, service, key_name)
);
ALTER TABLE tenant_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_keys FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON tenant_keys USING (tenant_id = app_current_tenant());
-- Usage from the API (key from env, never stored in the DB):
--   INSERT: pgp_sym_encrypt($value, current_setting('app.kms_key'))
--   READ:   pgp_sym_decrypt(value_enc, current_setting('app.kms_key'))

-- ─── 11b. updated_at triggers ───────────────────────────────────────────────
-- tenants and users both carry updated_at, but only `leads` had a touch
-- trigger — so their column was set once at INSERT and never moved again.
-- ARCHITECTURE.md's incremental backup selects `WHERE updated_at >= $2`, so
-- every edit to a tenant or a user was silently missing from every incremental.
CREATE TRIGGER tenants_touch BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ─── 12. Grants (MUST be the last section) ──────────────────────────────────
-- `GRANT ... ON ALL TABLES IN SCHEMA public` is point-in-time: it only reaches
-- tables that already exist. Keep this block at the very bottom, and move it
-- down again whenever a new section adds a table.
GRANT USAGE ON SCHEMA public TO app_user, app_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
REVOKE INSERT, UPDATE, DELETE ON audit_logs FROM app_user;  -- re-assert after grant

-- `permissions` is a GLOBAL, read-only catalog (no tenant_id, no RLS — correct,
-- it's the same list for everyone). But the blanket GRANT above handed app_user
-- DML on it, and role_permissions.permission_key REFERENCES it ON DELETE
-- CASCADE — so a single `DELETE FROM permissions WHERE key='view_leads'` would
-- silently strip that permission from EVERY tenant on the platform.
REVOKE INSERT, UPDATE, DELETE ON permissions FROM app_user;

-- Partitions are separate tables: the GRANT above reaches audit_logs_default,
-- and the REVOKE above only names the PARENT. RLS lives on the parent, and a
-- partition addressed DIRECTLY does not inherit it — so without the statements
-- below, app_user can run
--   SELECT * FROM audit_logs_default   -> every tenant's audit trail, and
--   DELETE FROM audit_logs_default     -> erase the "immutable" log.
-- Both were reproduced against PostgreSQL 18. Privileges are checked on the
-- PARENT when a query routes through it, so revoking direct access here does
-- not affect normal reads/writes of audit_logs. RLS on the partition is
-- defence-in-depth in case a future GRANT re-opens the privilege.
REVOKE ALL ON audit_logs_default FROM app_user;
ALTER TABLE audit_logs_default ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs_default FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON audit_logs_default FOR SELECT
  USING (tenant_id = app_current_tenant());
-- NOTE: every future monthly partition needs the same treatment. Create them
-- with a helper that REVOKEs from app_user and enables RLS, never with a bare
-- CREATE TABLE ... PARTITION OF.

GRANT ALL ON ALL TABLES IN SCHEMA public TO app_platform;
