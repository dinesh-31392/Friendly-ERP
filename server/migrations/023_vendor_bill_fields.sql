-- ─── 023: Vendor-bill parity with the Billing page ─────────────────────────
-- The SPA's AP card carries a cost-head category (matched against budgets), a
-- settlement timestamp, and free-text notes that the 004 table lacked.

ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS paid_at  timestamptz,
  ADD COLUMN IF NOT EXISTS notes    text;
