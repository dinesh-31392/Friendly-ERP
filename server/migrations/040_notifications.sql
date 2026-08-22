-- 040: notifications that exist on the server.
--
-- THE GAP
--
-- Notification preferences lived in localStorage, keyed per tenant, and that
-- was the whole feature: eight toggles that persisted to one browser and were
-- read by nothing. There was no table, no route, and no sender. The Settings
-- page could promise "notify me when a lead is assigned" and there was no code
-- anywhere that could honour it.
--
-- That is not a cosmetic gap. Every workflow this product is supposed to
-- automate ends in telling a person something happened — a payment is overdue,
-- an approval is waiting, a statutory filing is due on Friday. Without a
-- server-side inbox those features are each half-built no matter how good the
-- rest of them is.
--
-- TWO TABLES
--
--   notifications       what happened, addressed to one user. An inbox row.
--   notification_prefs  whether that user wants a given kind at all.
--
-- Preferences are per USER, not per tenant, which is the second thing the
-- localStorage version had wrong: the key was `..._${tenantId}`, so every
-- person sharing a browser profile shared one set of toggles, and the same
-- person on their phone had different ones.

CREATE TABLE IF NOT EXISTS notifications (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id),
  user_id     uuid        NOT NULL,
  -- Matches the keys the Settings page already shows, so existing toggles map
  -- across without a translation layer.
  kind        text        NOT NULL,
  title       text        NOT NULL,
  body        text        NOT NULL DEFAULT '',
  -- What it is about, so the UI can link straight to the thing. Deliberately
  -- NOT a foreign key: a notification about a deleted lead should survive as a
  -- record that it was sent, and pointing at eleven different tables cannot be
  -- one constraint anyway.
  entity_type text,
  entity_id   uuid,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_user_fkey;
ALTER TABLE notifications ADD CONSTRAINT notifications_user_fkey
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON notifications;
CREATE POLICY tenant_rows ON notifications USING (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO app_platform;

-- The inbox query is always "mine, newest first", and the badge is always
-- "mine, unread". One index serves both.
CREATE INDEX IF NOT EXISTS idx_notifications_inbox
  ON notifications (tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (tenant_id, user_id) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS notification_prefs (
  tenant_id uuid    NOT NULL REFERENCES tenants(id),
  user_id   uuid    NOT NULL,
  kind      text    NOT NULL,
  enabled   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, kind)
);

ALTER TABLE notification_prefs DROP CONSTRAINT IF EXISTS notification_prefs_user_fkey;
ALTER TABLE notification_prefs ADD CONSTRAINT notification_prefs_user_fkey
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE notification_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_prefs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_rows ON notification_prefs;
CREATE POLICY tenant_rows ON notification_prefs USING (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_prefs TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_prefs TO app_platform;

/**
 * Should this user be told about this kind of event?
 *
 * Absence means yes. A user who has never opened Settings has no rows here,
 * and the alternative — defaulting to silence — would mean the feature does
 * nothing until every person individually turns it on, which is how
 * notification systems get a reputation for not working.
 *
 * SECURITY DEFINER and STABLE for the same reasons has_permission() is: it is
 * consulted once per emit, inside a transaction that already carries the
 * tenant context.
 */
CREATE OR REPLACE FUNCTION wants_notification(p_user uuid, p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM notification_prefs
     WHERE user_id = p_user AND kind = p_kind AND enabled = false
  )
$$;

REVOKE ALL ON FUNCTION wants_notification(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wants_notification(uuid, text) TO app_user;
GRANT EXECUTE ON FUNCTION wants_notification(uuid, text) TO app_platform;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='notifications')
 AND EXISTS (SELECT 1 FROM pg_proc WHERE proname='wants_notification') THEN
    RAISE NOTICE '040: notifications live on the server';
  ELSE
    RAISE WARNING '040: incomplete';
  END IF;
END $$;
