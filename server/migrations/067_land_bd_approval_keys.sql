-- ─── 067: no tenant may dead-end when the approval gates start being checked ──
--
-- Migration 028 created three permissions:
--
--   approve_land_qualify    a parcel becomes 'qualified'
--   approve_land_convert    a parcel becomes 'converted_to_project'
--   approve_bd_handoff      an opportunity becomes 'handed_to_land'
--
-- They are granted, they are documented — scripts/seed.ts calls them "checkers
-- qualify then convert", and the SPA reads all three (Land.tsx, BD.tsx) to
-- decide which buttons a person sees. No route has ever checked one. Every land
-- and BD status change gates on manage_land / manage_bd alone, so:
--
--   the maker approved their own work    land_manager holds manage_land, and
--                                        could qualify and convert a parcel the
--                                        same afternoon they logged it
--   the checker could not do their job   bd_manager holds approve_land_qualify
--                                        but NOT manage_land, so the API
--                                        refused the one action the role exists
--                                        for — while the SPA showed the button
--
-- The route fix is in landBdRoutes.ts. This migration exists only so that
-- turning the gates on cannot strand a workspace.
--
-- WHAT WOULD STRAND ONE
--
-- Once 'converted_to_project' requires approve_land_convert, a tenant where no
-- role holds that key can never convert a parcel again — the pipeline stops at
-- 'qualified' with no one able to move it. That is a worse outcome than the
-- missing separation of duties, and it would appear only in workspaces whose
-- roles were customised.
--
-- THE RULE, AND WHY IT IS NARROW
--
-- Per tenant, per key: if NOBODY in that workspace holds the approval key,
-- grant it to whoever holds the corresponding manage key — which is exactly the
-- access they have today, so nothing is lost and nothing is gained. If ANYONE
-- holds it, the workspace already has a separation of duties and is left
-- untouched, so the split it configured is preserved rather than flattened.
--
-- On the standard role set nothing changes: builder_admin holds all three, so
-- every key already has a holder in every seeded workspace.

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.approval
  FROM roles r
  JOIN (VALUES
          ('manage_land', 'approve_land_qualify'),
          ('manage_land', 'approve_land_convert'),
          ('manage_bd',   'approve_bd_handoff')
       ) AS k(maker, approval) ON true
 WHERE EXISTS (
         SELECT 1 FROM role_permissions rp
          WHERE rp.role_id = r.id AND rp.permission_key = k.maker)
   -- ...but only where the whole workspace lacks a holder for that key.
   AND NOT EXISTS (
         SELECT 1
           FROM roles peer
           JOIN role_permissions prp ON prp.role_id = peer.id
          WHERE peer.tenant_id = r.tenant_id
            AND prp.permission_key = k.approval)
   AND EXISTS (SELECT 1 FROM permissions p WHERE p.key = k.approval)
ON CONFLICT DO NOTHING;

-- ─── Proof ─────────────────────────────────────────────────────────────────
--
-- The assertion is the thing the migration is for: after this runs, every
-- workspace that can reach a gated transition must contain somebody able to
-- approve it. Checked against the rows, not the statement above.

DO $$
DECLARE stranded text;
BEGIN
  SELECT string_agg(DISTINCT t.slug || ':' || k.approval, ', ')
    INTO stranded
    FROM tenants t
    JOIN (VALUES
            ('manage_land', 'approve_land_qualify'),
            ('manage_land', 'approve_land_convert'),
            ('manage_bd',   'approve_bd_handoff')
         ) AS k(maker, approval) ON true
   -- Only workspaces that actually run the module: a builder with no land team
   -- has nothing to approve, and needing an approver there would be noise.
   WHERE EXISTS (
           SELECT 1 FROM roles r
             JOIN role_permissions rp ON rp.role_id = r.id
            WHERE r.tenant_id = t.id AND rp.permission_key = k.maker)
     AND NOT EXISTS (
           SELECT 1 FROM roles r
             JOIN role_permissions rp ON rp.role_id = r.id
            WHERE r.tenant_id = t.id AND rp.permission_key = k.approval);

  IF stranded IS NOT NULL THEN
    RAISE EXCEPTION 'workspaces left with a gate nobody can pass: %', stranded;
  END IF;
END $$;
