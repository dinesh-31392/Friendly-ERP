-- ─── 014: Native lead-capture chatbot ──────────────────────────────────────
-- Per-tenant config for the embeddable website chatbot (greeting, which
-- projects to offer, the builder's custom questions, and the qualification
-- thresholds). One row per tenant. Plus a `qualification` snapshot column on
-- leads so a chatbot-captured lead carries the status/score/reasons it was
-- graded with at intake (custom_fields already exists from 001).

CREATE TABLE IF NOT EXISTS chatbot_configs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enabled          boolean NOT NULL DEFAULT true,
  greeting         text NOT NULL DEFAULT '',
  accent_color     text NOT NULL DEFAULT '#6366f1',
  project_mode     text NOT NULL DEFAULT 'all' CHECK (project_mode IN ('all', 'selected')),
  project_ids      jsonb NOT NULL DEFAULT '[]',   -- array of project uuids (when 'selected')
  timeline_options jsonb NOT NULL DEFAULT '[]',   -- array of strings
  custom_fields    jsonb NOT NULL DEFAULT '[]',   -- array of {key,label,type,options,required,qualifying}
  hot_min          smallint NOT NULL DEFAULT 70 CHECK (hot_min BETWEEN 0 AND 100),
  warm_min         smallint NOT NULL DEFAULT 45 CHECK (warm_min BETWEEN 0 AND 100),
  qualify_min      smallint NOT NULL DEFAULT 55 CHECK (qualify_min BETWEEN 0 AND 100),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

-- RLS: FORCE + tenant policy, matching every other tenant table (003 §9).
ALTER TABLE chatbot_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON chatbot_configs USING (tenant_id = app_current_tenant());

-- 001's blanket GRANT ran before this table existed (see 003 §12).
GRANT SELECT, INSERT, UPDATE, DELETE ON chatbot_configs TO app_user;
GRANT ALL ON chatbot_configs TO app_platform;

-- Qualification snapshot on the lead: {status, score, reasons[]}. Nullable —
-- only chatbot/microsite captures set it; manual leads leave it NULL.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS qualification jsonb;
