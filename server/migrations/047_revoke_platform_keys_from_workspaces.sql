-- 047: every builder_admin held the keys to the platform console.
--
-- WHAT WAS WRONG
--
-- Provisioning grants builder_admin "the whole catalog minus two workflow
-- keys". The catalog includes view_platform and manage_branch — the two
-- permissions that gate the platform console, where builders are onboarded,
-- workspaces suspended and branches administered. So every builder_admin in
-- every workspace held both.
--
-- WHY NOBODY NOTICED
--
-- It never escalated, for two reasons that are accidents rather than design:
--
--   1. The SPA does not use the server's permission list. It keeps its own
--      hardcoded map in src/services/authService.ts, and that map does not give
--      builder_admin view_platform — so the Platform Control nav item and the
--      /platform route stayed hidden.
--   2. No server route gates on either key. The platform routes use
--      requirePlatform(), which checks the tenant SLUG and the role NAME, not
--      the permission.
--
-- Either accident could end at any time. Moving the SPA onto the server's
-- permission list is the obviously correct direction and would, on its own,
-- open the platform console to every workspace owner. A single
-- has_permission('view_platform') written server-side would do the same.
--
-- WHAT THIS DOES
--
-- Revokes the two keys from every role OUTSIDE the platform tenant. The
-- platform tenant's own super_admin and tech_team keep them: that is where the
-- console belongs and migration 044 granted tech_team exactly these.
--
-- Scoped by tenant slug rather than by role name, so a workspace that renamed
-- or added an admin-like role is covered too — the rule is "no workspace holds
-- platform keys", not "builder_admin specifically".

DELETE FROM role_permissions rp
 USING roles r, tenants t
 WHERE r.id = rp.role_id
   AND t.id = r.tenant_id
   AND t.slug <> 'platform'
   AND rp.permission_key IN ('view_platform', 'manage_branch');

DO $$
DECLARE leaked int; kept int;
BEGIN
  SELECT count(*) INTO leaked
    FROM role_permissions rp
    JOIN roles r   ON r.id = rp.role_id
    JOIN tenants t ON t.id = r.tenant_id
   WHERE t.slug <> 'platform'
     AND rp.permission_key IN ('view_platform', 'manage_branch');

  SELECT count(*) INTO kept
    FROM role_permissions rp
    JOIN roles r   ON r.id = rp.role_id
    JOIN tenants t ON t.id = r.tenant_id
   WHERE t.slug = 'platform'
     AND rp.permission_key IN ('view_platform', 'manage_branch');

  RAISE NOTICE '047: platform keys outside the platform tenant: % (must be 0); retained inside it: %',
    leaked, kept;

  IF leaked > 0 THEN
    RAISE EXCEPTION '047: % platform-key grant(s) survived outside the platform tenant', leaked;
  END IF;
END $$;
