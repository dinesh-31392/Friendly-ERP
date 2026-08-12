-- 032: when the enquiry actually happened, as distinct from when we recorded it.
--
-- `created_at` is when the row appeared in the ERP. For a lead arriving live
-- from the website, chatbot, portal or WhatsApp those are the same moment, so
-- it has been standing in for both.
--
-- Bulk import breaks that. Upload a CSV of 300 enquiries collected over the
-- past month and every one of them is stamped with the moment you pressed
-- import. Every response-time number computed from it — first-contact speed,
-- ageing buckets, "leads older than 48h" — becomes fiction, and confidently so,
-- because nothing looks wrong.
--
-- So: enquired_at is when the customer got in touch. created_at stays as when
-- the ERP learned about it. Reporting wants the first; auditing wants the
-- second; conflating them loses both.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS enquired_at timestamptz;

-- Existing rows were all captured live, so the two ARE the same for them.
UPDATE leads SET enquired_at = created_at WHERE enquired_at IS NULL;

ALTER TABLE leads
  ALTER COLUMN enquired_at SET DEFAULT now(),
  ALTER COLUMN enquired_at SET NOT NULL;

-- A future enquiry date is a data-entry error, not a real thing. Allow a day of
-- slack for time zones and clock skew rather than rejecting a legitimate row
-- because the importer's machine is ahead of the server.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_enquired_at_not_future;
ALTER TABLE leads ADD CONSTRAINT leads_enquired_at_not_future
  CHECK (enquired_at <= now() + interval '1 day');

-- The lead list and every ageing report sort on this.
CREATE INDEX IF NOT EXISTS idx_leads_tenant_enquired ON leads (tenant_id, enquired_at DESC);
