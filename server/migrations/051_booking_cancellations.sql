-- ─── 051: cancellation and refund ──────────────────────────────────────────
--
-- Cancelling a booking was `DELETE FROM bookings`. The row disappeared, and
-- with it every trace that a buyer had ever paid this builder anything.
--
-- That is not a cancellation, it is an erasure. By the time a booking is
-- cancelled, money has usually changed hands, TDS may have been deducted and
-- remitted against the buyer's PAN, GST may have been paid to the government,
-- a demand letter may have been served, and brokerage may already have been
-- disbursed. A refund cannot be computed from a row that no longer exists, and
-- a dispute cannot be answered with "we deleted it".
--
-- The unit never needed the delete either: the partial unique index on
-- bookings(unit_id) covers only 'active' and 'completed', so a cancelled
-- booking frees the unit for rebooking while staying on the record.
--
-- THE RULE PEOPLE GET WRONG
--
-- Forfeiture is a percentage of the CONSIDERATION, not of what the buyer
-- happened to have paid. An agreement that forfeits 10% against a buyer who
-- has paid 5% means the buyer OWES the balance — the refund is negative. A
-- calculation that clamps at zero quietly writes off money the builder is
-- owed, every time, and nobody notices because the number looks reasonable.
-- The sign is preserved here and named in the API.

CREATE TABLE IF NOT EXISTS booking_cancellations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id     uuid NOT NULL,

  requested_on   date NOT NULL DEFAULT CURRENT_DATE,
  cancelled_on   date,

  reason_category text NOT NULL DEFAULT 'other'
                 CHECK (reason_category IN
                   ('buyer_finance', 'buyer_personal', 'project_delay',
                    'builder_initiated', 'transfer', 'other')),
  reason         text NOT NULL DEFAULT '',

  -- Frozen at the moment of cancellation. Every one of these can move
  -- afterwards — a late receipt lands, a rate is corrected — and the refund
  -- that was agreed must not move with them.
  consideration     numeric(14,2) NOT NULL DEFAULT 0,
  total_received    numeric(14,2) NOT NULL DEFAULT 0,
  forfeiture_pct    numeric(5,2)  NOT NULL DEFAULT 0,
  forfeiture_amount numeric(14,2) NOT NULL DEFAULT 0,

  -- Brokerage already disbursed, administrative charges, anything else the
  -- agreement lets the builder keep. Separate from forfeiture because they are
  -- separately arguable in a dispute.
  other_deductions  numeric(14,2) NOT NULL DEFAULT 0,

  -- GST the builder has already remitted to the government.
  --
  -- Whether it comes back depends on whether a credit note can still be issued
  -- — under s.34(2) CGST, not after 30 November following the end of the
  -- financial year in which the supply was made. Past that date the builder
  -- cannot recover it, and refunding it to the buyer means paying it twice.
  -- Recorded as a distinct figure rather than folded into deductions, because
  -- it is the line a buyer is most likely to challenge.
  gst_remitted      numeric(14,2) NOT NULL DEFAULT 0,
  gst_refundable    boolean       NOT NULL DEFAULT false,

  -- Signed. Negative means the BUYER owes the builder. See the note above.
  refund_amount     numeric(14,2) NOT NULL DEFAULT 0,

  status         text NOT NULL DEFAULT 'requested'
                 CHECK (status IN ('requested', 'approved', 'refunded', 'rejected')),

  approved_by      uuid,
  approved_at      timestamptz,
  refunded_on      date,
  refund_reference text NOT NULL DEFAULT '',

  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, tenant_id),
  FOREIGN KEY (booking_id, tenant_id) REFERENCES bookings (id, tenant_id) ON DELETE CASCADE
);

-- One LIVE cancellation per booking. A rejected one may be superseded by a
-- fresh request — a buyer who is refused once and asks again is normal — but
-- two open requests against the same booking is two people negotiating
-- different refunds for the same money.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cancellation_live_per_booking
  ON booking_cancellations (booking_id) WHERE status <> 'rejected';

ALTER TABLE booking_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_cancellations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON booking_cancellations;
CREATE POLICY tenant_rows ON booking_cancellations USING (tenant_id = app_current_tenant());

CREATE INDEX IF NOT EXISTS idx_cancellations_tenant_created
  ON booking_cancellations (tenant_id, created_at DESC);

/**
 * What a buyer has actually paid this builder for a booking.
 *
 * Receipts against the booking's own milestones, and nothing else. Deliberately
 * NOT the sum of the schedule — a schedule is what was demanded, and the whole
 * question at cancellation is how much of it was answered.
 */
CREATE OR REPLACE FUNCTION booking_total_received(p_booking uuid)
RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(p.amount), 0)::numeric
    FROM payments p
    JOIN payment_schedules s ON s.id = p.payment_schedule_id
   WHERE s.booking_id = p_booking;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON booking_cancellations TO app_user;
GRANT ALL ON booking_cancellations TO app_platform;
GRANT EXECUTE ON FUNCTION booking_total_received(uuid) TO app_user, app_platform;

DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM pg_constraint
   WHERE contype = 'f'
     AND confrelid = 'tenants'::regclass
     AND conrelid  = 'booking_cancellations'::regclass
     AND confdeltype <> 'c';
  IF bad > 0 THEN
    RAISE EXCEPTION 'booking_cancellations.tenant_id must cascade on tenant delete';
  END IF;
END $$;
