-- ─── 007: SPA-parity sales-lifecycle stage on bookings ─────────────────────
-- The bookings table (003) models legal `status`
-- (active|cancelled|transferred|completed) and a partial unique index locks the
-- unit while a booking is active/completed. The CRM UI additionally tracks a
-- SALES lifecycle on each booking — reservation → token → agreement → payment →
-- completed — which is a different axis from status. Persisting it here lets the
-- bookings API carry the full Booking shape instead of dropping `stage` on write.
--
-- RLS is already ENABLED + FORCEd on `bookings` (003) and grants are table-level
-- (001 §12), so the new column inherits both — nothing else to wire.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'reservation'
    CHECK (stage IN ('reservation', 'token', 'agreement', 'payment', 'completed'));

COMMENT ON COLUMN bookings.stage IS 'CRM sales lifecycle (reservation→token→agreement→payment→completed); orthogonal to legal status.';
