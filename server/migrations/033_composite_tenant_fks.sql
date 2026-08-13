-- 033: make every tenant→tenant foreign key composite.
--
-- THE HOLE
--
-- Row-level security answers "does this row belong to my tenant?". It says
-- nothing about the rows a row POINTS AT. A plain `crm_tasks.user_id
-- REFERENCES users(id)` is checked against users globally, so tenant A could
-- store a reference to tenant B's user and both the FK and the policy were
-- satisfied:
--
--   SET app.current_tenant_id = <A>;
--   INSERT INTO crm_tasks (tenant_id, user_id, title)
--   VALUES (app_current_tenant(), '<a user in B>', '…');   -- ACCEPTED
--
-- Reproduced before writing this. It matters most where the id comes from a
-- request body — crm_tasks.user_id is assignable by anyone with manage_team —
-- because the row then names a person the caller's tenant cannot resolve, and
-- any join that forgets its own tenant filter surfaces the other tenant's user.
--
-- THE FIX
--
-- Carry tenant_id into the key itself: (user_id, tenant_id) REFERENCES
-- users (id, tenant_id). Pointing at another tenant stops being something the
-- application must remember not to do and becomes something the database
-- cannot represent. Every tenant table already has UNIQUE (id, tenant_id) for
-- exactly this purpose; most FKs simply never used it.
--
-- Applied by iterating pg_constraint rather than listing 35 constraints by
-- hand: a hand-written list is a list that goes stale the next time someone
-- adds a table.

DO $$
DECLARE
  r          record;
  child_col  text;
  del_clause text;
  rebuilt    int := 0;
  skipped    int := 0;
BEGIN
  FOR r IN
    SELECT con.oid,
           con.conname,
           con.conrelid,
           con.confrelid,
           con.conrelid::regclass::text  AS child,
           con.confrelid::regclass::text AS parent,
           con.confdeltype,
           con.conkey,
           con.confkey
      FROM pg_constraint con
      JOIN pg_class cc ON cc.oid = con.conrelid
      JOIN pg_namespace cn ON cn.oid = cc.relnamespace
     WHERE con.contype = 'f'
       AND cn.nspname = 'public'
       -- both sides are tenant-scoped
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.conrelid  AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped)
       -- …and tenant_id is not already part of the key
       AND NOT EXISTS (
             SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey) AND a.attname = 'tenant_id')
       -- single-column keys only; anything wider is already deliberate
       AND array_length(con.conkey, 1) = 1
  LOOP
    SELECT a.attname INTO child_col
      FROM pg_attribute a
     WHERE a.attrelid = r.conrelid AND a.attnum = r.conkey[1];

    -- The parent must expose (id, tenant_id) as a unique key, or the composite
    -- FK has nothing to reference. Skip loudly rather than fail the migration.
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
      RAISE NOTICE '033: skipping %.% — % has no UNIQUE (id, tenant_id)', r.child, child_col, r.parent;
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    -- Preserve the delete behaviour. SET NULL must name the FK column only:
    -- nulling tenant_id would violate its NOT NULL and orphan the row from its
    -- own tenant.
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

  RAISE NOTICE '033: % foreign keys made tenant-composite, % skipped', rebuilt, skipped;
END $$;
