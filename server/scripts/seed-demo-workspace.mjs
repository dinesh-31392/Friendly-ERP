/**
 * Provision a workspace with enough real data to exercise every dashboard.
 *
 *   node scripts/seed-demo-workspace.mjs
 *
 * For evaluating a local deployment, not for production — it sets known
 * passwords. It writes through the same tables the app does, so what you see is
 * what the API returns, RLS and all.
 */
import 'dotenv/config';
import pg from 'pg';
import argon2 from 'argon2';

const DB = process.env.SEED_DB_URL || 'postgres://postgres:postgres@localhost:5433/friendly_crm';
const PW = process.env.SEED_PASSWORD || 'Friendly@2026';
const c = new pg.Client({ connectionString: DB });
await c.connect();

const hash = await argon2.hash(PW, { type: argon2.argon2id });
const SLUG = 'acme';

console.log('→ workspace');
await c.query(`DELETE FROM tenants WHERE slug = $1`, [SLUG]);   // cascades
const { rows: [t] } = await c.query(
  `INSERT INTO tenants (name, company, slug, plan, status, country, currency, channels, email, phone, trial_ends_at)
   VALUES ('Acme Builders','Acme Builders',$1,'growth','active','India','INR','{}','ops@acme.test','9800000000', now() + interval '14 days')
   RETURNING id`, [SLUG]);

// Roles with their real grants, same map the provisioning endpoint uses.
//
// ALL ELEVEN workspace roles, deliberately. This used to define five, which
// meant a demo workspace could not demonstrate the other six and — worse —
// there was no account to sign in with when checking that each role reaches
// what it should. The sign-in picker offers eleven; a seeder that produces five
// cannot be used to verify any of them.
const ROLE_PERMS = {
  builder_admin: null,   // everything
  sales_manager: ['view_dashboard','view_leads','manage_leads','assign_leads','add_notes','manage_team','view_reports','view_inventory','view_projects','view_sales_performance','view_finance','view_messages','send_messages','view_documents','view_service','manage_service','view_calendar','schedule_visits','use_ai_studio','create_bookings','approve_reminders','view_campaigns','manage_campaigns','view_bookings','manage_bookings','view_brokers','view_execution','create_quotations','approve_discounts','view_invoices','view_leasing','manage_leasing'],
  sales_executive: ['view_dashboard','view_leads','manage_own_leads','add_notes','view_inventory','view_projects','view_messages','send_messages','view_documents','view_calendar','schedule_visits','use_ai_studio','create_bookings','view_bookings','create_quotations'],
  telecaller: ['view_dashboard','view_leads','manage_own_leads','add_notes','view_projects','view_calendar','schedule_visits','view_messages','send_messages'],
  accountant: ['view_dashboard','view_projects','view_reports','view_accounts','manage_accounts','view_finance','manage_finance','view_procurement','view_bookings','view_documents','view_invoices','manage_invoices','view_leasing','view_owner_payouts','manage_owner_payouts'],
  site_engineer: ['view_dashboard','view_projects','view_execution','manage_execution','view_procurement','manage_procurement','view_hr','manage_attendance','view_documents','view_calendar','view_messages','send_messages','signoff_ra_bills'],
  hr_manager: ['view_dashboard','view_hr','manage_hr','manage_attendance','view_documents','view_projects','view_reports','view_calendar','view_messages','send_messages'],
  land_manager: ['view_dashboard','view_projects','view_documents','view_land','manage_land','view_bd','view_calendar','view_messages','send_messages'],
  bd_manager: ['view_dashboard','view_projects','view_reports','view_bd','manage_bd','view_land','approve_land_qualify','view_documents','view_calendar','view_messages','send_messages'],
  auditor: ['view_dashboard','view_leads','view_projects','view_inventory','view_bookings','view_sales_performance','view_campaigns','view_calendar','view_reports','view_messages','view_documents','view_finance','view_service','view_brokers','view_execution','view_procurement','view_hr','view_accounts','view_audit_log','view_invoices','view_leasing','view_owner_payouts'],
};
const { rows: allPerms } = await c.query(`SELECT key FROM permissions`);
const catalog = allPerms.map(r => r.key);

const roleId = {};
for (const [name, keys] of Object.entries(ROLE_PERMS)) {
  const { rows: [r] } = await c.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,$2,true) RETURNING id`, [t.id, name]);
  roleId[name] = r.id;
  const grant = keys ?? catalog.filter(k => !['approve_reminders','manage_team'].includes(k));
  for (const k of grant) {
    if (!catalog.includes(k)) continue;
    await c.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [r.id, k]);
  }
}

// Without this every lead insert fails the stage constraint.
await c.query(
  `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition)
   VALUES ($1,'lead','pipeline',1,true,$2)
   ON CONFLICT (tenant_id, entity, kind, version) DO UPDATE SET definition=EXCLUDED.definition, is_active=true`,
  [t.id, JSON.stringify({ stages: [
    { key:'new', id:'new', label:'New', color:'bg-blue-500', core:true },
    { key:'contacted', id:'contacted', label:'Contacted', color:'bg-indigo-500', core:true },
    { key:'qualified', id:'qualified', label:'Qualified', color:'bg-violet-500', core:true },
    { key:'site_visit', id:'site_visit', label:'Site Visit', color:'bg-amber-500', core:true },
    { key:'negotiation', id:'negotiation', label:'Negotiation', color:'bg-orange-500', core:true },
    { key:'booked', id:'booked', label:'Booked', color:'bg-emerald-500', core:true },
    { key:'lost', id:'lost', label:'Lost', color:'bg-red-400', core:true },
  ]})]);

console.log('→ people');
// One account per role. Signing in as each of them is the only way to check
// that a role reaches what it should and nothing more, so every role gets one.
const users = [
  ['admin',    'builder_admin',   'Anita Desai'],
  ['manager',  'sales_manager',   'Rohit Menon'],
  ['sales',    'sales_executive', 'Priya Sharma'],
  ['tele',     'telecaller',      'Sneha Kamat'],
  ['accounts', 'accountant',      'Vikram Rao'],
  ['site',     'site_engineer',   'Imran Qureshi'],
  ['hr',       'hr_manager',      'Deepa Nair'],
  ['land',     'land_manager',    'Suresh Patil'],
  ['bd',       'bd_manager',      'Kavita Reddy'],
  ['auditor',  'auditor',         'Nitin Shah'],
];
const userId = {};
for (const [slug, role, name] of users) {
  const { rows: [u] } = await c.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active, mfa_email_enabled)
     VALUES ($1,$2,$3,$4,$5,true,false) RETURNING id`,
    [t.id, roleId[role], name, `${slug}@acme.test`, hash]);
  userId[slug] = u.id;
}

console.log('→ project, towers, units');
const { rows: [proj] } = await c.query(
  `INSERT INTO projects (tenant_id, name, city, status) VALUES ($1,'Acme Skyline','Pune','under_construction') RETURNING id`, [t.id]);
const { rows: [tower] } = await c.query(
  `INSERT INTO towers (tenant_id, project_id, name, floors, units_per_floor) VALUES ($1,$2,'Tower A',12,4) RETURNING id`, [t.id, proj.id]);

const unitIds = [];
for (let f = 1; f <= 12; f++) {
  for (let n = 1; n <= 4; n++) {
    const cfg = n % 2 ? '2BHK' : '3BHK';
    const area = cfg === '2BHK' ? 950 : 1340;
    const { rows: [u] } = await c.query(
      `INSERT INTO units (tenant_id, project_id, tower_id, unit_code, unit_type, configuration, floor, area_sqft, base_rate, floor_rise_rate, status)
       VALUES ($1,$2,$3,$4,'apartment',$5,$6,$7,6200,25,'available') RETURNING id`,
      [t.id, proj.id, tower.id, `A-${f}0${n}`, cfg, f, area]);
    unitIds.push(u.id);
  }
}

console.log('→ brokers, leads');
const { rows: [broker] } = await c.query(
  `INSERT INTO brokers (tenant_id, name, agency_name, phone, email, commission_structure, status)
   VALUES ($1,'Meera Iyer','Iyer Realty','9811111111','meera@iyer.test','{"type":"percentage","value":2}','active') RETURNING id`, [t.id]);

const LEADS = [
  ['Sanjay Gupta','9820000001','new',        'Website',   null,       6000000],
  ['Neha Kulkarni','9820000002','contacted',  'WhatsApp',  null,       7500000],
  ['Arun Pillai','9820000003','qualified',   'Referral',  broker.id,  8200000],
  ['Divya Nair','9820000004','site_visit',   'Walk-in',   null,       6800000],
  ['Karan Shah','9820000005','negotiation',  'Website',   broker.id,  9100000],
  ['Farah Khan','9820000006','new',          'Portal',    null,       5500000],
  ['Vivek Joshi','9820000007','lost',        'Website',   null,       4800000, 'Bought elsewhere'],
];
const leadIds = [];
for (const [name, phone, stage, source, brokerId, budget, lostReason] of LEADS) {
  const { rows: [l] } = await c.query(
    `INSERT INTO leads (tenant_id, name, phone, stage, source, project, budget, assigned_to, broker_id, lost_reason)
     VALUES ($1,$2,$3,$4,$5,'Acme Skyline',$6,$7,$8,$9) RETURNING id`,
    [t.id, name, phone, stage, source, budget, userId.sales, brokerId, lostReason ?? null]);
  leadIds.push(l.id);
  await c.query(
    `INSERT INTO lead_activities (tenant_id, lead_id, user_id, type, notes)
     VALUES ($1,$2,$3,'call',$4)`,
    [t.id, l.id, userId.sales, `Intro call with ${name.split(' ')[0]}`]);
}

console.log('→ bookings (with the full server cascade)');
// Mirrors what POST /api/bookings does, so the dashboards see consistent data.
for (const [i, leadIdx] of [[0, 2], [1, 4]]) {
  const unit = unitIds[i * 7];
  const lead = leadIds[leadIdx];
  const value = 8200000 + i * 900000;
  const { rows: [bk] } = await c.query(
    `INSERT INTO bookings (tenant_id, lead_id, unit_id, created_by, booking_amount, total_consideration, payment_plan, stage, status)
     VALUES ($1,$2,$3,$4,300000,$5,'30-70','agreement','active') RETURNING id`,
    [t.id, lead, unit, userId.sales, value]);
  await c.query(`UPDATE units SET status='booked' WHERE id=$1`, [unit]);
  await c.query(`UPDATE leads SET stage='booked' WHERE id=$1`, [lead]);
  await c.query(
    `INSERT INTO lead_activities (tenant_id, lead_id, user_id, type, notes)
     VALUES ($1,$2,$3,'stage_change','Booked a unit in Tower A')`, [t.id, lead, userId.sales]);
  await c.query(
    `INSERT INTO commission_ledger (tenant_id, broker_id, booking_id, amount_earned)
     VALUES ($1,$2,$3,$4)`, [t.id, broker.id, bk.id, Math.round(value * 0.02)]);
  await c.query(
    `INSERT INTO invoices (tenant_id, lead_id, booking_id, lead_name, project, type, amount, due_date, status)
     VALUES ($1,$2,$3,$4,'Acme Skyline','Booking Token',300000, CURRENT_DATE + 7, $5)`,
    [t.id, lead, bk.id, LEADS[leadIdx][0], i === 0 ? 'Paid' : 'Pending']);
}

console.log('→ calendar, HR, materials');
for (const [title, cat, days] of [['Call Neha about floor plan','follow_up',1],['Site visit — Divya','visit',2],['Collect token from Karan','payment',3]]) {
  await c.query(
    `INSERT INTO crm_tasks (tenant_id, user_id, title, due_date, priority, status, category, created_by)
     VALUES ($1,$2,$3, now() + ($4 || ' days')::interval, 'hot','pending',$5,$2)`,
    [t.id, userId.sales, title, String(days), cat]);
}
const employeeIds = [];
for (const [name, desig, dept, sal] of [['Imran Qureshi','Site Engineer','Execution',65000],['Sunita Bhosale','Accountant','Finance',55000],['Ramesh Yadav','Supervisor','Execution',38000]]) {
  const { rows: [e] } = await c.query(
    `INSERT INTO employees (tenant_id, name, phone, designation, department, type, project_id, monthly_salary, join_date, active)
     VALUES ($1,$2,'9830000000',$3,$4,'staff',$5,$6, CURRENT_DATE - 200, true) RETURNING id`,
    [t.id, name, desig, dept, proj.id, sal]);
  employeeIds.push(e.id);
}

// Attendance, a leave request and last month's payroll — the three things an
// HR manager's dashboard reports. Without them their tiles all read zero and
// the workspace cannot demonstrate the module it ships.
for (const id of employeeIds.slice(0, 2)) {
  await c.query(
    `INSERT INTO attendance (tenant_id, employee_id, date, check_in, project_id, method)
     VALUES ($1,$2,CURRENT_DATE,'09:15',$3,'manual')`, [t.id, id, proj.id]);
}
await c.query(
  `INSERT INTO leave_requests (tenant_id, employee_id, type, from_date, to_date, days, reason, status)
   VALUES ($1,$2,'casual', CURRENT_DATE + 3, CURRENT_DATE + 4, 2, 'Family function', 'pending')`,
  [t.id, employeeIds[2]]);
await c.query(
  `INSERT INTO payroll_runs (tenant_id, month, status, items, processed_at)
   VALUES ($1, to_char(CURRENT_DATE - interval '1 month', 'YYYY-MM'), 'processed', '[]'::jsonb, now())`,
  [t.id]);
console.log('→ land parcels, BD opportunities');
// The acquisition pipeline. A land manager and a BD manager have no leads, no
// inventory and no ledger — these two tables are their entire working set, so
// a demo workspace without them cannot show either role anything at all.
//
// Spread across the statuses their dashboards count, and across the two
// approval queues the dashboard raises as alerts:
//
//   scored but not yet qualified  → the BD manager's "awaiting qualification"
//   qualified                     → the admin's "ready to convert"
//   converted                     → finished; must NOT count as active pipeline
//
// The score matters: landToQualify only picks up parcels that have been scored
// (latestScore > 0), are unencumbered and carry no litigation. A parcel at
// score 0 is still being worked up and is nobody's decision yet.
const LAND = [
  ['broker',     'Shantaram Pawar', '9840000001', 'Wagholi',  'Pune', 4.2,  38000000, 'feasibility_working', 71],
  ['direct',     'Kamala Deshmukh', '9840000002', 'Hinjewadi','Pune', 2.75, 61000000, 'property_details',     0],
  ['auction',    'MIDC Plot 44',    '9840000003', 'Chakan',   'Pune', 8.0,  92000000, 'qualified',           78],
  ['government', 'Pune Metro Land', '9840000004', 'Kharadi',  'Pune', 1.5,  45000000, 'converted_to_project', 82],
];
for (const [src, owner, contact, loc, city, acres, price, status, score] of LAND) {
  await c.query(
    `INSERT INTO land_leads (tenant_id, reference_source, owner_name, owner_contact, location, city,
                             area_acres, asking_price, status, ownership_type, litigation_status,
                             is_encumbered, latest_score, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'freehold','none',false,$10,$11)`,
    [t.id, src, owner, contact, loc, city, acres, price, status, score, userId.admin]);
}

const BD = [
  ['jv',       'Referral', 'Sunrise Developers', '9850000001', 'Pune', 'terms_negotiation',  120000000],
  ['jv',       'Direct',   'Meridian Estates',   '9850000002', 'Pune', 'initial_discussion',  85000000],
  ['outright', 'Broker',   'Green Acres LLP',    '9850000003', 'Pune', 'identified',          40000000],
];
for (const [type, src, name, contact, city, stage, value] of BD) {
  await c.query(
    `INSERT INTO bd_leads (tenant_id, opportunity_type, source, counterparty_name, counterparty_contact,
                           city, stage, estimated_deal_value, owned_by, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
    [t.id, type, src, name, contact, city, stage, value, userId.bd]);
}

for (const [name, cat, unit] of [['OPC 53 Cement','Cement','bag'],['TMT Bar 12mm','Steel','kg'],['River Sand','Aggregate','cft']]) {
  await c.query(`INSERT INTO materials (tenant_id, name, category, unit, reorder_level) VALUES ($1,$2,$3,$4,100)`, [t.id, name, cat, unit]);
}

console.log('→ portal logins (customer + channel partner)');
const { rows: [pu] } = await c.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name='portal_users' AND column_name='lead_id'`);
if (pu) {
  // The CHECK constraint is exclusive: a customer carries a lead_id and no
  // broker_id, a partner the reverse. There is no such thing as a portal user
  // attached to both, and the seeder must not pretend otherwise.
  await c.query(
    `INSERT INTO portal_users (tenant_id, lead_id, email, password_hash, name, role, active)
     VALUES ($1,$2,'buyer@acme.test',$3,'Arun Pillai','customer',true)
     ON CONFLICT DO NOTHING`,
    [t.id, leadIds[2], hash]);
  // The partner side had no account at all, so the Channel Partner half of the
  // portal could never be opened on a demo workspace.
  await c.query(
    `INSERT INTO portal_users (tenant_id, broker_id, email, password_hash, name, role, active)
     VALUES ($1,$2,'partner@acme.test',$3,'Meera Iyer','partner',true)
     ON CONFLICT DO NOTHING`,
    [t.id, broker.id, hash]);
}

console.log(`
──────────────────────────────────────────────────────────────
  Workspace "Acme Builders"   workspace code: ${SLUG}
  Password for every account below: ${PW}

  BUILDER LOGIN  (pick the role in the sign-in picker, workspace code "${SLUG}")
    admin@acme.test      Builder Admin    — sees everything
    manager@acme.test    Sales Manager    — team + pipeline + approvals
    sales@acme.test      Sales Executive  — only their own leads
    tele@acme.test       Telecaller       — calls their list, books visits
    accounts@acme.test   Accountant       — finance, no CRM
    site@acme.test       Site Engineer    — execution + stores
    hr@acme.test         HR Manager       — people, attendance, payroll
    land@acme.test       Land Manager     — acquisition and title
    bd@acme.test         BD Manager       — business development
    auditor@acme.test    Auditor          — reads everything, writes nothing

  PORTAL LOGIN   (the "Customer" / "Channel Partner" entries)
    buyer@acme.test      the booking, schedule and tickets for one buyer
    partner@acme.test    referrals and commission statements for one agency

  Data: 48 units (2 booked), 7 leads across the pipeline, 2 bookings
  with commissions and invoices, 3 tasks, 3 materials.
  People: 3 employees, 2 present today, 1 leave request pending, last
  month's payroll processed.
  Acquisition: 4 land parcels (1 converted), 3 BD opportunities.
──────────────────────────────────────────────────────────────`);
await c.end();
