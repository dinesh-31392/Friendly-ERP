-- ─── 019: Land acquisition + Business development ──────────────────────────
-- Deal-sourcing pipelines: land parcels (+ feasibility runs + land documents)
-- and BD opportunities (+ market reports). Previously localStorage-only.
-- Enum-ish columns are plain text (the app validates the vocabulary) so the
-- schema stays flexible; FORCE RLS + grants on every table.

CREATE TABLE IF NOT EXISTS land_leads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reference_source  text NOT NULL DEFAULT '',
  owner_name        text NOT NULL DEFAULT '',
  owner_contact     text NOT NULL DEFAULT '',
  location          text NOT NULL DEFAULT '',
  city              text NOT NULL DEFAULT '',
  state             text NOT NULL DEFAULT '',
  pincode           text NOT NULL DEFAULT '',
  survey_number     text NOT NULL DEFAULT '',
  area_acres        numeric(14,3) NOT NULL DEFAULT 0,
  asking_price      numeric(16,2) NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'sourced',
  rejection_reason  text,
  assigned_to       uuid,
  ownership_type    text,
  zoning            text,
  fsi_permissible   numeric(6,2),
  fsi_consumed      numeric(6,2),
  road_width_ft     numeric(8,2),
  is_encumbered     boolean NOT NULL DEFAULT false,
  encumbrance_notes text,
  litigation_status text NOT NULL DEFAULT 'clear',
  duplicate_of      uuid,
  project_id        uuid,
  latest_score      integer,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE SET NULL (project_id)
);

CREATE TABLE IF NOT EXISTS feasibility_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  land_lead_id      uuid NOT NULL,
  cost_per_sqft     numeric(14,2) NOT NULL DEFAULT 0,
  saleable_area     numeric(16,2) NOT NULL DEFAULT 0,
  estimated_revenue numeric(18,2) NOT NULL DEFAULT 0,
  margin_percent    numeric(6,2) NOT NULL DEFAULT 0,
  score             integer NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  capped_by_risk    boolean NOT NULL DEFAULT false,
  computed_by       uuid,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (land_lead_id, tenant_id) REFERENCES land_leads (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS land_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  land_lead_id        uuid NOT NULL,
  doc_type            text NOT NULL DEFAULT '',
  version             integer NOT NULL DEFAULT 1,
  file_name           text NOT NULL DEFAULT '',
  verification_status text NOT NULL DEFAULT 'pending',
  verified_by         uuid,
  verified_at         timestamptz,
  uploaded_by         uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (land_lead_id, tenant_id) REFERENCES land_leads (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bd_leads (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  opportunity_type      text NOT NULL DEFAULT '',
  source                text NOT NULL DEFAULT '',
  counterparty_name     text NOT NULL DEFAULT '',
  counterparty_contact  text NOT NULL DEFAULT '',
  city                  text NOT NULL DEFAULT '',
  stage                 text NOT NULL DEFAULT 'prospecting',
  estimated_deal_value  numeric(18,2) NOT NULL DEFAULT 0,
  closed_lost_reason    text,
  owned_by              uuid,
  jv_structure          text,
  revenue_share_percent numeric(6,2),
  area_share_percent    numeric(6,2),
  jv_notes              text,
  land_lead_id          uuid,
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (land_lead_id, tenant_id) REFERENCES land_leads (id, tenant_id) ON DELETE SET NULL (land_lead_id)
);

CREATE TABLE IF NOT EXISTS market_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  area_name    text NOT NULL DEFAULT '',
  report_type  text NOT NULL DEFAULT 'pricing_benchmark',
  findings     text NOT NULL DEFAULT '',
  data_sources text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['land_leads', 'feasibility_records', 'land_documents', 'bd_leads', 'market_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_rows ON %I', t);
    EXECUTE format('CREATE POLICY tenant_rows ON %I USING (tenant_id = app_current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
    EXECUTE format('GRANT ALL ON %I TO app_platform', t);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_land_tenant_status ON land_leads (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_bd_tenant_stage ON bd_leads (tenant_id, stage);
