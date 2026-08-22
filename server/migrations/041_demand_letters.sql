-- 041: demand letters and interest on delayed payment.
--
-- THE GAP
--
-- payment_schedules could be marked overdue and that was the end of it.
-- Nothing raised a demand, nothing computed interest, nothing escalated. So
-- collections — the highest-value repetitive job in a developer, and the one
-- with the most money attached — happened in a spreadsheet beside the ERP that
-- holds the schedule.
--
-- WHAT A DEMAND LETTER IS
--
-- Not a notification. It is a numbered document a builder issues against a
-- milestone, carrying principal plus interest accrued to a stated date, which
-- the buyer is expected to pay by a stated date. It gets quoted in disputes.
-- That is why it is a row with its own number and its own issued_on, rather
-- than a view computed on the fly: the amount demanded on a date must still be
-- reproducible after the rate, the schedule or the payment has changed.

-- The rate lives on the BOOKING because the agreement sets it, and two buyers
-- in the same tower can have different ones. Zero — not a tenant default —
-- because charging interest nobody agreed to is worse than charging none.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS delay_interest_pct numeric(5,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN bookings.delay_interest_pct IS
  'Annual % charged on a delayed milestone, from the agreement. 0 = none.';

CREATE TABLE IF NOT EXISTS demand_letters (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES tenants(id),
  booking_id          uuid        NOT NULL,
  payment_schedule_id uuid        NOT NULL,
  -- Per tenant, human-quotable. Assigned server-side inside the raising
  -- transaction, never by the client.
  letter_no           integer     NOT NULL,
  issued_on           date        NOT NULL DEFAULT CURRENT_DATE,
  due_on              date        NOT NULL,
  -- Frozen at issue. Recomputing these later would change what the builder
  -- demanded after they demanded it.
  principal_amount    numeric(14,2) NOT NULL,
  interest_amount     numeric(14,2) NOT NULL DEFAULT 0,
  total_amount        numeric(14,2) NOT NULL,
  interest_pct        numeric(5,2)  NOT NULL DEFAULT 0,
  days_overdue        integer       NOT NULL DEFAULT 0,
  status              text        NOT NULL DEFAULT 'issued'
                                  CHECK (status IN ('issued', 'paid', 'cancelled')),
  reminder_count      integer     NOT NULL DEFAULT 0,
  last_reminder_at    timestamptz,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- One LIVE demand per milestone. A second issued letter for the same milestone
-- is a double demand, which is the mistake this prevents — and the partial
-- index still allows a cancelled one to be superseded by a fresh letter.
CREATE UNIQUE INDEX IF NOT EXISTS uq_demand_live_per_milestone
  ON demand_letters (payment_schedule_id) WHERE status = 'issued';

CREATE UNIQUE INDEX IF NOT EXISTS uq_demand_letter_no
  ON demand_letters (tenant_id, letter_no);

ALTER TABLE demand_letters DROP CONSTRAINT IF EXISTS demand_letters_booking_fkey;
ALTER TABLE demand_letters ADD CONSTRAINT demand_letters_booking_fkey
  FOREIGN KEY (booking_id, tenant_id) REFERENCES bookings (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE demand_letters DROP CONSTRAINT IF EXISTS demand_letters_schedule_fkey;
ALTER TABLE demand_letters ADD CONSTRAINT demand_letters_schedule_fkey
  FOREIGN KEY (payment_schedule_id, tenant_id) REFERENCES payment_schedules (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE demand_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE demand_letters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON demand_letters;
CREATE POLICY tenant_rows ON demand_letters USING (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON demand_letters TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON demand_letters TO app_platform;

CREATE INDEX IF NOT EXISTS idx_demand_letters_tenant_status
  ON demand_letters (tenant_id, status, due_on);

-- payment_schedules needs UNIQUE (id, tenant_id) for the composite FK above.
-- It already has one — `payments` references it — so this only adds the key
-- where it is genuinely absent.
--
-- Written as a guarded ADD rather than DROP-then-ADD, which is the idiom used
-- elsewhere in these migrations and is wrong here: dropping the key would have
-- to cascade through payments_payment_schedule_id_tenant_id_fkey, quietly
-- removing a tenant-isolation constraint to re-add an identical one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'payment_schedules'::regclass
       AND contype IN ('u','p')
       AND array_length(conkey, 1) = 2
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
              FROM pg_attribute a
             WHERE a.attrelid = conrelid AND a.attnum = ANY(conkey)) = ARRAY['id','tenant_id']
  ) THEN
    ALTER TABLE payment_schedules
      ADD CONSTRAINT payment_schedules_id_tenant_id_key UNIQUE (id, tenant_id);
  END IF;
END $$;

/**
 * What is still owed on a milestone.
 *
 * A milestone is not "paid" because its status says so — it is paid when the
 * payments against it add up. Status is maintained by the application and can
 * drift; the payments are the record. This reads the payments.
 */
CREATE OR REPLACE FUNCTION milestone_outstanding(p_schedule uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT GREATEST(
    0,
    (SELECT s.amount FROM payment_schedules s WHERE s.id = p_schedule)
    - COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.payment_schedule_id = p_schedule), 0)
  )
$$;

/**
 * Simple interest on a delayed amount, to the day.
 *
 * 365 rather than 360: Indian construction agreements quote an annual rate and
 * courts read it as actual days over actual days. numeric throughout — money
 * arithmetic in floating point is how a demand letter ends up a paisa off the
 * ledger and someone spends an afternoon on it.
 *
 * Rounded to 2dp at the end, once, rather than at each step.
 */
CREATE OR REPLACE FUNCTION delay_interest(
  p_principal numeric, p_rate_pct numeric, p_days integer
) RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$
  SELECT round(GREATEST(p_principal, 0) * GREATEST(p_rate_pct, 0) / 100
               * GREATEST(p_days, 0)::numeric / 365, 2)
$$;

REVOKE ALL ON FUNCTION milestone_outstanding(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION milestone_outstanding(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION milestone_outstanding(uuid) TO app_platform;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='demand_letters')
 AND EXISTS (SELECT 1 FROM pg_proc WHERE proname='delay_interest') THEN
    RAISE NOTICE '041: collections can raise a demand and charge for delay';
  ELSE
    RAISE WARNING '041: incomplete';
  END IF;
END $$;
