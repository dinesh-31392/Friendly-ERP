import pg from 'pg';
const c = new pg.Client({ connectionString: 'postgres://postgres:postgres@localhost:5433/erp_test' });
await c.connect();
const A = 'ed3c4904-829a-4e10-ad91-e17992f400b0';
for (const t of ['bookings','quotations','service_tickets','journal_entries','chart_of_accounts','units','towers','leads','projects','documents','campaigns','templates']) { try { await c.query(`DELETE FROM ${t}`); } catch { /* immutable trigger */ } }
await c.query("DELETE FROM users WHERE email IN ('exec1@erptest.local','exec2@erptest.local','acct@erptest.local','aud@erptest.local','badmin@rival.test')");
await c.query("DELETE FROM tenants WHERE name='Rival Builders'");
await c.query("DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE tenant_id=$1 AND name IN ('sales_executive','accountant','auditor'))", [A]);
await c.query("DELETE FROM roles WHERE tenant_id=$1 AND name IN ('sales_executive','accountant','auditor')", [A]);
console.log('test artifacts cleaned');
await c.end();
