-- ─── 058: e-invoicing (IRN) ────────────────────────────────────────────────
--
-- Since October 2020 an invoice above the turnover threshold must be registered
-- with the Invoice Registration Portal BEFORE it is issued. The portal returns
-- an Invoice Reference Number, an acknowledgement number and date, and a
-- digitally signed QR code. An invoice in scope without an IRN is not a valid
-- tax invoice: the buyer cannot claim input credit against it.
--
-- WHY A TABLE AND NOT FOUR MORE COLUMNS ON `invoices`
--
-- A registration has its own lifecycle that the invoice does not share. It is
-- prepared, then registered, then possibly cancelled — and a cancelled
-- registration must remain readable afterwards, because the IRN it burned can
-- never be reissued. Folding that into `invoices` would mean nulling the fields
-- on cancellation and losing the record of what was registered.
--
-- It also stores the exact payload that was sent. When the portal rejects
-- something months later, the question is always what was actually submitted,
-- and reconstructing it from the invoice as it stands today answers a different
-- question.
--
-- SCOPE, WHICH IS THE PART THAT GETS MISSED
--
-- E-invoicing covers B2B, SEZ, exports and deemed exports. It does NOT cover
-- B2C. A flat sold to an individual with no GSTIN never gets an IRN however
-- large the consideration, so `buyer_gstin` is NOT NULL here — a row in this
-- table is by definition a supply within scope.
--
-- THE 24-HOUR WINDOW
--
-- Cancellation is accepted for 24 hours from acknowledgement and not one minute
-- longer; after that the only remedy is a credit note. That deadline is stored
-- rather than computed on read, so a row remains truthful about the window it
-- actually had even if the rule changes.

CREATE TABLE IF NOT EXISTS einvoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- The composite FK keeps an einvoice and its invoice in the same workspace:
  -- a tenant_id that disagrees with the invoice's is rejected by the database
  -- rather than by whichever handler remembered to check.
  invoice_id     uuid NOT NULL,
  FOREIGN KEY (invoice_id, tenant_id) REFERENCES invoices (id, tenant_id) ON DELETE CASCADE,

  -- INV, CRN or DBN. A credit or debit note is registered separately and gets
  -- an IRN of its own.
  doc_type       text NOT NULL DEFAULT 'INV' CHECK (doc_type IN ('INV', 'CRN', 'DBN')),
  doc_no         text NOT NULL CHECK (length(doc_no) BETWEEN 1 AND 16),
  issue_date     date NOT NULL,
  financial_year text NOT NULL,

  supplier_gstin text NOT NULL CHECK (length(supplier_gstin) = 15),
  -- NOT NULL by design: see the scope note above. B2C never reaches this table.
  buyer_gstin    text NOT NULL CHECK (length(buyer_gstin) = 15),

  taxable_value  numeric(14,2) NOT NULL DEFAULT 0,
  total_value    numeric(14,2) NOT NULL DEFAULT 0,

  -- The IRN we derived. 64 hex characters of SHA-256. Kept even before
  -- registration so the value the portal returns can be compared rather than
  -- accepted — a response crossed with another invoice is caught here, not at
  -- the buyer's credit claim months later.
  irn            text CHECK (irn IS NULL OR irn ~ '^[0-9a-f]{64}$'),

  status         text NOT NULL DEFAULT 'prepared'
                 CHECK (status IN ('prepared', 'registered', 'cancelled', 'rejected')),

  -- What the portal said. Absent until it has said it.
  ack_no         text,
  ack_date       timestamptz,
  signed_qr      text,
  cancel_reason  text,
  cancelled_at   timestamptz,
  reject_reason  text,

  -- Exactly what was sent, as sent.
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, tenant_id),

  -- One live registration per document. A cancelled one stays in the table but
  -- must not block a corrected re-registration, so the constraint is partial.
  -- Two rows in 'prepared' for the same invoice is a double-submission bug.
  CONSTRAINT einvoices_ack_shape CHECK (
    (status <> 'registered') OR (ack_no IS NOT NULL AND ack_date IS NOT NULL AND irn IS NOT NULL)
  ),
  CONSTRAINT einvoices_cancel_shape CHECK (
    (status <> 'cancelled') OR (cancelled_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_einvoices_live
  ON einvoices (tenant_id, invoice_id, doc_type)
  WHERE status IN ('prepared', 'registered');

-- An IRN is unique at the portal, and burned forever once issued — but the
-- uniqueness is scoped to the TENANT here, not the whole table.
--
-- The IRN already hashes the supplier GSTIN, so two workspaces can only collide
-- if they share one, which is a data error about who owns that GSTIN rather
-- than something this table should adjudicate. A global index makes one
-- workspace's registration fail because of a row it cannot see, which is both a
-- cross-tenant coupling and a way to probe for another tenant's documents.
CREATE UNIQUE INDEX IF NOT EXISTS uq_einvoices_irn
  ON einvoices (tenant_id, irn) WHERE irn IS NOT NULL AND status = 'registered';

ALTER TABLE einvoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE einvoices FORCE  ROW LEVEL SECURITY;

-- CREATE POLICY has no IF NOT EXISTS, so a re-run would fail on it while every
-- other statement here is happy to repeat. Dropping first keeps the whole file
-- re-runnable, which matters when a migration is corrected before release.
DROP POLICY IF EXISTS tenant_rows ON einvoices;
CREATE POLICY tenant_rows ON einvoices USING (tenant_id = app_current_tenant());

CREATE INDEX IF NOT EXISTS idx_einvoices_tenant ON einvoices (tenant_id, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_einvoices_invoice ON einvoices (tenant_id, invoice_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON einvoices TO app_user;
GRANT ALL ON einvoices TO app_platform;

-- Whether this workspace is above the turnover threshold at all. Below it,
-- e-invoicing is not merely optional — registering is not expected, so the UI
-- should not be nagging about invoices that need no IRN. Defaults to false
-- because most builders on a first workspace are below it, and a wrong default
-- here produces alarming and meaningless warnings.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS einvoicing_enabled boolean NOT NULL DEFAULT false;

-- The IRP validates the seller block, and `Loc` and `Pin` are mandatory in it.
-- `tenants.address` is one free-text line, which cannot be split into a city
-- and a pincode reliably enough to put on a tax document — so they are stored
-- as their own fields rather than parsed out of prose at submission time.
--
-- Left empty by default, and the eligibility check reports them as missing.
-- An empty string is not neutral to the portal: it validates what is present,
-- so sending `Loc: ""` fails where the builder simply had not filled it in.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS city    text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pincode text NOT NULL DEFAULT ''
    CONSTRAINT tenants_pincode_shape CHECK (pincode = '' OR pincode ~ '^[1-9][0-9]{5}$');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
     WHERE tc.table_name = 'einvoices' AND rc.delete_rule = 'CASCADE'
  ) THEN
    RAISE EXCEPTION 'einvoices.tenant_id must cascade on tenant delete';
  END IF;
END $$;
