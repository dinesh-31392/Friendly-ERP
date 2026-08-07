-- ─── 025: Per-rep WhatsApp sessions via self-hosted Evolution API ───────────
-- 013 gave each tenant ONE channel (click-to-chat or the paid Meta WABA).
-- Evolution API adds a third provider: a self-hosted gateway where EACH SALES
-- REP links their own personal / WhatsApp Business number by scanning a QR,
-- and live chat + drip sends route through that rep's own session.
--
-- Two pieces:
--  • The tenant-level gateway config rides on the existing whatsapp_instances
--    row ('evolution' provider + container URL + API key). The key is a
--    SECRET like access_token — server-only, stripped from every response.
--  • One session row per (tenant, user). The instance_name is what the
--    Evolution container knows the session as; the webhook_token is the
--    shared secret embedded in the per-session webhook URL — an inbound
--    webhook is authenticated by knowing it, so it must be unguessable.

ALTER TABLE whatsapp_instances DROP CONSTRAINT IF EXISTS whatsapp_instances_provider_type_check;
ALTER TABLE whatsapp_instances ADD CONSTRAINT whatsapp_instances_provider_type_check
  CHECK (provider_type IN ('click_to_chat', 'meta_cloud_waba', 'evolution'));

ALTER TABLE whatsapp_instances
  ADD COLUMN IF NOT EXISTS evolution_url     text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS evolution_api_key text NOT NULL DEFAULT '';  -- SECRET — never returned to a client

CREATE TABLE IF NOT EXISTS whatsapp_user_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_name     text NOT NULL,            -- Evolution instance id, e.g. erp-1a2b3c4d-9f8e7d6c
  status            text NOT NULL DEFAULT 'disconnected'
                    CHECK (status IN ('connected', 'connecting', 'disconnected')),
  phone             text NOT NULL DEFAULT '', -- the linked number, learned from the gateway
  webhook_token     text NOT NULL,            -- per-session webhook auth secret
  last_connected_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (instance_name),
  UNIQUE (webhook_token)
);

-- RLS: FORCE + tenant policy (003 §9). The webhook handler resolves rows by
-- token through the platform pool (app_platform is BYPASSRLS), same pattern as
-- the portal login.
ALTER TABLE whatsapp_user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_user_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON whatsapp_user_sessions USING (tenant_id = app_current_tenant());

-- 001's blanket GRANT ran before this table existed (003 §12).
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_user_sessions TO app_user;
GRANT ALL ON whatsapp_user_sessions TO app_platform;
