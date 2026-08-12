/**
 * Cross-module regression for the reply-before-commit fix.
 *
 * Every POST handler used to call `reply.send()` INSIDE the withTenantContext
 * callback, which flushes the HTTP response before the transaction COMMITs — so
 * a client that immediately read its own write could miss the row. The fix was
 * to set the status code and RETURN the payload, letting Fastify serialize after
 * the commit resolves. This asserts read-your-writes on every module: create,
 * then immediately list, with no delay.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = 'http://localhost:4055';
const PW = 'Test1234!';
const PLATFORM = 'ed3c4904-829a-4e10-ad91-e17992f400b0';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();
await admin.query('UPDATE users SET password_hash=$1, active=true, mfa_email_enabled=false WHERE email=$2',
  [await argon2.hash(PW, { type: argon2.argon2id }), 'admin@erptest.local']);
const project = (await admin.query('SELECT id FROM projects WHERE tenant_id=$1 LIMIT 1', [PLATFORM])).rows[0].id;

const tok = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@erptest.local', password: PW }),
})).json()).token;
if (!tok) { console.error('login failed'); process.exit(1); }
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };
const DH = { Authorization: H.Authorization };   // bodyless DELETE: no content-type

const post = async (p, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const get = async (p) => (await (await fetch(BASE + p, { headers: H })).json());
const del = async (p) => (await fetch(BASE + p, { method: 'DELETE', headers: DH })).status;

const MARK = 'XM Regression';

/** create -> assert 201 -> immediately list -> assert the new id is present. */
async function readYourWrite(label, path, body, key, listPath, listKey) {
  const { status, body: res } = await post(path, body);
  const row = res?.[key];
  if (status !== 201 || !row?.id) { ok(`${label}: create 201`, false, `${status} ${JSON.stringify(res)?.slice(0, 160)}`); return null; }
  const list = await get(listPath ?? path);
  const arr = list?.[listKey] ?? [];
  ok(`${label}: create 201 + visible immediately`, arr.some(r => r.id === row.id), `listed ${arr.length}`);
  return row;
}

console.log('\n=== READ-YOUR-WRITE ACROSS MODULES ===');
const created = {};

created.vendor = await readYourWrite('vendors', '/api/vendors', { name: MARK + ' Vendor' }, 'vendor', null, 'vendors');
created.material = await readYourWrite('materials', '/api/materials', { name: MARK + ' Cement', unit: 'bag' }, 'material', null, 'materials');
created.employee = await readYourWrite('employees', '/api/employees', { name: MARK + ' Emp', designation: 'Engineer' }, 'employee', null, 'employees');
created.costCenter = await readYourWrite('cost-centers', '/api/cost-centers', { name: MARK + ' CC', projectId: project }, 'costCenter', null, 'costCenters');
created.compliance = await readYourWrite('compliance-items', '/api/compliance-items', { title: MARK + ' Filing', category: 'gst', dueDate: '2026-12-31' }, 'item', null, 'items');
created.siteTask = await readYourWrite('site-tasks', '/api/site-tasks', { projectId: project, title: MARK + ' Task' }, 'siteTask', null, 'siteTasks');
created.broker = await readYourWrite('brokers', '/api/brokers', { name: MARK + ' Broker', phone: '9990001111' }, 'broker', null, 'brokers');

if (created.vendor) {
  created.po = await readYourWrite('purchase-orders', '/api/purchase-orders',
    { vendorId: created.vendor.id, projectId: project, lines: [{ description: 'Steel', qty: 10, rate: 500, unit: 'ton' }] },
    'purchaseOrder', null, 'purchaseOrders');
  created.bill = await readYourWrite('vendor-bills', '/api/vendor-bills',
    { vendorId: created.vendor.id, projectId: project, amount: 100000, category: 'Civil', billNo: 'XM-1' },
    'bill', null, 'bills');
}

console.log('\n=== DELETE -> 204 (no body, commit before response) ===');
if (created.siteTask)   ok('site-task 204',   await del(`/api/site-tasks/${created.siteTask.id}`) === 204);
if (created.compliance) ok('compliance 204',  await del(`/api/compliance-items/${created.compliance.id}`) === 204);
if (created.material)   ok('material 204',    await del(`/api/materials/${created.material.id}`) === 204);
if (created.employee)   ok('employee 204',    await del(`/api/employees/${created.employee.id}`) === 204);

console.log('\n=== DELETE actually persisted (re-read after 204) ===');
if (created.material) {
  const mats = (await get('/api/materials')).materials ?? [];
  ok('deleted material gone from list', !mats.some(m => m.id === created.material.id));
}

console.log('\n=== GUARD STILL 409 (referenced vendor) ===');
if (created.vendor) ok('vendor with bill/PO -> 409', await del(`/api/vendors/${created.vendor.id}`) === 409);

// ── cleanup ──────────────────────────────────────────────────────────────────
await admin.query("DELETE FROM payments_made WHERE vendor_bill_id IN (SELECT vb.id FROM vendor_bills vb JOIN vendors v ON v.id=vb.vendor_id WHERE v.name LIKE 'XM Regression%')");
await admin.query("DELETE FROM vendor_bills WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE 'XM Regression%')");
await admin.query("DELETE FROM purchase_orders WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE 'XM Regression%')");
await admin.query("DELETE FROM vendors WHERE name LIKE 'XM Regression%'");
await admin.query("DELETE FROM cost_centers WHERE name LIKE 'XM Regression%'");
await admin.query("DELETE FROM brokers WHERE name LIKE 'XM Regression%'");
await admin.query("DELETE FROM site_tasks WHERE title LIKE 'XM Regression%'");
await admin.query("DELETE FROM compliance_items WHERE title LIKE 'XM Regression%'");
await admin.query("DELETE FROM materials WHERE name LIKE 'XM Regression%'");
await admin.query("DELETE FROM employees WHERE name LIKE 'XM Regression%'");
await admin.end();

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
