-- ─── 050: cost sheets, with the tax rules that make them legal ─────────────
--
-- The cost sheet is the single most-used document in Indian residential sales:
-- it is what a buyer is shown before booking, what they take to their bank, and
-- what the eventual agreement is written against. The product had `quotations`
-- — base_amount, additional_charges, discount, total — which is a QUOTE, not a
-- cost sheet. It cannot express a floor rise, a PLC, a club charge, or the two
-- taxes that decide what the buyer actually writes cheques for.
--
-- Two of those taxes are the whole reason this needs a schema rather than a
-- spreadsheet:
--
--   GST is charged on the CONSIDERATION and never on stamp duty or
--   registration. Those are state levies the buyer pays to the government, and
--   charging tax on a tax is the error that shows up in a RERA complaint. The
--   rate is also not one number: the flat attracts 5% (1% affordable), while a
--   maintenance or club deposit attracts 18%. A header-level GST rate is wrong
--   for every sheet that has a deposit line, which is nearly all of them — so
--   the rate lives on the LINE.
--
--   TDS under section 194-IA is deducted BY THE BUYER from what they pay the
--   builder, and remitted to the government on the builder's behalf. It is not
--   an addition to the buyer's cost. Modelling it as a charge — the common
--   mistake — overstates the total by 1% and understates what the builder is
--   owed. The threshold is on the consideration, and once crossed the deduction
--   applies to the WHOLE amount, not the excess over 50 lakh.
--
-- Everything is frozen at issue. A sheet that recomputes when a rate changes is
-- a sheet that says something different from the copy in the buyer's hand.

CREATE TABLE IF NOT EXISTS cost_sheets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  unit_id       uuid,
  lead_id       uuid,
  -- Set when the sheet turns into a booking. The booking's consideration should
  -- be the accepted sheet's, and this is the link that makes that checkable.
  booking_id    uuid,

  -- Per tenant, human-quotable. Assigned server-side, never by the client.
  sheet_no      integer NOT NULL,

  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'issued', 'accepted', 'superseded', 'cancelled')),

  -- Frozen at issue, along with every line. Recomputing later would change what
  -- the buyer was quoted after they were quoted it.
  area_sqft     numeric(12,2) NOT NULL DEFAULT 0,
  base_rate     numeric(14,2) NOT NULL DEFAULT 0,

  -- Section 194-IA. Both are stored per sheet because the rate and the
  -- threshold are statutory and have changed before; a sheet issued under the
  -- old numbers must keep explaining itself under the old numbers.
  tds_pct       numeric(5,2)  NOT NULL DEFAULT 1.00,
  tds_threshold numeric(14,2) NOT NULL DEFAULT 5000000,

  valid_until   date,
  notes         text NOT NULL DEFAULT '',

  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  issued_at     timestamptz,

  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, sheet_no),
  FOREIGN KEY (unit_id, tenant_id)    REFERENCES units    (id, tenant_id),
  FOREIGN KEY (lead_id, tenant_id)    REFERENCES leads    (id, tenant_id),
  FOREIGN KEY (booking_id, tenant_id) REFERENCES bookings (id, tenant_id)
);

CREATE TABLE IF NOT EXISTS cost_sheet_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cost_sheet_id uuid NOT NULL,

  sequence      integer NOT NULL,

  -- What the line IS, which decides how it is taxed and who it is paid to.
  --
  --   consideration — goes to the builder, GST applies (BSP, floor rise, PLC,
  --                   parking, club). This is the base for stamp duty and TDS.
  --   statutory     — goes to the GOVERNMENT (stamp duty, registration). Never
  --                   attracts GST, and is outside the 194-IA consideration.
  --   deposit       — refundable or pass-through (maintenance advance, utility
  --                   deposits). Often 18% GST, and NOT part of consideration.
  --   other         — anything the builder wants on the sheet that is none of
  --                   the above.
  section       text NOT NULL DEFAULT 'consideration'
                CHECK (section IN ('consideration', 'statutory', 'deposit', 'other')),

  label         text NOT NULL,

  -- How the amount was arrived at, kept so the sheet can explain itself rather
  -- than presenting a number the buyer has to take on trust.
  basis         text NOT NULL DEFAULT 'lump_sum'
                CHECK (basis IN ('per_sqft', 'lump_sum', 'pct_of_consideration')),
  rate          numeric(14,4) NOT NULL DEFAULT 0,
  quantity      numeric(14,2) NOT NULL DEFAULT 1,

  -- The computed figure, stored rather than derived on read: the rate that
  -- produced it may be edited, and the sheet must keep saying what it said.
  amount        numeric(14,2) NOT NULL DEFAULT 0,

  -- Per LINE, because a flat is 5% and its maintenance deposit is 18%.
  -- Zero means exempt, which is the correct value for every statutory line.
  gst_pct       numeric(5,2) NOT NULL DEFAULT 0,
  gst_amount    numeric(14,2) NOT NULL DEFAULT 0,

  UNIQUE (id, tenant_id),
  UNIQUE (cost_sheet_id, sequence),
  FOREIGN KEY (cost_sheet_id, tenant_id) REFERENCES cost_sheets (id, tenant_id) ON DELETE CASCADE
);

-- A statutory levy is a payment to the government. GST on it would be tax on a
-- tax — the error that ends up in a RERA complaint — so the database refuses it
-- rather than trusting every future code path to remember.
ALTER TABLE cost_sheet_lines DROP CONSTRAINT IF EXISTS cost_sheet_lines_statutory_no_gst;
ALTER TABLE cost_sheet_lines ADD CONSTRAINT cost_sheet_lines_statutory_no_gst
  CHECK (section <> 'statutory' OR (gst_pct = 0 AND gst_amount = 0));

ALTER TABLE cost_sheets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_sheets       FORCE  ROW LEVEL SECURITY;
ALTER TABLE cost_sheet_lines  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_sheet_lines  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_rows ON cost_sheets;
CREATE POLICY tenant_rows ON cost_sheets USING (tenant_id = app_current_tenant());
DROP POLICY IF EXISTS tenant_rows ON cost_sheet_lines;
CREATE POLICY tenant_rows ON cost_sheet_lines USING (tenant_id = app_current_tenant());

CREATE INDEX IF NOT EXISTS idx_cost_sheets_tenant_created ON cost_sheets (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_sheets_unit           ON cost_sheets (tenant_id, unit_id);
CREATE INDEX IF NOT EXISTS idx_cost_sheet_lines_sheet     ON cost_sheet_lines (cost_sheet_id, sequence);

/**
 * The totals, computed in ONE place.
 *
 * Every consumer — the API, the PDF, the booking that is created from an
 * accepted sheet — needs the same seven numbers, and three implementations of
 * a tax rule is three chances to get 194-IA wrong. Returning them from SQL
 * means the figure on the letter and the figure in the list cannot disagree.
 */
CREATE OR REPLACE FUNCTION cost_sheet_totals(p_sheet uuid)
RETURNS TABLE (
  consideration    numeric,
  statutory        numeric,
  deposits         numeric,
  other            numeric,
  gst              numeric,
  gross            numeric,
  tds              numeric,
  net_to_builder   numeric,
  payable_by_buyer numeric
)
LANGUAGE plpgsql STABLE AS $$
DECLARE s cost_sheets%ROWTYPE;
BEGIN
  SELECT * INTO s FROM cost_sheets WHERE id = p_sheet;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(amount) FILTER (WHERE section = 'consideration'), 0),
         COALESCE(SUM(amount) FILTER (WHERE section = 'statutory'), 0),
         COALESCE(SUM(amount) FILTER (WHERE section = 'deposit'), 0),
         COALESCE(SUM(amount) FILTER (WHERE section = 'other'), 0),
         COALESCE(SUM(gst_amount), 0)
    INTO consideration, statutory, deposits, other, gst
    FROM cost_sheet_lines WHERE cost_sheet_id = p_sheet;

  gross := consideration + statutory + deposits + other + gst;

  -- 194-IA: on the consideration alone, and on ALL of it once the threshold is
  -- crossed — not on the excess. A sheet at 50,00,001 owes TDS on the whole
  -- 50,00,001, which is the part people get wrong.
  tds := CASE WHEN consideration >= s.tds_threshold
              THEN ROUND(consideration * s.tds_pct / 100, 2)
              ELSE 0 END;

  -- The buyer pays the gross; 1% of it goes to the government as TDS instead of
  -- to the builder. The buyer's outlay does not change — which is why TDS is
  -- subtracted from the builder's receipt and NOT added to the buyer's total.
  net_to_builder   := gross - tds;
  payable_by_buyer := gross;
  RETURN NEXT;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON cost_sheets      TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON cost_sheet_lines TO app_user;
GRANT ALL ON cost_sheets      TO app_platform;
GRANT ALL ON cost_sheet_lines TO app_platform;
GRANT EXECUTE ON FUNCTION cost_sheet_totals(uuid) TO app_user, app_platform;

-- Deleting a workspace must not be blocked by its cost sheets (see 048).
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM pg_constraint
   WHERE contype = 'f'
     AND confrelid = 'tenants'::regclass
     AND conrelid IN ('cost_sheets'::regclass, 'cost_sheet_lines'::regclass)
     AND confdeltype <> 'c';
  IF bad > 0 THEN
    RAISE EXCEPTION 'cost sheet tables must cascade on tenant delete';
  END IF;
END $$;
