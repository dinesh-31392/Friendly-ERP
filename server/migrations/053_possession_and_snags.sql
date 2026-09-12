-- ─── 053: possession, and the snag list that gates it ──────────────────────
--
-- The product could sell a flat, demand money for it and cancel it, and had
-- nothing at all for handing it over. Possession is where a residential project
-- generates its complaints, its retention releases and its RERA exposure, and
-- it was the one part of the lifecycle with no record.
--
-- WHAT POSSESSION ACTUALLY IS
--
-- Not a date somebody types. It is a sequence with money and law attached:
--
--   offered   — the builder writes to the allottee saying the flat is ready.
--               Under RERA the offer is what starts the clock, and it can only
--               be made once an occupancy certificate exists — offering
--               possession of a building nobody may legally occupy is the
--               complaint that gets filed.
--   inspected — the buyer walks the flat and raises snags.
--   accepted  — the buyer takes the keys, usually after the snags are closed
--               and always after the dues are cleared.
--
-- THE TWO GATES, AND WHY THE DATABASE HOLDS THEM
--
-- A handover is signed at a site office by whoever is standing there, and the
-- pressure to hand over keys on the day is considerable. Both gates are
-- therefore constraints, not handler checks:
--
--   an offer requires an occupancy certificate reference
--   acceptance requires an accepted_on date and cannot precede the offer
--
-- The dues check has to live in the handler, because it depends on payments,
-- but the shape of the record makes it visible: `dues_outstanding` is frozen
-- onto the row at acceptance, so a handover made against an unpaid balance is
-- a fact on the record rather than an argument later.

CREATE TABLE IF NOT EXISTS possessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id     uuid NOT NULL,

  status         text NOT NULL DEFAULT 'offered'
                 CHECK (status IN ('offered', 'inspected', 'accepted', 'withdrawn')),

  -- The occupancy certificate. Offering possession without one is offering
  -- possession of a building nobody may lawfully occupy.
  oc_reference   text NOT NULL,
  oc_dated_on    date,

  offered_on     date NOT NULL DEFAULT CURRENT_DATE,
  inspected_on   date,
  accepted_on    date,

  -- Frozen at acceptance. What was still owed when the keys changed hands, so
  -- a handover against a balance is on the record rather than in dispute.
  dues_outstanding numeric(14,2) NOT NULL DEFAULT 0,

  -- Who took the keys, in their own words. A handover is signed for.
  received_by    text NOT NULL DEFAULT '',
  notes          text NOT NULL DEFAULT '',

  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, tenant_id),
  FOREIGN KEY (booking_id, tenant_id) REFERENCES bookings (id, tenant_id) ON DELETE CASCADE,

  -- An offer needs a certificate to point at.
  CONSTRAINT possession_oc_required CHECK (length(btrim(oc_reference)) > 0),
  -- Acceptance needs a date, and it cannot precede the offer.
  CONSTRAINT possession_accepted_dated
    CHECK (status <> 'accepted' OR (accepted_on IS NOT NULL AND accepted_on >= offered_on))
);

-- One live possession per booking. A withdrawn offer may be superseded — an
-- offer made too early and pulled back is normal — but two open handovers
-- against one flat is two people about to give away the same keys.
CREATE UNIQUE INDEX IF NOT EXISTS uq_possession_live_per_booking
  ON possessions (booking_id) WHERE status <> 'withdrawn';

/**
 * Snags — the defects a buyer raises when they walk the flat.
 *
 * Attached to the possession rather than the unit, because the list is the
 * record of one handover. A second handover after a resale starts a new list;
 * the first one stays as evidence of what was fixed and when.
 */
CREATE TABLE IF NOT EXISTS snags (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  possession_id  uuid NOT NULL,

  raised_on      date NOT NULL DEFAULT CURRENT_DATE,
  location       text NOT NULL DEFAULT '',
  category       text NOT NULL DEFAULT 'other'
                 CHECK (category IN ('civil', 'plumbing', 'electrical', 'carpentry',
                                     'painting', 'flooring', 'fittings', 'other')),
  description    text NOT NULL,

  -- Severity decides what blocks possession. A missing socket cover is not a
  -- reason to withhold a flat; a leak is.
  severity       text NOT NULL DEFAULT 'minor'
                 CHECK (severity IN ('minor', 'major', 'critical')),

  status         text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'in_progress', 'resolved', 'rejected')),

  assigned_to    uuid,
  target_date    date,
  resolved_on    date,
  resolution     text NOT NULL DEFAULT '',

  -- Photographic evidence, through the file storage added in 049.
  photo_file_id  uuid,

  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, tenant_id),
  FOREIGN KEY (possession_id, tenant_id) REFERENCES possessions (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_to, tenant_id)   REFERENCES users (id, tenant_id),
  FOREIGN KEY (photo_file_id, tenant_id) REFERENCES stored_files (id, tenant_id) ON DELETE SET NULL,

  -- A resolved snag says how and when. "Resolved" with neither is how a snag
  -- list becomes a list of claims nobody can check.
  CONSTRAINT snag_resolution_recorded
    CHECK (status <> 'resolved' OR (resolved_on IS NOT NULL AND length(btrim(resolution)) > 0))
);

ALTER TABLE possessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE possessions FORCE  ROW LEVEL SECURITY;
ALTER TABLE snags       ENABLE ROW LEVEL SECURITY;
ALTER TABLE snags       FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_rows ON possessions;
CREATE POLICY tenant_rows ON possessions USING (tenant_id = app_current_tenant());
DROP POLICY IF EXISTS tenant_rows ON snags;
CREATE POLICY tenant_rows ON snags USING (tenant_id = app_current_tenant());

CREATE INDEX IF NOT EXISTS idx_possessions_tenant_created ON possessions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snags_possession           ON snags (possession_id, status);

/**
 * Snags that stand between a flat and its buyer.
 *
 * Major and critical only. Counting every open snag would block a handover on
 * a chipped skirting board, which is how a gate that should mean something
 * gets routinely overridden until it means nothing.
 */
CREATE OR REPLACE FUNCTION blocking_snag_count(p_possession uuid)
RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::int FROM snags
   WHERE possession_id = p_possession
     AND status IN ('open', 'in_progress')
     AND severity IN ('major', 'critical');
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON possessions TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON snags       TO app_user;
GRANT ALL ON possessions TO app_platform;
GRANT ALL ON snags       TO app_platform;
GRANT EXECUTE ON FUNCTION blocking_snag_count(uuid) TO app_user, app_platform;

DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM pg_constraint
   WHERE contype = 'f'
     AND confrelid = 'tenants'::regclass
     AND conrelid IN ('possessions'::regclass, 'snags'::regclass)
     AND confdeltype <> 'c';
  IF bad > 0 THEN
    RAISE EXCEPTION 'possession tables must cascade on tenant delete';
  END IF;
END $$;
