-- ─── 068: the two stages of paying a contractor become real ────────────────
--
-- Accounts.tsx has always drawn a contractor's running-account bill as a
-- two-signature workflow:
--
--   submitted      → "Verify Progress"   gated in the SPA on signoff_ra_bills
--   pmc_approved   → "Approve"           gated in the SPA on approve_vendor_bills
--   finance_approved → "Record Payment"
--
-- PATCH /api/ra-bills/:id gated all of it on manage_finance, and only STAMPED
-- whichever approver the transition implied — it never checked the person was
-- entitled to be one. That broke the control in both directions at once:
--
--   the site engineer holds signoff_ra_bills and no finance key, so the API
--   refused the "Verify Progress" button rendered for them — the first stage of
--   paying a contractor, dead for the one role that owns it
--
--   the accountant holds manage_finance, so they could do BOTH stages, and the
--   row then recorded one person as site verifier and finance approver alike
--
-- The route fix is in financeApRoutes.ts. This migration makes the grants match,
-- so switching the gates on neither strands a workspace nor quietly removes
-- somebody's job.
--
-- WHAT EACH RULE IS FOR
--
-- approve_vendor_bills → every role holding manage_finance.
--   Approving a vendor bill IS the accountant's job; the key was simply never
--   granted to them, and manage_finance already authorised this transition. This
--   restores exactly the access they have today, so nothing is taken away — the
--   key merely becomes real, and revocable by a builder who wants it escalated.
--
-- signoff_ra_bills → manage_finance holders ONLY where the workspace has nobody.
--   This is the stage that SHOULD change hands. Where a site engineer holds the
--   key the separation now bites: finance can no longer verify site progress,
--   which is the whole point of a second signature on a contractor payment. But
--   a workspace that runs no site role would stall at 'submitted' with nobody
--   able to move a bill, so there the maker keeps it.

-- Stage 2 — restore the accountant's existing ability under its own key.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'approve_vendor_bills'
  FROM roles r
 WHERE EXISTS (SELECT 1 FROM role_permissions rp
                WHERE rp.role_id = r.id AND rp.permission_key = 'manage_finance')
   AND EXISTS (SELECT 1 FROM permissions p WHERE p.key = 'approve_vendor_bills')
ON CONFLICT DO NOTHING;

-- Stage 1 — only rescue workspaces that would otherwise dead-end.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'signoff_ra_bills'
  FROM roles r
 WHERE EXISTS (SELECT 1 FROM role_permissions rp
                WHERE rp.role_id = r.id AND rp.permission_key = 'manage_finance')
   AND NOT EXISTS (
         SELECT 1 FROM roles peer
           JOIN role_permissions prp ON prp.role_id = peer.id
          WHERE peer.tenant_id = r.tenant_id
            AND prp.permission_key = 'signoff_ra_bills')
   AND EXISTS (SELECT 1 FROM permissions p WHERE p.key = 'signoff_ra_bills')
ON CONFLICT DO NOTHING;

-- ─── Proof ─────────────────────────────────────────────────────────────────
--
-- Asserted against the rows: every workspace that can raise an RA bill must
-- contain somebody able to move it through BOTH stages, or the module is worse
-- off than before this ran.

DO $$
DECLARE stranded text;
BEGIN
  SELECT string_agg(DISTINCT t.slug || ':' || k.approval, ', ')
    INTO stranded
    FROM tenants t
    JOIN (VALUES ('signoff_ra_bills'), ('approve_vendor_bills')) AS k(approval) ON true
   -- Only workspaces that actually run accounts payable.
   WHERE EXISTS (
           SELECT 1 FROM roles r
             JOIN role_permissions rp ON rp.role_id = r.id
            WHERE r.tenant_id = t.id AND rp.permission_key = 'manage_finance')
     AND NOT EXISTS (
           SELECT 1 FROM roles r
             JOIN role_permissions rp ON rp.role_id = r.id
            WHERE r.tenant_id = t.id AND rp.permission_key = k.approval);

  IF stranded IS NOT NULL THEN
    RAISE EXCEPTION 'workspaces left with an RA stage nobody can pass: %', stranded;
  END IF;
END $$;
