-- 046: four roles the sign-in picker offers that live workspaces do not have.
--
-- WHAT WAS WRONG
--
-- ROLE_PERMS (seed.ts and tenantRoutes.ts) defines eleven workspace roles, and
-- the sign-in picker offers all eleven. A workspace provisioned BEFORE a role
-- was added never gets it — provisioning only runs once, at creation.
--
-- Migration 045 fixed exactly this for hr_manager and stopped there. The same
-- hole was still open for auditor, telecaller, land_manager and bd_manager: a
-- builder on a workspace created last month can pick "Telecaller" in the
-- picker, but cannot create one, because the role does not exist in their
-- tenant. Settings → Users offers a role list built from `roles`, so the entry
-- is simply absent and there is nothing to explain why.
--
-- WHY GENERIC RATHER THAN A LIST OF THREE
--
-- This is the second migration written for this bug and would have been the
-- last only by luck. Anchoring on "every tenant that has a builder_admin"
-- rather than "the roles I noticed missing today" means adding a role to
-- ROLE_PERMS plus one INSERT here is the whole job, and a workspace can never
-- again be silently short of a role the UI advertises.
--
-- Grants mirror ROLE_PERMS in server/src/routes/tenantRoutes.ts. They must
-- change together; that file is the source of truth for new workspaces and
-- this migration only catches up the ones that already exist.

-- ── 1. Create any missing role, for every real workspace ────────────────────
--
-- A workspace is identified by its SLUG, not by the roles inside it.
--
-- The first draft of this migration keyed on "every tenant that has a
-- builder_admin", on the assumption that the platform tenant has none. That
-- assumption is false wherever a builder_admin role has been created in the
-- platform tenant — a test fixture is enough — and the migration then created
-- telecallers and land managers inside the platform tenant, where those roles
-- mean nothing and would appear in the super admin's user form.
--
-- `slug = 'platform'` is the real marker: the slug is reserved at
-- provisioning time (tenantRoutes refuses it, and verify-golive pins that),
-- so exactly one tenant can ever be the platform one.
INSERT INTO roles (tenant_id, name, is_system)
SELECT t.id, v.role, true
  FROM tenants t
  CROSS JOIN (VALUES
      ('auditor'), ('telecaller'), ('land_manager'), ('bd_manager')
    ) AS v(role)
 WHERE t.slug <> 'platform'
   AND NOT EXISTS (
     SELECT 1 FROM roles x WHERE x.tenant_id = t.id AND x.name = v.role)
ON CONFLICT (tenant_id, name) DO NOTHING;

-- Undo the leak where the first draft already ran, and the same leak from
-- migration 045, which keyed on builder_admin for the same reason and put an
-- hr_manager in the platform tenant wherever one existed.
--
-- Restricted to the platform tenant, to the roles these two migrations
-- introduce, and to roles NOBODY holds — a role with a user is somebody's
-- access and is never dropped here.
DELETE FROM roles r
 USING tenants t
 WHERE t.id = r.tenant_id
   AND t.slug = 'platform'
   AND r.name IN ('telecaller', 'land_manager', 'bd_manager', 'hr_manager')
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.role_id = r.id);

-- ── 2. Grant them ───────────────────────────────────────────────────────────
-- Runs against every copy of the role in every tenant, not just the ones just
-- created: a role that exists but holds nothing is the tech_team failure
-- (migration 044), where eleven code paths referenced a role with zero grants
-- and every page it could reach returned 403.
--
-- ON CONFLICT DO NOTHING means a tenant that has already customised one of
-- these roles keeps its extra grants — this adds the baseline, it does not
-- reset anybody's deliberate change.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, v.key
  FROM roles r
  CROSS JOIN LATERAL (VALUES
      -- Reads every module, writes none. The read-only key set is what makes
      -- an auditor useful; see leadsRoutes, where treating "no manage_leads"
      -- as "own leads only" once left an auditor able to see nothing at all.
      ('auditor', 'view_dashboard'), ('auditor', 'view_leads'),
      ('auditor', 'view_projects'), ('auditor', 'view_inventory'),
      ('auditor', 'view_bookings'), ('auditor', 'view_sales_performance'),
      ('auditor', 'view_campaigns'), ('auditor', 'view_calendar'),
      ('auditor', 'view_reports'), ('auditor', 'view_messages'),
      ('auditor', 'view_documents'), ('auditor', 'view_finance'),
      ('auditor', 'view_service'), ('auditor', 'view_brokers'),
      ('auditor', 'view_execution'), ('auditor', 'view_procurement'),
      ('auditor', 'view_hr'), ('auditor', 'view_accounts'),
      ('auditor', 'view_audit_log'), ('auditor', 'view_invoices'),
      ('auditor', 'view_leasing'), ('auditor', 'view_owner_payouts'),

      -- Calls their own list and books the visit. No inventory and no
      -- bookings: a telecaller hands over at the appointment.
      ('telecaller', 'view_dashboard'), ('telecaller', 'view_leads'),
      ('telecaller', 'manage_own_leads'), ('telecaller', 'add_notes'),
      ('telecaller', 'view_projects'), ('telecaller', 'view_calendar'),
      ('telecaller', 'schedule_visits'), ('telecaller', 'view_messages'),
      ('telecaller', 'send_messages'),

      -- Acquisition and title work. Sees BD but cannot qualify — that
      -- approval belongs to the BD manager below, so the person sourcing a
      -- parcel is not the person signing off that it is worth buying.
      ('land_manager', 'view_dashboard'), ('land_manager', 'view_projects'),
      ('land_manager', 'view_documents'), ('land_manager', 'view_land'),
      ('land_manager', 'manage_land'), ('land_manager', 'view_bd'),
      ('land_manager', 'view_calendar'), ('land_manager', 'view_messages'),
      ('land_manager', 'send_messages'),

      ('bd_manager', 'view_dashboard'), ('bd_manager', 'view_projects'),
      ('bd_manager', 'view_reports'), ('bd_manager', 'view_bd'),
      ('bd_manager', 'manage_bd'), ('bd_manager', 'view_land'),
      ('bd_manager', 'approve_land_qualify'), ('bd_manager', 'view_documents'),
      ('bd_manager', 'view_calendar'), ('bd_manager', 'view_messages'),
      ('bd_manager', 'send_messages')
    ) AS v(role, key)
 WHERE r.name = v.role
   -- Workspaces only, for the same reason as above.
   AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = r.tenant_id AND t.slug <> 'platform')
   -- The catalog is authoritative: granting a key that no permission row
   -- defines would violate the FK and abort the whole migration.
   AND EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key)
ON CONFLICT DO NOTHING;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT x.name,
           count(*)::int                                        AS in_tenants,
           min((SELECT count(*) FROM role_permissions rp WHERE rp.role_id = x.id))::int AS min_grants
      FROM roles x
     WHERE x.name IN ('auditor', 'telecaller', 'land_manager', 'bd_manager')
     GROUP BY x.name
     ORDER BY x.name
  LOOP
    RAISE NOTICE '046: % exists in % workspace(s), fewest grants held: %',
      r.name, r.in_tenants, r.min_grants;
  END LOOP;
END $$;
