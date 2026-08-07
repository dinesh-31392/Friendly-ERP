-- ─── 024: Accounts-page parity (RA bills + loans) ──────────────────────────
-- Two gaps the Accounts page needs persisted server-side:
--
--  • RA bills carry a two-stage approval trail. 004 stored WHO signed off at
--    each stage but not WHEN, and dropped the contractor's notes. Without the
--    timestamps the trail cannot answer "how long did finance sit on this",
--    which is the whole point of separating site verification from payment
--    approval.
--  • Loans are amortised client-side from tenure and TDS rate. Those two
--    inputs were never stored, so a rebuilt schedule could not be reproduced
--    from the server's own data.

ALTER TABLE contractor_ra_bills
  ADD COLUMN IF NOT EXISTS notes               text,
  ADD COLUMN IF NOT EXISTS signed_off_at       timestamptz,
  ADD COLUMN IF NOT EXISTS finance_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_by          uuid REFERENCES users(id);

ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS tenure_months integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tds_pct       numeric(5,2) NOT NULL DEFAULT 0;
