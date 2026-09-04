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
  // Mirrors BUILDER_ADMIN_EXCLUDES in seed.ts / tenantRoutes.ts. The platform
  // keys are the important two: a workspace owner must not hold the rights
  // that gate the platform console.
  const grant = keys ?? catalog.filter(k =>
    !['view_platform', 'manage_branch', 'approve_reminders', 'manage_team'].includes(k));
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

// Every lead carries an email. Without one the Leads table's Email column, the
// detail panel's mail action and the "give this buyer portal access" flow all
// have nothing to show or send to — and a blank column reads as a broken
// feature rather than as missing data.
//
// One lead is deliberately left without an address: a real pipeline has walk-ins
// who only ever gave a phone number, and the UI has to look right for them too.
const LEADS = [
  ['Sanjay Gupta',  '9820000001', 'new',         'Website',  null,      6000000, 'sanjay.gupta@example.com'],
  ['Neha Kulkarni', '9820000002', 'contacted',   'WhatsApp', null,      7500000, 'neha.kulkarni@example.com'],
  ['Arun Pillai',   '9820000003', 'qualified',   'Referral', broker.id, 8200000, 'arun.pillai@example.com'],
  ['Divya Nair',    '9820000004', 'site_visit',  'Walk-in',  null,      6800000, ''],
  ['Karan Shah',    '9820000005', 'negotiation', 'Website',  broker.id, 9100000, 'karan.shah@example.com'],
  ['Farah Khan',    '9820000006', 'new',         'Portal',   null,      5500000, 'farah.khan@example.com'],
  ['Vivek Joshi',   '9820000007', 'lost',        'Website',  null,      4800000, 'vivek.joshi@example.com', 'Bought elsewhere'],
];
/**
 * How long ago each enquiry arrived.
 *
 * Inserted all at once, every lead showed the same minute — which left the
 * Received column and the date-range filter (Today / This week / This month)
 * with nothing to tell apart. A demo cannot show a feature when every row
 * answers it identically.
 *
 * Spread so the pipeline reads as one: a lead that has reached negotiation has
 * had weeks to get there, while today's arrivals are still 'new'. Keyed by name
 * rather than appended to LEADS, whose last field is already optional.
 */
const ENQUIRED_DAYS_AGO = {
  'Vivek Joshi':   21,   // lost — the oldest, and it went nowhere
  'Arun Pillai':   17,   // qualified, later booked
  'Karan Shah':    14,   // negotiation, later booked
  'Divya Nair':     9,   // site visit done
  'Neha Kulkarni':  5,   // contacted
  'Sanjay Gupta':   2,   // still new — worth chasing
  'Farah Khan':     0,   // came in today
};

const leadIds = [];
for (const [name, phone, stage, source, brokerId, budget, email, lostReason] of LEADS) {
  const daysAgo = String(ENQUIRED_DAYS_AGO[name] ?? 0);
  const { rows: [l] } = await c.query(
    `INSERT INTO leads (tenant_id, name, phone, email, stage, source, project, budget, assigned_to, broker_id, lost_reason,
                        created_at, enquired_at, last_contact_at)
     VALUES ($1,$2,$3,$4,$5,$6,'Acme Skyline',$7,$8,$9,$10,
             now() - ($11 || ' days')::interval,
             now() - ($11 || ' days')::interval,
             now() - ($11 || ' days')::interval) RETURNING id`,
    [t.id, name, phone, email, stage, source, budget, userId.sales, brokerId, lostReason ?? null, daysAgo]);
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
    // delay_interest_pct defaults to 0, which makes every demand letter read
    // "incl. ₹0 interest" — arithmetically right and useless as a demo of a
    // dunning module. 12% p.a. is a normal delayed-payment rate on an Indian
    // builder agreement.
    `INSERT INTO bookings (tenant_id, lead_id, unit_id, created_by, booking_amount, total_consideration, payment_plan, stage, status, delay_interest_pct)
     VALUES ($1,$2,$3,$4,300000,$5,'30-70','agreement','active',12) RETURNING id`,
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

  // The payment plan behind the booking: 30-70, three milestones.
  //
  // The FIRST is deliberately overdue and only part-paid, because that is what
  // the Demands tab is FOR — milestone_outstanding() reads payments rather
  // than the status column, so a partly-paid overdue milestone is exactly the
  // case a collections desk chases and the one worth having in a demo.
  const MILESTONES = [
    ['On Booking',   1, 30, Math.round(value * 0.30), -21],
    ['On Agreement', 2, 40, Math.round(value * 0.40),  14],
    ['On Handover',  3, 30, value - Math.round(value * 0.30) - Math.round(value * 0.40), 120],
  ];
  for (const [name, seq, pct, amount, dueInDays] of MILESTONES) {
    const { rows: [ms] } = await c.query(
      `INSERT INTO payment_schedules (tenant_id, booking_id, milestone_name, sequence, percentage, amount, due_date, status)
       VALUES ($1,$2,$3,$4,$5,$6, CURRENT_DATE + $7::int, 'pending') RETURNING id`,
      [t.id, bk.id, name, seq, pct, amount, dueInDays]);
    // Part payment against the overdue first milestone on the first booking
    // only — so one booking is chaseable and one is clean.
    if (dueInDays < 0 && i === 0) {
      await c.query(
        `INSERT INTO payments (tenant_id, payment_schedule_id, amount, payment_date, mode)
         VALUES ($1,$2,$3, CURRENT_DATE - 18, 'bank_transfer')`,
        [t.id, ms.id, Math.round(amount * 0.4)]);
    }
  }
}

console.log('→ RERA registration and escrow');
// The designated account and the seventy per cent obligation it carries.
// Without a registration the RERA tab can only show its empty state, and the
// obligation this module exists to measure is invisible.
const { rows: [designated] } = await c.query(
  `INSERT INTO bank_accounts (tenant_id, account_name, bank_name, account_number, opening_balance)
   VALUES ($1,'Acme Skyline — RERA Designated','HDFC Bank','50200012345678', 2500000) RETURNING id`, [t.id]);
await c.query(`UPDATE projects SET rera_number = 'P52100047890' WHERE id = $1`, [proj.id]);
await c.query(
  `INSERT INTO rera_registrations (tenant_id, project_id, registered_on, valid_until, escrow_pct, designated_bank_account_id)
   VALUES ($1,$2, CURRENT_DATE - 400, CURRENT_DATE + 700, 70, $3)
   ON CONFLICT (project_id) DO NOTHING`, [t.id, proj.id, designated.id]);
// Allocate what has been received. Idempotent by construction — one allocation
// per payment, enforced by a unique index.
await c.query(`
  INSERT INTO escrow_allocations
    (tenant_id, payment_id, project_id, receipt_amount, escrow_amount, free_amount, escrow_pct)
  SELECT $1, pay.id, u.project_id, pay.amount, s.escrow, s.free, r.escrow_pct
    FROM payments pay
    JOIN payment_schedules ps ON ps.id = pay.payment_schedule_id
    JOIN bookings bk          ON bk.id = ps.booking_id
    JOIN units u              ON u.id = bk.unit_id
    JOIN rera_registrations r ON r.project_id = u.project_id AND r.status = 'active'
    CROSS JOIN LATERAL escrow_split(pay.amount, r.escrow_pct) s
  ON CONFLICT (payment_id) DO NOTHING`, [t.id]);

console.log('→ calendar, HR, materials');
for (const [title, cat, days] of [['Call Neha about floor plan','follow_up',1],['Site visit — Divya','visit',2],['Collect token from Karan','payment',3]]) {
  await c.query(
    `INSERT INTO crm_tasks (tenant_id, user_id, title, due_date, priority, status, category, created_by)
     VALUES ($1,$2,$3, now() + ($4 || ' days')::interval, 'hot','pending',$5,$2)`,
    [t.id, userId.sales, title, String(days), cat]);
}
// The fourth column is the LOGIN this employee is, where there is one.
// Without it the demo seeded an employee called Imran Qureshi and a user
// called Imran Qureshi and left them strangers to each other — so /api/hr/me
// found nothing, and "My Attendance & Pay" could only ever show the
// no-record-linked state for a person who plainly has a record.
const employeeIds = [];
for (const [name, desig, dept, sal, login] of [
  ['Imran Qureshi',  'Site Engineer', 'Execution', 65000, 'site'],
  ['Sunita Bhosale', 'Accountant',    'Finance',   55000, 'accounts'],
  // No login on purpose: a supervisor who is paid but does not use the ERP is
  // the normal case on a site, and the page has to handle being asked about
  // somebody who never signs in.
  ['Ramesh Yadav',   'Supervisor',    'Execution', 38000, null],
]) {
  const { rows: [e] } = await c.query(
    `INSERT INTO employees (tenant_id, name, phone, designation, department, type, project_id, monthly_salary, join_date, active, user_id)
     VALUES ($1,$2,'9830000000',$3,$4,'staff',$5,$6, CURRENT_DATE - 200, true, $7) RETURNING id`,
    [t.id, name, desig, dept, proj.id, sal, login ? userId[login] : null]);
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
// A processed run with its LINES, not an empty array. `items` is what the
// payroll screen renders and what a payslip is drawn from, so seeding `[]`
// left an HR manager looking at an empty table totalling zero and an employee
// with no payslip — the module shipped, and the demo could not show it.
//
// It is also the only way to see the redaction work: a site engineer opening
// this run is told how many people are in it and not what they were paid.
await c.query(
  `INSERT INTO payroll_runs (tenant_id, month, status, items, processed_at)
   VALUES ($1, to_char(CURRENT_DATE - interval '1 month', 'YYYY-MM'), 'processed', $2::jsonb, now())`,
  [t.id, JSON.stringify([
    { employeeId: employeeIds[0], name: 'Imran Qureshi',  designation: 'Site Engineer', empType: 'staff', basis: 'Monthly salary', gross: 65000 },
    { employeeId: employeeIds[1], name: 'Sunita Bhosale', designation: 'Accountant',    empType: 'staff', basis: 'Monthly salary', gross: 55000 },
    { employeeId: employeeIds[2], name: 'Ramesh Yadav',   designation: 'Supervisor',    empType: 'staff', basis: 'Monthly salary', gross: 38000 },
  ])]);
console.log('→ site visits');
// The middle of the funnel, across every state the page distinguishes: two
// still to happen, one held and converted, one held and not, one nobody turned
// up to. Without a completed visit the conversion figure has no denominator
// and the page can only ever show 0%.
//
// leadIds order matches LEADS: 0 Sanjay, 1 Neha, 2 Arun, 3 Divya, 4 Karan,
// 5 Farah, 6 Vivek.
const VISITS = [
  // [lead, daysFromNow, status, outcome, feedback]
  [leadIds[1], 2,   'scheduled', null,             ''],
  [leadIds[5], 4,   'confirmed', null,             ''],
  [leadIds[2], -15, 'completed', 'booked',         'Loved the east-facing 2BHK — closed the same week.'],
  [leadIds[3], -7,  'completed', 'needs_followup', 'Wants to bring family before deciding.'],
  [leadIds[0], -3,  'no_show',   null,             ''],
];
for (const [leadId, days, status, outcome, feedback] of VISITS) {
  await c.query(
    `INSERT INTO site_visits (tenant_id, lead_id, project_id, assigned_to, scheduled_at,
                              duration_minutes, status, outcome, feedback, created_by,
                              completed_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval, 60, $6, $7, $8, $4,
             CASE WHEN $6 IN ('completed','no_show') THEN now() + ($5 || ' days')::interval END)`,
    [t.id, leadId, proj.id, userId.sales, String(days), status, outcome, feedback]);
}

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
