-- ─── 011: channel-partner attribution on leads ─────────────────────────────
-- A lead sourced by a channel partner carries that broker's id (the SPA's
-- Lead.brokerId). The brokers module derives its leadsReferred / bookingsClosed
-- counters from this link, so without it those counts can't be computed
-- server-side. Tenant-scoped FK to brokers; SET NULL if the broker is removed
-- (the column-list form nulls ONLY broker_id, matching the assigned_to pattern).

ALTER TABLE leads ADD COLUMN IF NOT EXISTS broker_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_broker_fk') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_broker_fk
      FOREIGN KEY (broker_id, tenant_id) REFERENCES brokers (id, tenant_id)
      ON DELETE SET NULL (broker_id);
  END IF;
END $$;

-- Supports the brokers-module count subqueries (leads/bookings per broker).
CREATE INDEX IF NOT EXISTS idx_leads_tenant_broker ON leads (tenant_id, broker_id);
