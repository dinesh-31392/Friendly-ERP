-- 043: site visits as a scheduled, assignable, closable thing.
--
-- WHY A TABLE AND NOT AN ACTIVITY ROW
--
-- lead_activities already carries a 'site_visit' type with scheduled_at and
-- outcome, so a visit COULD be logged today. What it cannot do is be managed:
-- an activity is an append-only timeline entry with no state. It cannot be
-- reassigned when a rep calls in sick, rescheduled when the buyer asks for
-- Sunday, marked no-show, or counted as a funnel stage — and the site visit is
-- the conversion event in this industry. A builder measures leads, visits and
-- bookings, in that order, and the middle number was unmeasurable.
--
-- The timeline is not abandoned: completing a visit writes a lead_activity, so
-- the lead's history still reads in one place. State lives here, narrative
-- lives there.

CREATE TABLE IF NOT EXISTS site_visits (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants(id),
  lead_id          uuid        NOT NULL,
  -- What they are being shown. Both optional: a first visit is often to a site
  -- office before any specific unit is in play.
  project_id       uuid,
  unit_id          uuid,
  -- Who is taking them. Separate from created_by — a manager books the visit,
  -- a rep conducts it, and the rep is the one who needs telling.
  assigned_to      uuid        NOT NULL,
  scheduled_at     timestamptz NOT NULL,
  duration_minutes integer     NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 5 AND 600),
  status           text        NOT NULL DEFAULT 'scheduled'
                               CHECK (status IN ('scheduled','confirmed','completed','no_show','cancelled')),
  -- Only meaningful once completed. Enforced below rather than trusted.
  outcome          text        CHECK (outcome IN ('interested','not_interested','needs_followup','booked')),
  feedback         text        NOT NULL DEFAULT '',
  -- A rescheduled visit is a NEW row pointing at the one it replaced, rather
  -- than an edited scheduled_at. "How many visits slipped" is a question a
  -- sales head actually asks, and an overwritten timestamp cannot answer it.
  rescheduled_from uuid,
  created_by       uuid,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),

  -- An outcome without a completion is a contradiction, and a completion
  -- without an outcome is a visit nobody wrote up. Both are worth refusing at
  -- the database rather than hoping the UI enforces them.
  CONSTRAINT site_visit_outcome_needs_completion
    CHECK ((status = 'completed') = (outcome IS NOT NULL))
);

ALTER TABLE site_visits DROP CONSTRAINT IF EXISTS site_visits_lead_fkey;
ALTER TABLE site_visits ADD CONSTRAINT site_visits_lead_fkey
  FOREIGN KEY (lead_id, tenant_id) REFERENCES leads (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE site_visits DROP CONSTRAINT IF EXISTS site_visits_assignee_fkey;
ALTER TABLE site_visits ADD CONSTRAINT site_visits_assignee_fkey
  FOREIGN KEY (assigned_to, tenant_id) REFERENCES users (id, tenant_id);

ALTER TABLE site_visits DROP CONSTRAINT IF EXISTS site_visits_project_fkey;
ALTER TABLE site_visits ADD CONSTRAINT site_visits_project_fkey
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id)
  ON DELETE SET NULL (project_id);

-- The composite key comes BEFORE the self-referencing foreign key that points
-- at it. Declared the other way round, Postgres refuses with "no unique
-- constraint matching given keys" — the same ordering mistake migration 042
-- made against payments.
ALTER TABLE site_visits DROP CONSTRAINT IF EXISTS site_visits_id_tenant_id_key;
ALTER TABLE site_visits ADD CONSTRAINT site_visits_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE site_visits DROP CONSTRAINT IF EXISTS site_visits_prior_fkey;
ALTER TABLE site_visits ADD CONSTRAINT site_visits_prior_fkey
  FOREIGN KEY (rescheduled_from, tenant_id) REFERENCES site_visits (id, tenant_id)
  ON DELETE SET NULL (rescheduled_from);

ALTER TABLE site_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_visits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON site_visits;
CREATE POLICY tenant_rows ON site_visits USING (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON site_visits TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON site_visits TO app_platform;

-- The two questions the diary asks: what is coming up, and what is mine.
CREATE INDEX IF NOT EXISTS idx_site_visits_schedule
  ON site_visits (tenant_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_site_visits_assignee
  ON site_visits (tenant_id, assigned_to, scheduled_at);

/**
 * The middle of the funnel, which was previously unmeasurable.
 *
 * Counts DISTINCT leads rather than visits: a buyer brought back three times
 * is one person considering one purchase, and counting visits would make a
 * hard-working rep look like a productive funnel.
 */
CREATE OR REPLACE FUNCTION site_visit_funnel(p_from date, p_to date)
RETURNS TABLE (scheduled bigint, completed bigint, no_show bigint, booked bigint)
LANGUAGE sql STABLE
AS $$
  SELECT count(DISTINCT lead_id) FILTER (WHERE status <> 'cancelled'),
         count(DISTINCT lead_id) FILTER (WHERE status = 'completed'),
         count(DISTINCT lead_id) FILTER (WHERE status = 'no_show'),
         count(DISTINCT lead_id) FILTER (WHERE outcome = 'booked')
    FROM site_visits
   WHERE scheduled_at::date BETWEEN p_from AND p_to
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='site_visits') THEN
    RAISE NOTICE '043: site visits are schedulable, assignable and closable';
  ELSE
    RAISE WARNING '043: incomplete';
  END IF;
END $$;
