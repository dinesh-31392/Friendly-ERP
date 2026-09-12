-- ─── 056: GST on invoices, and return preparation ──────────────────────────
--
-- `tax_postings` held a tax_type, a period and an amount — a note that some tax
-- existed. Nothing computed a return, and nothing could have: an invoice
-- recorded `amount` and no tax at all. No taxable value, no rate, no split
-- between CGST/SGST and IGST, no place of supply, no counterparty GSTIN, no
-- HSN. A GSTR-1 cannot be prepared from a row that does not know its own tax.
--
-- THE RULE THAT DECIDES WHICH GOVERNMENT IS PAID
--
-- A supply is intra-state or inter-state, and the answer is not a preference:
-- it is the supplier's state compared with the PLACE OF SUPPLY. Intra-state
-- splits into CGST and SGST, half each, the state's half going to that state.
-- Inter-state is a single IGST at the full rate, collected centrally and
-- apportioned afterwards.
--
-- Getting it backwards is not a labelling error. The money reaches the wrong
-- exchequer, the recipient's input credit does not reconcile, and correcting it
-- means a credit note and a fresh invoice — so both constraints below are in
-- the schema rather than in a handler:
--
--   an invoice never carries IGST *and* CGST/SGST
--   CGST always equals SGST, because it is one rate split in half
--
-- REAL ESTATE SPECIFICS
--
-- Construction of a residential complex is SAC 9954. The rate is 5% without
-- input credit (1% for affordable housing), and GST does not apply at all once
-- a completion certificate is issued — the sale of a completed unit is a
-- transfer of immovable property, outside the levy. `taxable_value` is
-- therefore allowed to be zero with a rate of zero, which is a real and common
-- state, not missing data.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS gstin       text,
  -- The first two digits of the GSTIN. Denormalised because every
  -- intra/inter-state decision reads it, and deriving it per invoice line
  -- turns a string operation into the hot path of a return.
  ADD COLUMN IF NOT EXISTS state_code  text;

ALTER TABLE invoices
  -- The GST invoice number, which is NOT this system's uuid. It must be
  -- consecutive within a financial year and is what appears on the return and
  -- in the recipient's own books.
  ADD COLUMN IF NOT EXISTS invoice_no      text,

  ADD COLUMN IF NOT EXISTS taxable_value   numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gst_rate        numeric(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cgst            numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst            numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst            numeric(14,2) NOT NULL DEFAULT 0,

  -- Two-digit state code. Decides the split, and for a works contract or
  -- immovable property it is the state where the property is — never the
  -- buyer's address, which is the mistake people make.
  ADD COLUMN IF NOT EXISTS place_of_supply text,

  -- Present makes the invoice B2B, absent makes it B2C. That single fact
  -- decides which table of the return it lands in.
  ADD COLUMN IF NOT EXISTS customer_gstin  text,

  -- 9954 is construction. Kept per invoice because a builder also raises
  -- invoices for maintenance and for club services, which are not 9954.
  ADD COLUMN IF NOT EXISTS hsn_sac         text NOT NULL DEFAULT '9954',

  -- Whether the unit had its completion certificate when the invoice was
  -- raised. Past that point the sale is immovable property and outside GST
  -- entirely — a nil-rated invoice that is nil for a REASON, and a return has
  -- to be able to tell that apart from one somebody forgot to tax.
  ADD COLUMN IF NOT EXISTS post_completion boolean NOT NULL DEFAULT false;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_gst_one_regime;
ALTER TABLE invoices ADD CONSTRAINT invoices_gst_one_regime
  CHECK (igst = 0 OR (cgst = 0 AND sgst = 0));

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_gst_halves_equal;
ALTER TABLE invoices ADD CONSTRAINT invoices_gst_halves_equal
  CHECK (cgst = sgst);

-- The return needs invoices for a period, by tax regime, constantly.
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_issue
  ON invoices (tenant_id, issue_date);

/**
 * A prepared return.
 *
 * The payload is stored as filed rather than recomputed on demand: an invoice
 * corrected in March must not silently change what was filed in January. A
 * return is a statement made on a date, and the whole point of keeping it is to
 * be able to show what was said.
 */
CREATE TABLE IF NOT EXISTS gst_returns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  form         text NOT NULL CHECK (form IN ('GSTR1', 'GSTR3B')),
  -- MMYYYY, the format GSTN itself uses.
  period       text NOT NULL CHECK (period ~ '^[0-9]{6}$'),

  status       text NOT NULL DEFAULT 'prepared'
               CHECK (status IN ('prepared', 'filed')),

  -- Totals, lifted out of the payload so a list can show them without parsing.
  taxable_value numeric(14,2) NOT NULL DEFAULT 0,
  cgst          numeric(14,2) NOT NULL DEFAULT 0,
  sgst          numeric(14,2) NOT NULL DEFAULT 0,
  igst          numeric(14,2) NOT NULL DEFAULT 0,
  invoice_count integer NOT NULL DEFAULT 0,

  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,

  prepared_by  uuid,
  prepared_at  timestamptz NOT NULL DEFAULT now(),
  filed_by     uuid,
  filed_at     timestamptz,
  -- The acknowledgement reference GSTN returns. A return marked filed with no
  -- ARN is a claim; with one it is evidence.
  arn          text NOT NULL DEFAULT '',

  UNIQUE (id, tenant_id),
  -- One live return per form per period. A second would make "what did we
  -- file" unanswerable.
  UNIQUE (tenant_id, form, period),
  CONSTRAINT gst_return_filed_needs_arn
    CHECK (status <> 'filed' OR length(btrim(arn)) > 0)
);

ALTER TABLE gst_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_returns FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON gst_returns;
CREATE POLICY tenant_rows ON gst_returns USING (tenant_id = app_current_tenant());

CREATE INDEX IF NOT EXISTS idx_gst_returns_tenant ON gst_returns (tenant_id, period DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON gst_returns TO app_user;
GRANT ALL ON gst_returns TO app_platform;

DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM pg_constraint
   WHERE contype = 'f'
     AND confrelid = 'tenants'::regclass
     AND conrelid  = 'gst_returns'::regclass
     AND confdeltype <> 'c';
  IF bad > 0 THEN
    RAISE EXCEPTION 'gst_returns.tenant_id must cascade on tenant delete';
  END IF;
END $$;
