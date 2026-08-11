-- 028: backfill the permission catalog and re-grant it to existing system roles.
--
-- WHY THIS EXISTS
--
-- `has_permission(key)` is a strict lookup into role_permissions with NO
-- super-admin bypass. The catalog and every grant come from ONE place —
-- scripts/seed.ts — which runs only at bootstrap. Nothing has ever migrated a
-- newly-added permission key into an already-provisioned tenant.
--
-- So every module shipped after a tenant was created is invisible to it. When
-- migrations 015-019 added HR, procurement, site execution and land/BD, their
-- routes started gating on keys ('view_hr', 'view_procurement', 'view_execution',
-- 'view_land', …) that existing tenants had never been granted and that were not
-- even rows in `permissions`. Those four modules return 403 to every user in
-- such a tenant — including its super_admin, who by design has no bypass.
--
-- The development database is the proof: 37 keys present, 25 missing, and four
-- modules dead for the only two roles that exist.
--
-- DESIGN
--
--   * Additive only. Never DELETE a grant — a tenant may have deliberately
--     widened a role, and this migration must not quietly narrow it.
--   * Only touches roles whose name matches a known system role. A tenant's
--     custom role ("junior_sales") gets nothing: guessing its intent would be
--     privilege escalation, not a fix.
--   * Idempotent, so re-running is harmless.
--   * Approval rights stay SEPARATE grants throughout, so the person who raises
--     a PO, change order or discount cannot approve their own.

-- ── 1. The canonical catalog ────────────────────────────────────────────────
-- Mirrors PERMISSIONS in scripts/seed.ts and ROLE_PERMISSIONS in
-- src/services/authService.ts. All three must be changed together.
INSERT INTO permissions (key, description)
SELECT k, k FROM (VALUES
  ('view_dashboard'), ('view_leads'), ('manage_leads'), ('manage_own_leads'),
  ('assign_leads'), ('add_notes'), ('view_inventory'), ('manage_inventory'),
  ('view_reports'), ('manage_settings'), ('manage_tenant'), ('manage_users'),
  ('manage_projects'), ('view_projects'), ('view_sales_performance'),
  ('approve_bookings'), ('view_campaigns'), ('manage_campaigns'),
  ('view_finance'), ('manage_finance'), ('view_messages'), ('send_messages'),
  ('view_documents'), ('manage_documents'), ('view_service'), ('manage_service'),
  ('view_calendar'), ('schedule_visits'), ('use_ai_studio'), ('create_bookings'),
  ('view_audit_log'), ('view_bookings'), ('manage_bookings'), ('view_brokers'),
  ('manage_brokers'), ('manage_team'), ('approve_reminders'),
  -- site execution + procurement
  ('view_execution'), ('manage_execution'), ('approve_change_orders'),
  ('view_procurement'), ('manage_procurement'), ('approve_purchase_orders'),
  -- HR & workforce
  ('view_hr'), ('manage_hr'), ('manage_attendance'),
  -- ledger, RA billing, quotations, configurable approvals
  ('view_accounts'), ('manage_accounts'), ('approve_vendor_bills'),
  ('signoff_ra_bills'), ('create_quotations'), ('approve_discounts'),
  ('manage_approval_rules'),
  -- land acquisition
  ('view_land'), ('manage_land'), ('approve_land_qualify'), ('approve_land_convert'),
  -- business development
  ('view_bd'), ('manage_bd'), ('approve_bd_handoff')
) AS t(k)
ON CONFLICT (key) DO NOTHING;

-- ── 2. Re-grant to existing system roles ────────────────────────────────────
-- The role → permission map, as data. Kept in the same shape as ROLE_PERMS in
-- scripts/seed.ts so the two can be diffed by eye.
CREATE TEMP TABLE _role_grant (role_name text, permission_key text) ON COMMIT DROP;

-- super_admin and builder_admin: everything in the catalog. The two exceptions
-- for builder_admin are workflow rights that belong to a sales manager, not an
-- account owner.
INSERT INTO _role_grant
SELECT 'super_admin', key FROM permissions;

INSERT INTO _role_grant
SELECT 'builder_admin', key FROM permissions
 WHERE key NOT IN ('approve_reminders', 'manage_team');

INSERT INTO _role_grant (role_name, permission_key) VALUES
  ('sales_manager','view_dashboard'), ('sales_manager','view_leads'),
  ('sales_manager','manage_leads'), ('sales_manager','assign_leads'),
  ('sales_manager','add_notes'), ('sales_manager','manage_team'),
  ('sales_manager','view_reports'), ('sales_manager','view_inventory'),
  ('sales_manager','view_projects'), ('sales_manager','view_sales_performance'),
  ('sales_manager','view_finance'), ('sales_manager','view_messages'),
  ('sales_manager','send_messages'), ('sales_manager','view_documents'),
  ('sales_manager','view_service'), ('sales_manager','manage_service'),
  ('sales_manager','view_calendar'), ('sales_manager','schedule_visits'),
  ('sales_manager','use_ai_studio'), ('sales_manager','create_bookings'),
  ('sales_manager','approve_reminders'), ('sales_manager','view_campaigns'),
  ('sales_manager','manage_campaigns'), ('sales_manager','view_bookings'),
  ('sales_manager','manage_bookings'), ('sales_manager','view_brokers'),
  ('sales_manager','view_execution'), ('sales_manager','create_quotations'),
  ('sales_manager','approve_discounts'),

  ('sales_executive','view_dashboard'), ('sales_executive','view_leads'),
  ('sales_executive','manage_own_leads'), ('sales_executive','add_notes'),
  ('sales_executive','view_inventory'), ('sales_executive','view_projects'),
  ('sales_executive','view_messages'), ('sales_executive','send_messages'),
  ('sales_executive','view_documents'), ('sales_executive','view_calendar'),
  ('sales_executive','schedule_visits'), ('sales_executive','use_ai_studio'),
  ('sales_executive','create_bookings'), ('sales_executive','view_bookings'),
  ('sales_executive','create_quotations'),

  ('site_engineer','view_dashboard'), ('site_engineer','view_projects'),
  ('site_engineer','view_execution'), ('site_engineer','manage_execution'),
  ('site_engineer','view_procurement'), ('site_engineer','manage_procurement'),
  ('site_engineer','view_hr'), ('site_engineer','manage_attendance'),
  ('site_engineer','view_documents'), ('site_engineer','view_calendar'),
  ('site_engineer','view_messages'), ('site_engineer','send_messages'),
  ('site_engineer','signoff_ra_bills'),

  ('telecaller','view_dashboard'), ('telecaller','view_leads'),
  ('telecaller','manage_own_leads'), ('telecaller','add_notes'),
  ('telecaller','view_projects'), ('telecaller','view_calendar'),
  ('telecaller','schedule_visits'), ('telecaller','view_messages'),
  ('telecaller','send_messages'),

  ('accountant','view_dashboard'), ('accountant','view_projects'),
  ('accountant','view_reports'), ('accountant','view_accounts'),
  ('accountant','manage_accounts'), ('accountant','view_finance'),
  ('accountant','manage_finance'), ('accountant','view_procurement'),
  ('accountant','view_bookings'), ('accountant','view_documents'),

  ('auditor','view_dashboard'), ('auditor','view_leads'), ('auditor','view_projects'),
  ('auditor','view_inventory'), ('auditor','view_bookings'),
  ('auditor','view_sales_performance'), ('auditor','view_campaigns'),
  ('auditor','view_calendar'), ('auditor','view_reports'), ('auditor','view_messages'),
  ('auditor','view_documents'), ('auditor','view_finance'), ('auditor','view_service'),
  ('auditor','view_brokers'), ('auditor','view_execution'),
  ('auditor','view_procurement'), ('auditor','view_hr'), ('auditor','view_accounts'),
  ('auditor','view_audit_log'),

  ('land_manager','view_dashboard'), ('land_manager','view_projects'),
  ('land_manager','view_documents'), ('land_manager','view_land'),
  ('land_manager','manage_land'), ('land_manager','view_bd'),
  ('land_manager','view_calendar'), ('land_manager','view_messages'),
  ('land_manager','send_messages'),

  ('bd_manager','view_dashboard'), ('bd_manager','view_projects'),
  ('bd_manager','view_reports'), ('bd_manager','view_bd'), ('bd_manager','manage_bd'),
  ('bd_manager','view_land'), ('bd_manager','approve_land_qualify'),
  ('bd_manager','view_documents'), ('bd_manager','view_calendar'),
  ('bd_manager','view_messages'), ('bd_manager','send_messages');

-- Apply. The join on role name is what confines this to system roles: a custom
-- role has no row in _role_grant and is therefore left exactly as it was.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, g.permission_key
  FROM roles r
  JOIN _role_grant g ON g.role_name = r.name
 WHERE EXISTS (SELECT 1 FROM permissions p WHERE p.key = g.permission_key)
ON CONFLICT DO NOTHING;

-- ── 3. Report what changed ──────────────────────────────────────────────────
DO $$
DECLARE
  n_perms int;
  n_roles int;
  n_grants int;
BEGIN
  SELECT count(*) INTO n_perms FROM permissions;
  SELECT count(DISTINCT r.id) INTO n_roles
    FROM roles r JOIN _role_grant g ON g.role_name = r.name;
  SELECT count(*) INTO n_grants FROM role_permissions;
  RAISE NOTICE '028: catalog now % keys; % system roles reconciled; % total grants',
    n_perms, n_roles, n_grants;
END $$;
