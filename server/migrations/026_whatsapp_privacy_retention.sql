-- ─── 026: WhatsApp chat privacy + retention ────────────────────────────────
-- Each rep links their OWN phone (025), so their conversations are personal
-- correspondence, not shared workspace data. Default the tenant to PRIVATE:
-- a rep sees only the conversations carried by their own session, even from
-- colleagues in the same workspace. A builder who needs manager oversight for
-- compliance can opt the workspace into 'team' explicitly — it is a deliberate
-- choice, never the silent default.
--
-- Retention is enforced lazily on read (this stack runs no scheduler), so the
-- column lives beside the channel config rather than in a jobs table.

ALTER TABLE whatsapp_instances
  ADD COLUMN IF NOT EXISTS chat_visibility text NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS retention_days  integer;   -- NULL / 0 = keep forever

ALTER TABLE whatsapp_instances DROP CONSTRAINT IF EXISTS whatsapp_instances_chat_visibility_check;
ALTER TABLE whatsapp_instances ADD CONSTRAINT whatsapp_instances_chat_visibility_check
  CHECK (chat_visibility IN ('private', 'team'));

ALTER TABLE whatsapp_instances DROP CONSTRAINT IF EXISTS whatsapp_instances_retention_days_check;
ALTER TABLE whatsapp_instances ADD CONSTRAINT whatsapp_instances_retention_days_check
  CHECK (retention_days IS NULL OR (retention_days >= 0 AND retention_days <= 3650));

-- Every privacy filter and every export scans lead_activities by owner within
-- the whatsapp slice; without this the inbox degrades to a seq scan per poll.
CREATE INDEX IF NOT EXISTS lead_activities_whatsapp_owner_idx
  ON lead_activities (tenant_id, user_id, created_at DESC)
  WHERE type = 'whatsapp';
