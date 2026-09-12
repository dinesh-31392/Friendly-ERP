-- ─── 059: PAN, and the KYC state that was missing ──────────────────────────
--
-- TDS under section 194-IA has been computed and printed on cost sheets since
-- migration 050: 1% of the consideration, deducted BY THE BUYER and remitted
-- to the Income Tax Department. What was never stored is the identifier that
-- duty is discharged against.
--
-- Form 26QB — the challan-cum-statement the buyer files — requires the PAN of
-- BOTH parties. So the deduction this system calculates could not be filed
-- from what this system held. `cancellationRoutes` already reasons in prose
-- about "TDS remitted against the buyer's PAN"; these are the columns that
-- make that sentence true.
--
-- WHERE EACH ONE GOES
--
-- The buyer's PAN belongs to the PERSON, not the transaction: one buyer with
-- three units files one PAN three times, and storing it per booking would
-- invite three answers. It goes on `customers`, which `bookings.customer_id`
-- already reaches.
--
-- The seller's is the workspace's own, on `tenants`. For a GST-registered
-- builder it is not new information — a GSTIN embeds its holder's PAN at
-- characters 3 to 12 — so it is derivable, and where both are present they are
-- checked against each other. A workspace whose PAN disagrees with its own
-- GSTIN has one of them wrong, and both feed statutory filings.
--
-- NO CHECK CONSTRAINT ON THE SHAPE, DELIBERATELY
--
-- A regex here would reject historical rows on a schema change rather than at
-- the point of entry, which is where a person can fix it. The API validates
-- structure on write. The column stores what it is given, and '' means "not
-- collected yet" — a real and common state, since PAN is required to FILE, not
-- to exist as a customer.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS pan text NOT NULL DEFAULT '';

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS pan text NOT NULL DEFAULT '';

COMMENT ON COLUMN customers.pan IS
  'Buyer PAN for Form 26QB. Personal data — masked in listings, erasable.';
COMMENT ON COLUMN tenants.pan IS
  'The builder''s own PAN. Derivable from gstin characters 3-12 when registered.';

-- ─── The KYC state that did not exist ──────────────────────────────────────
--
-- kyc_status allowed 'pending' and 'verified' only, which forces one value to
-- mean two different things: not started, and checked and failed. A buyer
-- whose documents did not match is not "pending" — nobody is waiting on
-- anything, and treating them as such is how a failed verification quietly
-- becomes a possession handover.
--
-- (The Customers screen already offered 'rejected'; the server refused it with
-- a schema error. This is the half that was missing.)

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_kyc_status_check;
ALTER TABLE customers
  ADD CONSTRAINT customers_kyc_status_check
  CHECK (kyc_status IN ('pending', 'verified', 'rejected'));

-- ─── Erasure coverage ──────────────────────────────────────────────────────
--
-- `customers` was not in the erasure plan at all, though it has always held a
-- name, an email and a phone number. Adding a PAN to a table nobody could
-- erase from would be adding the most identifying field in the product to the
-- one place a Data Principal's request could not reach.
--
-- Erasure is per-table policy driven, so the row is what enables it. Marked
-- non-statutory: a customer record is held for business convenience, and the
-- statutory floor that keeps a BOOKING for eight years lives on bookings, not
-- here. The buyer's name survives on the booking that must be retained; what
-- goes is the standalone contact record and the PAN with it.

INSERT INTO retention_policies (tenant_id, entity, retain_days, statutory, legal_basis)
SELECT t.id, 'customers', NULL, false,
       'Held for business convenience — no statutory basis, so it is erasable on request.'
  FROM tenants t
 WHERE NOT EXISTS (
   SELECT 1 FROM retention_policies r
    WHERE r.tenant_id = t.id AND r.entity = 'customers'
 );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'customers' AND column_name = 'pan'
  ) THEN
    RAISE EXCEPTION 'customers.pan was not created';
  END IF;
END $$;
