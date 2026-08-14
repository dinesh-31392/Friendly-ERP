-- 038: re-run the composite-foreign-key sweep from 033.
--
-- WHY AGAIN
--
-- 033 rebuilt every tenant→tenant foreign key as (child_col, tenant_id) so that
-- a row in one tenant cannot point at a row in another. It left the count at
-- zero. Migration 036 then added the leasing schema with four plain
-- `REFERENCES users(id)` keys, and the count was four again:
--
--   lease_receipts.received_by      maintenance_bills.created_by
--   lease_agreements.created_by     owner_payouts.approved_by
--
-- Exactly the shape of the original bug. RLS is satisfied — the row's own
-- tenant_id is correct — while the row names a person the tenant cannot see.
-- On owner_payouts.approved_by that is worse than cosmetic: the approver of a
-- payout is the audit trail for money leaving the business, and it could be
-- recorded as somebody in another company entirely.
--
-- WHY A SWEEP RATHER THAN FOUR ALTER STATEMENTS
--
-- Because this has now happened twice. Naming the four constraints fixes today
-- and does nothing for the next module. The sweep is idempotent — it only
-- touches keys that are single-column, tenant→tenant, and not already
-- composite — so it can be re-run whenever this regresses, and a future
-- migration can end with it as a guard.
--
-- The verification suite asserts the count is zero, so a fifth will be caught
-- by CI rather than by reading a table.

DO $$
DECLARE
  r          record;
  child_col  text;
  del_clause text;
  rebuilt    int := 0;
  skipped    int := 0;
BEGIN
  FOR r IN
    SELECT con.oid, con.conname, con.conrelid, con.confrelid,
           con.conrelid::regclass::text  AS child,
           con.confrelid::regclass::text AS parent,
           con.confdeltype, con.conkey
      FROM pg_constraint con
      JOIN pg_class cc ON cc.oid = con.conrelid
      JOIN pg_namespace cn ON cn.oid = cc.relnamespace
     WHERE con.contype = 'f'
       AND cn.nspname = 'public'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.conrelid  AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped)
       AND NOT EXISTS (
             SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey) AND a.attname = 'tenant_id')
       AND array_length(con.conkey, 1) = 1
  LOOP
    SELECT a.attname INTO child_col
      FROM pg_attribute a
     WHERE a.attrelid = r.conrelid AND a.attnum = r.conkey[1];

    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint u
       WHERE u.conrelid = r.confrelid
         AND u.contype IN ('u','p')
         AND array_length(u.conkey, 1) = 2
         AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
                FROM pg_attribute a
               WHERE a.attrelid = u.conrelid AND a.attnum = ANY(u.conkey))
             = ARRAY['id','tenant_id']
    ) THEN
      RAISE NOTICE '038: skipping %.% — % has no UNIQUE (id, tenant_id)', r.child, child_col, r.parent;
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    -- SET NULL must name the FK column alone: nulling tenant_id would break its
    -- NOT NULL and orphan the row from its own tenant.
    del_clause := CASE r.confdeltype
      WHEN 'c' THEN ' ON DELETE CASCADE'
      WHEN 'r' THEN ' ON DELETE RESTRICT'
      WHEN 'n' THEN format(' ON DELETE SET NULL (%I)', child_col)
      ELSE ''
    END;

    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.child, r.conname);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I, tenant_id) REFERENCES %I (id, tenant_id)%s',
      r.child, r.conname, child_col, r.parent, del_clause);
    rebuilt := rebuilt + 1;
  END LOOP;

  RAISE NOTICE '038: % foreign keys made tenant-composite, % skipped', rebuilt, skipped;
END $$;

DO $$
DECLARE remaining int;
BEGIN
  SELECT count(*) INTO remaining
    FROM pg_constraint con
   WHERE con.contype = 'f'
     AND array_length(con.conkey, 1) = 1
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.conrelid  AND a.attname = 'tenant_id')
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname = 'tenant_id');
  IF remaining > 0 THEN
    RAISE WARNING '038: % tenant→tenant foreign keys are STILL single-column', remaining;
  ELSE
    RAISE NOTICE '038: every tenant→tenant foreign key is composite again';
  END IF;
END $$;
