-- ─── 054: retention periods, and the right to erasure ──────────────────────
--
-- The product held personal data for every lead, buyer, broker and employee in
-- a workspace and had no notion of ever letting any of it go. No retention
-- period, no way to answer an erasure request, and nothing that could say why a
-- record was still there. Under the Digital Personal Data Protection Act, 2023
-- a Data Principal may ask for erasure and a Data Fiduciary has to answer.
--
-- THE RULE EVERYONE GETS WRONG
--
-- Erasure is not "delete everything". Both of the obvious answers are wrong:
--
--   Refusing outright — "we keep financial records" — is not a defence for the
--   lead's phone number, their marketing consent, or the site-visit notes. Most
--   of what a CRM holds has no statutory basis at all.
--
--   Deleting everything is worse. Books of account must be kept for eight
--   years under section 128(5) of the Companies Act, 2013; GST records for
--   seventy-two months; RERA records for the life of the project and beyond.
--   Erasing a registered booking because the buyer asked creates a far larger
--   problem than the one it solves, and the Act does not require it.
--
-- The correct answer is per record: erase what has no basis to be kept, REDACT
-- the personal identifiers on what must be kept, and record the basis for every
-- retention. That last part is the point — an erasure request answered with
-- "we kept some of it" and no reasons is not an answer.
--
-- So `action = 'retained'` REQUIRES a legal basis, as a CHECK. A system that
-- lets someone retain a record without saying why will be used that way.

CREATE TABLE IF NOT EXISTS retention_policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- The thing being kept, in the product's own words rather than a table name,
  -- because one policy covers several tables (a booking implies its schedule,
  -- its payments and its demand letters).
  entity      text NOT NULL,

  -- NULL means "keep indefinitely", which is a legitimate answer for a
  -- statutory record and must be distinguishable from "nobody has decided".
  retain_days integer CHECK (retain_days IS NULL OR retain_days >= 0),

  -- Why. Empty for data kept purely for business convenience — which is the
  -- honest answer for a lost lead, and the answer that makes it erasable.
  legal_basis text NOT NULL DEFAULT '',

  -- A policy the workspace may not weaken. Set on the rows seeded from statute,
  -- so a builder can extend a retention period but cannot shorten one below
  -- what the law requires.
  statutory   boolean NOT NULL DEFAULT false,

  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, entity),
  UNIQUE (id, tenant_id),
  CONSTRAINT retention_statutory_needs_basis
    CHECK (NOT statutory OR length(btrim(legal_basis)) > 0)
);

CREATE TABLE IF NOT EXISTS erasure_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  subject_type  text NOT NULL DEFAULT 'lead'
                CHECK (subject_type IN ('lead', 'portal_user', 'broker', 'employee')),
  -- The record the request resolves to, once it has been identified. Nullable
  -- because a request can arrive naming only an email address.
  subject_id    uuid,
  subject_email text NOT NULL DEFAULT '',
  subject_phone text NOT NULL DEFAULT '',
  subject_name  text NOT NULL DEFAULT '',

  received_on   date NOT NULL DEFAULT CURRENT_DATE,
  channel       text NOT NULL DEFAULT 'email',

  status        text NOT NULL DEFAULT 'received'
                CHECK (status IN ('received', 'verified', 'completed', 'refused')),

  -- Identity has to be established before anything is destroyed. An erasure
  -- request is a perfect way to delete a rival's pipeline if anyone can file
  -- one against any email address.
  verified_at   timestamptz,
  verified_by   uuid,
  verification_note text NOT NULL DEFAULT '',

  completed_at  timestamptz,
  refused_reason text NOT NULL DEFAULT '',

  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, tenant_id),
  -- Refusal is a decision the Act requires to be communicated, so it has to
  -- carry a reason.
  CONSTRAINT erasure_refusal_needs_reason
    CHECK (status <> 'refused' OR length(btrim(refused_reason)) > 0),
  -- Nothing is erased against an unverified identity.
  CONSTRAINT erasure_completion_needs_verification
    CHECK (status <> 'completed' OR verified_at IS NOT NULL)
);

/**
 * What was actually done, record by record.
 *
 * The evidence that answers "what did you do with my data". A request with no
 * action rows is a claim; this is the trail behind it.
 */
CREATE TABLE IF NOT EXISTS erasure_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id  uuid NOT NULL,

  entity      text NOT NULL,
  record_id   uuid,
  -- How many rows this covers, for the cases where the action is a sweep over
  -- several (a lead's activities, a customer's notes).
  record_count integer NOT NULL DEFAULT 1,

  action      text NOT NULL
              CHECK (action IN ('erased', 'redacted', 'retained')),

  -- Required whenever something is kept. This is the constraint that turns
  -- "we kept some of it" into an answer.
  legal_basis text NOT NULL DEFAULT '',

  detail      text NOT NULL DEFAULT '',
  performed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, tenant_id),
  FOREIGN KEY (request_id, tenant_id) REFERENCES erasure_requests (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT erasure_retention_needs_basis
    CHECK (action <> 'retained' OR length(btrim(legal_basis)) > 0)
);

ALTER TABLE retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_policies FORCE  ROW LEVEL SECURITY;
ALTER TABLE erasure_requests   ENABLE ROW LEVEL SECURITY;
ALTER TABLE erasure_requests   FORCE  ROW LEVEL SECURITY;
ALTER TABLE erasure_actions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE erasure_actions    FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_rows ON retention_policies;
CREATE POLICY tenant_rows ON retention_policies USING (tenant_id = app_current_tenant());
DROP POLICY IF EXISTS tenant_rows ON erasure_requests;
CREATE POLICY tenant_rows ON erasure_requests   USING (tenant_id = app_current_tenant());
DROP POLICY IF EXISTS tenant_rows ON erasure_actions;
CREATE POLICY tenant_rows ON erasure_actions    USING (tenant_id = app_current_tenant());

CREATE INDEX IF NOT EXISTS idx_erasure_requests_tenant ON erasure_requests (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_erasure_actions_request ON erasure_actions (request_id);

/**
 * Seed the statutory floors for every existing workspace, and for any created
 * later.
 *
 * These are the periods a builder does not get to choose. The retention values
 * are deliberately generous rather than exact: the Companies Act counts eight
 * years from the end of the relevant financial year, not from the row's
 * timestamp, and a sweep that deletes a fortnight early is a compliance failure
 * while one that deletes a fortnight late is not.
 */
CREATE OR REPLACE FUNCTION seed_retention_policies(p_tenant uuid)
RETURNS void
LANGUAGE sql AS $$
INSERT INTO retention_policies (tenant_id, entity, retain_days, legal_basis, statutory)
SELECT p_tenant, v.entity, v.days, v.basis, v.statutory
  FROM (VALUES
   ('bookings',        3650, 'Books of account — Companies Act, 2013 s.128(5); Income Tax Act, 1961 Rule 6F', true),
   ('invoices',        3650, 'Books of account — Companies Act, 2013 s.128(5)', true),
   ('payments',        3650, 'Books of account — Companies Act, 2013 s.128(5)', true),
   ('journal_entries', 3650, 'Books of account — Companies Act, 2013 s.128(5)', true),
   ('tax_records',     2190, 'GST records — CGST Act, 2017 s.36 (72 months from the due date of the annual return)', true),
   ('audit_logs',      3650, 'Evidence of processing and access — retained to answer a supervisory enquiry', true),
   -- The interesting one. A lead nobody converted is held for business
   -- convenience and nothing more, which is precisely why it is erasable on
   -- request and swept when it goes cold.
   ('leads',           1095, '', false),
   ('lead_activities', 1095, '', false),
   ('site_visits',     1095, '', false)
 ) AS v(entity, days, basis, statutory)
ON CONFLICT (tenant_id, entity) DO NOTHING;
$$;

-- Every EXISTING workspace.
SELECT seed_retention_policies(id) FROM tenants;

/**
 * And every workspace created from now on.
 *
 * Seeding only the tenants that existed when this migration ran would leave
 * every workspace signed up afterwards with no retention policy at all — no
 * statutory floor, nothing for the sweep to read, and an erasure request with
 * no basis to cite. A trigger rather than a line in the signup handler because
 * there is more than one path that creates a tenant (signup, the seeder, the
 * test fixtures), and the one that gets forgotten is the one that matters.
 */
CREATE OR REPLACE FUNCTION seed_retention_policies_on_tenant()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM seed_retention_policies(NEW.id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_seed_retention_policies ON tenants;
CREATE TRIGGER trg_seed_retention_policies
  AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION seed_retention_policies_on_tenant();

GRANT EXECUTE ON FUNCTION seed_retention_policies(uuid) TO app_user, app_platform;

GRANT SELECT, INSERT, UPDATE, DELETE ON retention_policies TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON erasure_requests   TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON erasure_actions    TO app_user;
GRANT ALL ON retention_policies TO app_platform;
GRANT ALL ON erasure_requests   TO app_platform;
GRANT ALL ON erasure_actions    TO app_platform;

DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM pg_constraint
   WHERE contype = 'f'
     AND confrelid = 'tenants'::regclass
     AND conrelid IN ('retention_policies'::regclass, 'erasure_requests'::regclass,
                      'erasure_actions'::regclass)
     AND confdeltype <> 'c';
  IF bad > 0 THEN
    RAISE EXCEPTION 'retention tables must cascade on tenant delete';
  END IF;
END $$;
