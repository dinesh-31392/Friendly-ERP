-- ─── 016: Procurement & materials ──────────────────────────────────────────
-- Purchase orders (with line items + goods receipt), the material master,
-- stock movements (inward/outward), and machinery. Previously localStorage-
-- only; vendor_bills.purchase_order_id (004) can now point at a real PO.
-- Every table: FORCE RLS + tenant_rows policy + explicit grants.

CREATE TABLE IF NOT EXISTS materials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           text NOT NULL,
  category       text NOT NULL DEFAULT '',
  unit           text NOT NULL DEFAULT 'nos',
  reorder_level  numeric(14,3) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number        integer NOT NULL,             -- sequential per tenant → "PO-0007"
  vendor_id     uuid NOT NULL,
  project_id    uuid,
  status        text NOT NULL DEFAULT 'pending_approval'
                CHECK (status IN ('pending_approval', 'approved', 'partially_received', 'received', 'cancelled')),
  lines         jsonb NOT NULL DEFAULT '[]',  -- [{materialId,description,unit,qty,rate,receivedQty}]
  expected_date date,
  notes         text,
  created_by    uuid REFERENCES users(id),
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (vendor_id, tenant_id)  REFERENCES vendors (id, tenant_id)  DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE SET NULL (project_id)
);

CREATE TABLE IF NOT EXISTS stock_txns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  material_id uuid NOT NULL,
  project_id  uuid,                            -- site; NULL = central store
  type        text NOT NULL CHECK (type IN ('inward', 'outward')),
  qty         numeric(14,3) NOT NULL CHECK (qty > 0),
  rate        numeric(14,2),                   -- inward cost per unit
  vendor_id   uuid,
  po_id       uuid,
  reference   text,                            -- challan / bill no.
  notes       text,
  created_by  uuid REFERENCES users(id),
  txn_date    date NOT NULL DEFAULT CURRENT_DATE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (material_id, tenant_id) REFERENCES materials (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (po_id, tenant_id)       REFERENCES purchase_orders (id, tenant_id) ON DELETE SET NULL (po_id)
);

CREATE TABLE IF NOT EXISTS machines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              text NOT NULL,
  category          text NOT NULL DEFAULT '',
  registration_no   text,
  ownership         text NOT NULL DEFAULT 'owned' CHECK (ownership IN ('owned', 'rented')),
  project_id        uuid,
  status            text NOT NULL DEFAULT 'idle' CHECK (status IN ('on_site', 'idle', 'maintenance')),
  next_service_date date,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE SET NULL (project_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['materials', 'purchase_orders', 'stock_txns', 'machines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_rows ON %I', t);
    EXECUTE format('CREATE POLICY tenant_rows ON %I USING (tenant_id = app_current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
    EXECUTE format('GRANT ALL ON %I TO app_platform', t);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_stock_tenant_material ON stock_txns (tenant_id, material_id);
CREATE INDEX IF NOT EXISTS idx_po_tenant_status ON purchase_orders (tenant_id, status);
