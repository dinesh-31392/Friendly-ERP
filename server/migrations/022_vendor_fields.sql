-- ─── 022: Vendor master parity ─────────────────────────────────────────────
-- The SPA's procurement vendor card carries category / contact / rating fields
-- the AP-era vendors table (004) lacked. One vendor master serves both AP and
-- procurement, so the richer fields live here. gst maps to the existing tax_id.

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS category       text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_person text,
  ADD COLUMN IF NOT EXISTS phone          text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS email          citext,
  ADD COLUMN IF NOT EXISTS address        text,
  ADD COLUMN IF NOT EXISTS rating         smallint CHECK (rating BETWEEN 1 AND 5);
