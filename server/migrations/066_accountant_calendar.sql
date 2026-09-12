-- ─── 066: the accountant's work has dates, and nowhere to see them ─────────
--
-- The accountant role held no `view_calendar`, so /api/crm-tasks refused them
-- and the Calendar page was closed. Everything that desk does is dated:
--
--   month-end close        a sequence with a deadline
--   GSTR-1 / GSTR-3B       the 11th and the 20th
--   TDS deposit            the 7th of the following month
--   vendor payment runs    scheduled, and late payment costs money
--
-- WHY THIS IS A GAP RATHER THAN A PREFERENCE
--
-- The product already models finance work as dated work. `crm_tasks.category`
-- accepts 'payment' — a first-class category the accountant could never open.
-- The demo seeder made the same point by accident: the natural task to give an
-- accountant is "Reconcile August receipts", and it had to be deleted again
-- because the role could not read it back. A row nobody can open is worse than
-- an empty list, because it reads as data loss.
--
-- WHAT THIS DOES NOT GRANT
--
-- Nothing about leads. `view_calendar` opens the Calendar page and the task
-- feed, and crmTaskRoutes scopes that feed to `user_id = app_current_user()`
-- for anyone without manage_leads — which the accountant does not have. So
-- they see THEIR OWN tasks and no one else's, and no lead pipeline.
--
-- WHY A MIGRATION AND NOT ONLY A SEED CHANGE
--
-- Role grants live in five places: this catalog, scripts/seed.ts,
-- tenantRoutes.ts (self-serve signup), the demo seeder, and the SPA's demo
-- map. The four code paths only shape roles created AFTER they change. Every
-- workspace already provisioned keeps the grants written into its own
-- role_permissions rows, so without this they would never get the key.
--
-- Keyed on the role NAME within each tenant, and idempotent: a workspace that
-- has already been granted it, or has renamed the role, is unaffected.

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'view_calendar'
  FROM roles r
 WHERE r.name = 'accountant'
   AND EXISTS (SELECT 1 FROM permissions p WHERE p.key = 'view_calendar')
ON CONFLICT DO NOTHING;

-- ─── Proof ─────────────────────────────────────────────────────────────────
--
-- Asserted against the rows rather than the statement: a workspace with an
-- accountant that still cannot open a calendar means the backfill missed it,
-- which is precisely the failure this migration exists to prevent.

DO $$
DECLARE stranded int;
BEGIN
  SELECT count(*) INTO stranded
    FROM roles r
   WHERE r.name = 'accountant'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_key = 'view_calendar');

  IF stranded > 0 THEN
    RAISE EXCEPTION '% accountant role(s) still cannot open a calendar', stranded;
  END IF;
END $$;
