-- 044: give tech_team the permissions the rest of the codebase assumes it has.
--
-- WHAT WAS WRONG
--
-- tech_team is referenced in eleven places as platform staff: it passes
-- requirePlatformStaff in tenantRoutes and branchCallRoutes, migration 031
-- auto-enrols it in email MFA, tenantRoutes excludes it from the tenant role
-- list, AuthContext never trial-gates it, and Login treats it as a platform
-- account.
--
-- It was never granted a single permission. Migration 028 backfilled the
-- catalog for eight system roles and tech_team is not among them, and seed.ts
-- has no entry for it either. Signing in as one produced a user who could
-- reach the platform console — that check is by role NAME — and got 403 from
-- everything else, including their own dashboard.
--
-- THE THREE KEYS, AND WHY EXACTLY THESE
--
-- Not invented here. src/services/authService.ts already declares
-- tech_team: ['view_dashboard', 'view_platform', 'manage_branch'], and that
-- map is what the SPA uses to decide which nav items to render. The nav was
-- therefore offering Dashboard and Platform Control to a role the server
-- would refuse. This makes the database agree with the client rather than
-- choosing a new answer.
--
-- The wider problem — that the SPA has its own hardcoded permission map at all,
-- when /api/auth/me already returns the real list — is NOT fixed here. That is
-- a change to how every role resolves its menu and deserves its own migration
-- and its own testing.

-- Two of the three keys were not in the catalog at all, so a grant referencing
-- them would have been silently skipped by the EXISTS guard below and the role
-- would have stayed half-empty.
INSERT INTO permissions (key, description) VALUES
  ('view_platform', 'Reach the platform console'),
  ('manage_branch', 'Onboard and manage builders within a branch')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, v.key
  FROM roles r
  CROSS JOIN (VALUES ('view_dashboard'), ('view_platform'), ('manage_branch')) AS v(key)
 WHERE r.name = 'tech_team'
   AND r.is_system
   AND EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key)
ON CONFLICT DO NOTHING;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
   WHERE r.name = 'tech_team';
  IF EXISTS (SELECT 1 FROM roles WHERE name = 'tech_team') THEN
    RAISE NOTICE '044: tech_team now holds % grants', n;
  ELSE
    -- Not an error: most workspaces have no tech_team role, and this backfill
    -- exists so that the ones which do are coherent.
    RAISE NOTICE '044: no tech_team role in this database; nothing to grant';
  END IF;
END $$;
