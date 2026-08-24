-- 042: the RERA designated account, and the 70% rule.
--
-- THE OBLIGATION
--
-- Under section 4(2)(l)(D) of the Real Estate (Regulation and Development)
-- Act, a promoter must deposit seventy per cent of the amounts realised from
-- allottees for a registered project into a separate account, to be used only
-- for construction and land cost. Withdrawals are in proportion to completion
-- and need certification.
--
-- The ledger had no concept of a restricted account, so a booking receipt was
-- indistinguishable from free cash. A RERA-registered developer could not use
-- this product without keeping a parallel spreadsheet — which is the thing the
-- ERP exists to replace.
--
-- WHAT THIS DOES, AND DELIBERATELY DOES NOT
--
-- It RECORDS the obligation against every receipt and reports the position:
-- what was collected, what seventy per cent of it comes to, what is actually
-- in the designated account, and the shortfall.
--
-- It does NOT move money and does NOT post to the ledger. Sweeping cash
-- between accounts and choosing the journal treatment are decisions with the
-- promoter's auditor's name on them, and a migration that guessed at them
-- would produce entries somebody has to reverse. The number is the useful
-- part; the transfer is a human act this makes visible and measurable.
--
-- The registration NUMBER is not duplicated here. projects.rera_number already
-- holds it, and a second copy is a second thing to keep in step.

CREATE TABLE IF NOT EXISTS rera_registrations (
  id                        uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid          NOT NULL REFERENCES tenants(id),
  project_id                uuid          NOT NULL,
  registered_on             date,
  valid_until               date,
  -- Seventy per cent is the statute's figure, but a state authority may impose
  -- a stricter one and a promoter may voluntarily ring-fence more. Never less
  -- than the statute — enforced below rather than left to the UI.
  escrow_pct                numeric(5,2)  NOT NULL DEFAULT 70
                                          CHECK (escrow_pct >= 70 AND escrow_pct <= 100),
  designated_bank_account_id uuid,
  status                    text          NOT NULL DEFAULT 'active'
                                          CHECK (status IN ('active', 'lapsed', 'surrendered')),
  created_at                timestamptz   NOT NULL DEFAULT now()
);

-- One registration per project. A project registered twice is a data entry
-- mistake, and the escrow position would silently double-count.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_per_project
  ON rera_registrations (project_id);

ALTER TABLE rera_registrations DROP CONSTRAINT IF EXISTS rera_registrations_project_fkey;
ALTER TABLE rera_registrations ADD CONSTRAINT rera_registrations_project_fkey
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE rera_registrations DROP CONSTRAINT IF EXISTS rera_registrations_bank_fkey;
ALTER TABLE rera_registrations ADD CONSTRAINT rera_registrations_bank_fkey
  FOREIGN KEY (designated_bank_account_id, tenant_id) REFERENCES bank_accounts (id, tenant_id)
  ON DELETE SET NULL (designated_bank_account_id);

ALTER TABLE rera_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rera_registrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON rera_registrations;
CREATE POLICY tenant_rows ON rera_registrations USING (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON rera_registrations TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON rera_registrations TO app_platform;

-- payments is referenced compositely below for the first time, so it needs the
-- key that FK points at — and it needs it BEFORE the constraint is declared,
-- not after. Guarded rather than DROP-then-ADD: dropping a key other
-- constraints depend on, only to re-add an identical one, is how a
-- tenant-isolation constraint disappears for the length of a migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'payments'::regclass
       AND contype IN ('u','p')
       AND array_length(conkey, 1) = 2
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
              FROM pg_attribute a
             WHERE a.attrelid = conrelid AND a.attnum = ANY(conkey)) = ARRAY['id','tenant_id']
  ) THEN
    ALTER TABLE payments ADD CONSTRAINT payments_id_tenant_id_key UNIQUE (id, tenant_id);
  END IF;
END $$;

/**
 * What one receipt owes the designated account.
 *
 * Frozen at allocation, like a demand letter's interest and for the same
 * reason: the split that applied when the money came in must stay
 * reproducible after the percentage, the registration or the payment has
 * changed. A view recomputing it would rewrite history every time a rate moved.
 */
CREATE TABLE IF NOT EXISTS escrow_allocations (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid          NOT NULL REFERENCES tenants(id),
  payment_id     uuid          NOT NULL,
  project_id     uuid          NOT NULL,
  receipt_amount numeric(14,2) NOT NULL,
  escrow_amount  numeric(14,2) NOT NULL,
  free_amount    numeric(14,2) NOT NULL,
  escrow_pct     numeric(5,2)  NOT NULL,
  allocated_on   date          NOT NULL DEFAULT CURRENT_DATE,
  created_at     timestamptz   NOT NULL DEFAULT now(),
  -- The two halves must reconstruct the receipt exactly. Rounding the escrow
  -- share and then rounding the free share independently loses a paisa on
  -- roughly half of all receipts, and the promoter's account never ties out.
  CONSTRAINT escrow_split_is_exact CHECK (escrow_amount + free_amount = receipt_amount)
);

-- One allocation per payment. Running the allocator twice must not double the
-- obligation, and this is what makes that structural rather than a rule the
-- caller has to remember.
CREATE UNIQUE INDEX IF NOT EXISTS uq_escrow_per_payment
  ON escrow_allocations (payment_id);

ALTER TABLE escrow_allocations DROP CONSTRAINT IF EXISTS escrow_allocations_payment_fkey;
ALTER TABLE escrow_allocations ADD CONSTRAINT escrow_allocations_payment_fkey
  FOREIGN KEY (payment_id, tenant_id) REFERENCES payments (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE escrow_allocations DROP CONSTRAINT IF EXISTS escrow_allocations_project_fkey;
ALTER TABLE escrow_allocations ADD CONSTRAINT escrow_allocations_project_fkey
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE escrow_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE escrow_allocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON escrow_allocations;
CREATE POLICY tenant_rows ON escrow_allocations USING (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON escrow_allocations TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON escrow_allocations TO app_platform;

CREATE INDEX IF NOT EXISTS idx_escrow_by_project
  ON escrow_allocations (tenant_id, project_id, allocated_on);


/**
 * Split a receipt, exactly.
 *
 * Rounds the escrow share and DERIVES the free share by subtraction, so the
 * two always add back to the receipt. Rounding both independently is the
 * classic way a split loses a paisa; the CHECK constraint above would then
 * reject the row, which is the point of having it.
 */
CREATE OR REPLACE FUNCTION escrow_split(p_receipt numeric, p_pct numeric)
RETURNS TABLE (escrow numeric, free numeric)
LANGUAGE sql IMMUTABLE
AS $$
  SELECT e, round(p_receipt, 2) - e
    FROM (SELECT round(round(p_receipt, 2) * p_pct / 100, 2) AS e) s
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='escrow_allocations')
 AND EXISTS (SELECT 1 FROM pg_proc WHERE proname='escrow_split') THEN
    RAISE NOTICE '042: the 70%% rule is measurable';
  ELSE
    RAISE WARNING '042: incomplete';
  END IF;
END $$;
