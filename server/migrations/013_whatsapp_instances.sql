-- ─── 013: WhatsApp provider config (adapter foundation) ─────────────────────
-- Per-tenant WhatsApp channel config. Default provider is the free, ToS-safe
-- click-to-chat (agents message from their own WhatsApp; nothing to store here).
-- When a tenant upgrades to the official Meta Cloud API for automation/bulk,
-- their WABA phone-number id + access token live HERE (server-side only) — the
-- token is never sent to the browser (the /api/whatsapp routes strip it). One
-- config row per tenant.

CREATE TABLE IF NOT EXISTS whatsapp_instances (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_type     text NOT NULL DEFAULT 'click_to_chat'
                    CHECK (provider_type IN ('click_to_chat', 'meta_cloud_waba')),
  phone_number_id   text NOT NULL DEFAULT '',   -- Meta Cloud API sender id
  access_token      text NOT NULL DEFAULT '',   -- SECRET — server-only, never returned to a client
  display_phone     text NOT NULL DEFAULT '',   -- human-readable number for the UI
  connection_status text NOT NULL DEFAULT 'disconnected'
                    CHECK (connection_status IN ('connected', 'disconnected', 'error')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

-- RLS: FORCE + tenant policy, matching every other tenant table (003 §9).
ALTER TABLE whatsapp_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_instances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON whatsapp_instances;
CREATE POLICY tenant_rows ON whatsapp_instances USING (tenant_id = app_current_tenant());

-- 001's blanket GRANT ran before this table existed (see 003 §12).
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_instances TO app_user;
GRANT ALL ON whatsapp_instances TO app_platform;
