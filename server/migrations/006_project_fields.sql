-- ─── 006: SPA-parity fields for projects ────────────────────────────────────
-- The CRM UI carries a project `type`, an `amenities` list and a
-- `micrositePublished` flag that the addendum schema (003) didn't include.
-- Adding them here lets the projects API persist the full Project shape instead
-- of silently dropping those fields on write.
--
-- RLS is already ENABLED + FORCEd on `projects` (003) and grants are table-level
-- (001 §12), so new columns inherit both — nothing else to wire.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS type                text    NOT NULL DEFAULT 'Residential',
  ADD COLUMN IF NOT EXISTS amenities           jsonb   NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS microsite_published boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN projects.type IS 'Residential | Commercial | Villa | Plotted … (UI-defined)';
COMMENT ON COLUMN projects.amenities IS 'JSON array of amenity labels shown on the microsite.';
COMMENT ON COLUMN projects.microsite_published IS 'Whether the public project microsite is live.';
