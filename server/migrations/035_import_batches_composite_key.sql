-- 035: the one foreign key migration 033 had to skip.
--
-- 033 made every tenant→tenant foreign key composite, and reported skipping
-- exactly one: import_rows_staging.batch_id → import_batches. Its parent had no
-- UNIQUE (id, tenant_id) for a composite key to reference, so 033 left it alone
-- and said so rather than failing the run.
--
-- Same hole as the rest: staged CSV rows could name a batch belonging to
-- another tenant. Narrow — the staging table is written by an import that
-- already holds the batch it just created — but "narrow" is how the crm_tasks
-- one looked too, right up until it was reproduced.

ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batches_id_tenant_id_key;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE import_rows_staging DROP CONSTRAINT IF EXISTS import_rows_staging_batch_id_fkey;
ALTER TABLE import_rows_staging ADD CONSTRAINT import_rows_staging_batch_id_fkey
  FOREIGN KEY (batch_id, tenant_id) REFERENCES import_batches (id, tenant_id) ON DELETE CASCADE;

-- CASCADE, deliberately: staging rows are the raw parse of one upload and mean
-- nothing without their batch. Deleting a batch should take them with it rather
-- than leave orphans nothing will ever read.

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
    RAISE WARNING '035: % tenant→tenant foreign keys are still single-column', remaining;
  ELSE
    RAISE NOTICE '035: every tenant→tenant foreign key is now composite';
  END IF;
END $$;
