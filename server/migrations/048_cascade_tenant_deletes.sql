-- 048: a workspace could not be deleted once anybody had signed out of it.
--
-- WHAT WAS WRONG
--
-- Every table added between migrations 037 and 043 declared its tenant FK as a
-- plain `REFERENCES tenants(id)` — no ON DELETE CASCADE. Every table older
-- than that has one. So DELETE FROM tenants succeeded on a brand-new workspace
-- and failed on any workspace that had been USED:
--
--   revoked_tokens          one sign-out
--   revoked_portal_tokens   one portal sign-out
--   notifications           one notification
--   notification_prefs      one preference change
--   demand_letters          one demand raised
--   rera_registrations      one project registered
--   escrow_allocations      one receipt allocated
--   site_visits             one visit booked
--
-- ERROR: update or delete on table "tenants" violates foreign key constraint
--
-- HOW IT SURFACED
--
-- scripts/seed-demo-workspace.mjs drops and recreates its workspace, and it
-- started failing the moment the workspace had a revoked token in it — which
-- is to say, the moment anyone signed out. That is the cheap version. The
-- expensive version is offboarding a real customer, or an erasure request,
-- against a workspace with years of use in it.
--
-- A cascade is right here for the same reason it is right on the other forty
-- tables: these rows have no meaning without the tenant. A revoked token for a
-- workspace that no longer exists is not data worth keeping, and leaving the
-- constraint as RESTRICT does not protect anything — it just makes deletion
-- fail late, after the operator believes it is happening.
--
-- The ledger's immutability triggers are a different matter and are untouched:
-- they guard EDITS to posted entries, not the removal of the whole tenant.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'revoked_tokens', 'revoked_portal_tokens',
    'notifications', 'notification_prefs',
    'demand_letters', 'rera_registrations', 'escrow_allocations',
    'site_visits'
  ] LOOP
    -- Guarded so this migration is safe on a database where a table was never
    -- created (a deployment that stopped before 041, say).
    IF to_regclass(t) IS NULL THEN
      RAISE NOTICE '048: % not present, skipping', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_tenant_id_fkey');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE',
      t, t || '_tenant_id_fkey');
  END LOOP;
END $$;

DO $$
DECLARE stragglers int;
BEGIN
  -- The invariant, asserted rather than assumed: NO table may reference
  -- tenants without a cascade. Written as a check over the catalog so a table
  -- added tomorrow with the same omission fails the next migration run rather
  -- than the next offboarding.
  SELECT count(*) INTO stragglers
    FROM pg_constraint c
   WHERE c.confrelid = 'tenants'::regclass
     AND c.contype = 'f'
     AND c.confdeltype <> 'c';

  RAISE NOTICE '048: tenant FKs still lacking ON DELETE CASCADE: %', stragglers;

  IF stragglers > 0 THEN
    RAISE EXCEPTION '048: % foreign key(s) to tenants still block deletion', stragglers;
  END IF;
END $$;
