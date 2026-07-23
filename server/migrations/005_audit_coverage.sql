-- ============================================================================
-- FRIENDLY ERP — audit-trail coverage for PII & financial tables.
--
-- 003/004 attached audit_row_change() to the high-traffic entities (leads,
-- projects, bookings, journal entries, bills…) but left several
-- PII/financial tables without an immutable trail. A change to a buyer's KYC,
-- a vendor's bank details, or a bank statement line should be as auditable as
-- a change to a lead. audit_row_change() (from 001) is SECURITY DEFINER and
-- writes to the append-only, tenant-read-only audit_logs — app_user cannot
-- forge or erase these rows.
-- ============================================================================

CREATE TRIGGER audit_customers        AFTER INSERT OR UPDATE OR DELETE ON customers        FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_brokers          AFTER INSERT OR UPDATE OR DELETE ON brokers          FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_service_requests AFTER INSERT OR UPDATE OR DELETE ON service_requests FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_vendors          AFTER INSERT OR UPDATE OR DELETE ON vendors          FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_bank_accounts    AFTER INSERT OR UPDATE OR DELETE ON bank_accounts    FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_bank_transactions AFTER INSERT OR UPDATE OR DELETE ON bank_transactions FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_tax_postings     AFTER INSERT OR UPDATE OR DELETE ON tax_postings     FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_approval_workflows AFTER INSERT OR UPDATE OR DELETE ON approval_workflows FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_user_project_assignments AFTER INSERT OR UPDATE OR DELETE ON user_project_assignments FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- No GRANT section: this migration adds no tables, only triggers.
