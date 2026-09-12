-- ─── 063: a workspace that could not be deleted ────────────────────────────
--
-- Thirty-six foreign keys referenced `users` with no ON DELETE action.
-- Migration 062 fixed the two HR ones as a worked example and said the rest
-- deserved their own change. This is that change: the remaining thirty-three.
--
-- WHY IT MATTERS, AND IT IS NOT THEORETICAL
--
-- `users.tenant_id` cascades from `tenants`. So deleting a workspace tries to
-- delete its users, and every one of these rows refuses to let go. One
-- approved leave request, one posted journal entry, one created booking — and
-- the workspace is permanently undeletable.
--
-- That is a data-protection problem, not only an operational one: a customer
-- who asks for their workspace to be removed cannot be given it. It also
-- broke the demo seeder, whose first statement drops and recreates its own
-- tenant, which is how the whole class was found.
--
-- SET NULL, NOT CASCADE
--
-- Every column here is attribution: created_by, approved_by, posted_by,
-- received_by, filed_by, uploaded_by, requested_by, assigned_to. The entry was
-- posted, the bill was approved, the payment was received. Those facts survive
-- the person leaving the company; what is lost is the name attached to them,
-- which is the correct thing to lose when an account is DELETED rather than
-- deactivated.
--
-- CASCADE would be catastrophic here — deleting a user would delete the
-- invoices they raised and the payments they receipted.
--
-- Every column was checked for nullability first: a NOT NULL column cannot be
-- SET NULL, and the one that is appears at the end of this file with its own
-- reasoning rather than being quietly loosened.
--
-- ON DELETE SET NULL (col) — the parenthesised form — is required because
-- these are composite (col, tenant_id) keys and only the user column may be
-- nulled. Nulling tenant_id would detach the row from its workspace, which is
-- the isolation guarantee the whole schema rests on. `branches.manager_id` is
-- the one single-column key and takes the plain form.

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_created_by_fkey;
ALTER TABLE bookings ADD CONSTRAINT bookings_created_by_fkey
  FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (created_by);

ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_manager_id_fkey;
ALTER TABLE branches ADD CONSTRAINT branches_manager_id_fkey
  FOREIGN KEY (manager_id) REFERENCES users (id)
  ON DELETE SET NULL;

ALTER TABLE budget_revisions DROP CONSTRAINT IF EXISTS budget_revisions_approved_by_fkey;
ALTER TABLE budget_revisions ADD CONSTRAINT budget_revisions_approved_by_fkey
  FOREIGN KEY (approved_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (approved_by);

ALTER TABLE compliance_items DROP CONSTRAINT IF EXISTS compliance_items_filed_by_fkey;
ALTER TABLE compliance_items ADD CONSTRAINT compliance_items_filed_by_fkey
  FOREIGN KEY (filed_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (filed_by);

ALTER TABLE contractor_ra_bills DROP CONSTRAINT IF EXISTS contractor_ra_bills_created_by_fkey;
ALTER TABLE contractor_ra_bills ADD CONSTRAINT contractor_ra_bills_created_by_fkey
  FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (created_by);

ALTER TABLE contractor_ra_bills DROP CONSTRAINT IF EXISTS contractor_ra_bills_finance_approved_by_fkey;
ALTER TABLE contractor_ra_bills ADD CONSTRAINT contractor_ra_bills_finance_approved_by_fkey
  FOREIGN KEY (finance_approved_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (finance_approved_by);

ALTER TABLE contractor_ra_bills DROP CONSTRAINT IF EXISTS contractor_ra_bills_pmc_approved_by_fkey;
ALTER TABLE contractor_ra_bills ADD CONSTRAINT contractor_ra_bills_pmc_approved_by_fkey
  FOREIGN KEY (pmc_approved_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (pmc_approved_by);

ALTER TABLE crm_tasks DROP CONSTRAINT IF EXISTS crm_tasks_created_by_fkey;
ALTER TABLE crm_tasks ADD CONSTRAINT crm_tasks_created_by_fkey
  FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (created_by);

ALTER TABLE export_jobs DROP CONSTRAINT IF EXISTS export_jobs_requested_by_fkey;
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_requested_by_fkey
  FOREIGN KEY (requested_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (requested_by);

ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batches_created_by_fkey;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_created_by_fkey
  FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (created_by);

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_created_by_fkey;
ALTER TABLE invoices ADD CONSTRAINT invoices_created_by_fkey
  FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (created_by);

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_created_by_fkey;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_created_by_fkey
  FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (created_by);

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_posted_by_fkey;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_posted_by_fkey
  FOREIGN KEY (posted_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (posted_by);

ALTER TABLE lease_agreements DROP CONSTRAINT IF EXISTS lease_agreements_created_by_fkey;
ALTER TABLE lease_agreements ADD CONSTRAINT lease_agreements_created_by_fkey
  FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (created_by);

ALTER TABLE lease_receipts DROP CONSTRAINT IF EXISTS lease_receipts_received_by_fkey;
ALTER TABLE lease_receipts ADD CONSTRAINT lease_receipts_received_by_fkey
  FOREIGN KEY (received_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (received_by);

ALTER TABLE maintenance_bills DROP CONSTRAINT IF EXISTS maintenance_bills_created_by_fkey;
ALTER TABLE maintenance_bills ADD CONSTRAINT maintenance_bills_created_by_fkey
  FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (created_by);

ALTER TABLE meta_config DROP CONSTRAINT IF EXISTS meta_config_updated_by_fkey;
ALTER TABLE meta_config ADD CONSTRAINT meta_config_updated_by_fkey
  FOREIGN KEY (updated_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (updated_by);

ALTER TABLE owner_payouts DROP CONSTRAINT IF EXISTS owner_payouts_approved_by_fkey;
ALTER TABLE owner_payouts ADD CONSTRAINT owner_payouts_approved_by_fkey
  FOREIGN KEY (approved_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (approved_by);

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_received_by_fkey;
ALTER TABLE payments ADD CONSTRAINT payments_received_by_fkey
  FOREIGN KEY (received_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (received_by);

ALTER TABLE payments_made DROP CONSTRAINT IF EXISTS payments_made_paid_by_fkey;
ALTER TABLE payments_made ADD CONSTRAINT payments_made_paid_by_fkey
  FOREIGN KEY (paid_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (paid_by);

ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_approved_by_fkey;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_approved_by_fkey
  FOREIGN KEY (approved_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (approved_by);

ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_created_by_fkey;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_created_by_fkey
  FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (created_by);

ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_created_by_fkey;
ALTER TABLE quotations ADD CONSTRAINT quotations_created_by_fkey
  FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (created_by);

ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_discount_approved_by_fkey;
ALTER TABLE quotations ADD CONSTRAINT quotations_discount_approved_by_fkey
  FOREIGN KEY (discount_approved_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (discount_approved_by);

ALTER TABLE schema_definitions DROP CONSTRAINT IF EXISTS schema_definitions_created_by_fkey;
ALTER TABLE schema_definitions ADD CONSTRAINT schema_definitions_created_by_fkey
  FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (created_by);

ALTER TABLE snags DROP CONSTRAINT IF EXISTS snags_assigned_to_tenant_id_fkey;
ALTER TABLE snags ADD CONSTRAINT snags_assigned_to_tenant_id_fkey
  FOREIGN KEY (assigned_to, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (assigned_to);

ALTER TABLE stock_txns DROP CONSTRAINT IF EXISTS stock_txns_created_by_fkey;
ALTER TABLE stock_txns ADD CONSTRAINT stock_txns_created_by_fkey
  FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (created_by);

ALTER TABLE stored_files DROP CONSTRAINT IF EXISTS stored_files_uploaded_by_tenant_id_fkey;
ALTER TABLE stored_files ADD CONSTRAINT stored_files_uploaded_by_tenant_id_fkey
  FOREIGN KEY (uploaded_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (uploaded_by);

ALTER TABLE tax_postings DROP CONSTRAINT IF EXISTS tax_postings_filed_by_fkey;
ALTER TABLE tax_postings ADD CONSTRAINT tax_postings_filed_by_fkey
  FOREIGN KEY (filed_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (filed_by);

ALTER TABLE tenant_keys DROP CONSTRAINT IF EXISTS tenant_keys_updated_by_fkey;
ALTER TABLE tenant_keys ADD CONSTRAINT tenant_keys_updated_by_fkey
  FOREIGN KEY (updated_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (updated_by);

ALTER TABLE vendor_bills DROP CONSTRAINT IF EXISTS vendor_bills_approved_by_fkey;
ALTER TABLE vendor_bills ADD CONSTRAINT vendor_bills_approved_by_fkey
  FOREIGN KEY (approved_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (approved_by);

ALTER TABLE vendor_bills DROP CONSTRAINT IF EXISTS vendor_bills_created_by_fkey;
ALTER TABLE vendor_bills ADD CONSTRAINT vendor_bills_created_by_fkey
  FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
  ON DELETE SET NULL (created_by);

-- ─── The one that stays RESTRICT, deliberately ─────────────────────────────
--
-- site_visits.assigned_to is NOT NULL, and it is NOT NULL for a reason the
-- table's own comment gives: "Who is taking them. Separate from created_by — a
-- manager books the visit, a rep conducts it, and the rep is the one who needs
-- telling." A visit nobody is taking is not a visit.
--
-- Three ways to make it deletable, and why this one is left alone:
--
--   CASCADE     would delete the visit history of anyone who leaves. A visit
--               that happened, happened.
--   SET NULL    needs the column made nullable, which pushes "assignee may be
--               absent" into the API, the calendar and every screen that
--               renders a rep's name. That is a product change, not a
--               constraint fix, and it does not belong in a migration whose
--               job is to unblock deletion.
--   RESTRICT    blocks deleting a user who has visits — which is what happens
--               today and is defensible: reassign their visits, or deactivate
--               the account instead of deleting it.
--
-- And crucially it does NOT block deleting a workspace: site_visits.tenant_id
-- cascades from tenants directly, so the rows are gone before this key is
-- ever consulted. The constraint is therefore left exactly as it is, and this
-- comment exists so the next person to run the audit query knows it was
-- considered rather than missed.

-- ─── Proof ─────────────────────────────────────────────────────────────────
--
-- The assertion is the whole point of the migration: not "the constraints were
-- altered" but "nothing referencing users can block a delete any more".

DO $$
DECLARE offenders text;
BEGIN
  SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ')
    INTO offenders
    FROM pg_constraint
   WHERE contype = 'f'
     AND confrelid = 'users'::regclass
     AND pg_get_constraintdef(oid) NOT LIKE '%ON DELETE%'
     -- The documented exception above.
     AND conname <> 'site_visits_assignee_fkey';

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'user references still lack an on-delete action: %', offenders;
  END IF;
END $$;
