-- 045: an HR module with nobody to run it.
--
-- WHAT WAS MISSING
--
-- Friendly ERP has a full HR module — employees, attendance, leave requests,
-- payroll runs — behind view_hr / manage_hr / manage_attendance. It has never
-- had an HR ROLE. Those keys are held by builder_admin, super_admin, and
-- site_engineer (who marks attendance on site and nothing else).
--
-- So a builder with an HR person could not delegate to them. The only way to
-- let somebody run payroll was to make them a builder_admin, which also hands
-- them the ledger, every approval gate, and the ability to change workspace
-- settings. A missing role is not a cosmetic gap when the workaround is
-- over-privileging a member of staff.
--
-- WHAT hr_manager GETS, AND WHY NOT MORE
--
-- The HR module, the people-adjacent context needed to use it (projects, so
-- staff can be assigned; documents, for contracts and IDs; calendar and
-- messages, to actually reach anybody), and reports for headcount and
-- attendance. Deliberately no finance: payroll RUNS here, but posting the
-- payroll journal is the accountant's key, and separating who computes pay
-- from who releases it is the whole point of having two roles.

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, v.key
  FROM roles r
  CROSS JOIN (VALUES
      ('view_dashboard'), ('view_hr'), ('manage_hr'), ('manage_attendance'),
      ('view_documents'), ('view_projects'), ('view_reports'),
      ('view_calendar'), ('view_messages'), ('send_messages')
    ) AS v(key)
 WHERE r.name = 'hr_manager'
   AND EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key)
ON CONFLICT DO NOTHING;

-- Existing workspaces do not have the role yet — it is created for NEW ones by
-- ROLE_PERMS in tenantRoutes.ts and seed.ts. Create it for every tenant that
-- already has a builder_admin, so a live workspace gains it too rather than
-- only workspaces provisioned after this migration.
INSERT INTO roles (tenant_id, name, is_system)
SELECT DISTINCT r.tenant_id, 'hr_manager', true
  FROM roles r
 WHERE r.name = 'builder_admin'
   AND NOT EXISTS (
     SELECT 1 FROM roles x WHERE x.tenant_id = r.tenant_id AND x.name = 'hr_manager')
ON CONFLICT (tenant_id, name) DO NOTHING;

-- …and grant the newly created ones. Runs after the insert above, so a role
-- created by this migration is not left empty the way tech_team was.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, v.key
  FROM roles r
  CROSS JOIN (VALUES
      ('view_dashboard'), ('view_hr'), ('manage_hr'), ('manage_attendance'),
      ('view_documents'), ('view_projects'), ('view_reports'),
      ('view_calendar'), ('view_messages'), ('send_messages')
    ) AS v(key)
 WHERE r.name = 'hr_manager'
   AND EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key)
ON CONFLICT DO NOTHING;

DO $$
DECLARE roles_n int; grants_n int;
BEGIN
  SELECT count(*) INTO roles_n FROM roles WHERE name = 'hr_manager';
  SELECT count(*) INTO grants_n
    FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
   WHERE r.name = 'hr_manager';
  RAISE NOTICE '045: hr_manager exists in % workspace(s) holding % grants', roles_n, grants_n;
END $$;
