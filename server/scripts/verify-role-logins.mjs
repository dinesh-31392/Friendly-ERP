/**
 * Sign in as every role and check that each one reaches its own modules and
 * nothing else.
 *
 * WHAT IS BEING PROTECTED
 *
 * Every other suite tests one feature across roles. This one tests one role
 * across features, which is the axis a customer actually experiences: an
 * accountant does not care whether the escrow arithmetic is exact if their
 * dashboard shows zero leads because a 403 was swallowed.
 *
 * Two failures this catches that nothing else did:
 *
 *   • a role advertised in the sign-in picker that no workspace actually has
 *     (telecaller, land_manager, bd_manager before migration 046). The picker
 *     offers it, Settings → Users cannot create it, and nothing says why.
 *   • a role that signs in and then holds nothing — the tech_team failure,
 *     where eleven code paths referenced a role with zero grants.
 *
 * The DENY half matters as much as the ALLOW half. A role that reaches
 * everything is not a role; it is a builder_admin with a different label.
 *
 * Run against a workspace seeded by scripts/seed-demo-workspace.mjs, with the
 * API started as AUTH_RATE_LIMIT_MAX=200 — production allows five sign-ins a
 * minute per IP and this suite performs a dozen from one.
 *
 * Unlike its siblings this one never touches the database: it goes through the
 * HTTP API exactly as a browser does, because a permission honoured by
 * has_permission() but ignored by the route is precisely the failure worth
 * catching (financeRoutes served the ledger on view_finance for months while
 * the UI gated it on view_accounts).
 */
import 'dotenv/config';

// CI runs the API on 4055, same as every other suite here. Against a local dev
// server: API_BASE=http://localhost:4000 node scripts/verify-role-logins.mjs
const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW   = process.env.SEED_PASSWORD ?? 'Friendly@2026';
const SLUG = process.env.SEED_SLUG ?? 'acme';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  c ? (pass++, console.log('  ✓ ' + n))
    : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : '')));
};

const H = (t) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const get = (p, t) => fetch(BASE + p, { headers: H(t) });

/**
 * Role → what it must reach, and what it must not.
 *
 * Paths are the real endpoints the pages call, not stand-ins: a permission key
 * that exists but is not honoured by the route is exactly the bug worth
 * finding, and asserting on has_permission() alone would miss it.
 */
const ROLES = [
  {
    email: 'admin@acme.test', role: 'builder_admin',
    allow: ['/api/leads', '/api/projects', '/api/units', '/api/bookings', '/api/employees',
            '/api/accounts', '/api/vendors', '/api/documents', '/api/brokers'],
    // The one thing a builder_admin is deliberately NOT given. Platform
    // control belongs to the platform tenant; a workspace owner reaching it
    // would be a tenancy break, not a convenience.
    deny: ['/api/tenants'],
  },
  {
    email: 'manager@acme.test', role: 'sales_manager',
    allow: ['/api/leads', '/api/bookings', '/api/units', '/api/brokers', '/api/campaigns'],
    // Runs the pipeline, does not keep the books.
    deny: ['/api/accounts', '/api/employees'],
  },
  {
    email: 'sales@acme.test', role: 'sales_executive',
    allow: ['/api/leads', '/api/units', '/api/projects', '/api/bookings'],
    deny: ['/api/accounts', '/api/employees', '/api/vendors'],
  },
  {
    email: 'tele@acme.test', role: 'telecaller',
    // Calls a list and books the appointment. No inventory: a telecaller who
    // can quote a unit is a sales executive with a worse job title.
    allow: ['/api/leads', '/api/projects', '/api/crm-tasks'],
    deny: ['/api/units', '/api/bookings', '/api/accounts', '/api/employees'],
  },
  {
    email: 'accounts@acme.test', role: 'accountant',
    allow: ['/api/accounts', '/api/journal-entries', '/api/bank-accounts', '/api/invoices',
            '/api/vendors', '/api/bookings', '/api/rera/registrations', '/api/demand-letters/due'],
    // Finance, no CRM. This is the pairing that once produced a dashboard
    // reporting zero leads and zero revenue on a workspace holding both,
    // because the 403 was caught and thrown away.
    deny: ['/api/leads', '/api/employees'],
  },
  {
    email: 'site@acme.test', role: 'site_engineer',
    allow: ['/api/projects', '/api/site-tasks', '/api/materials', '/api/vendors',
            '/api/employees', '/api/attendance'],
    deny: ['/api/leads', '/api/accounts'],
  },
  {
    email: 'hr@acme.test', role: 'hr_manager',
    allow: ['/api/employees', '/api/attendance', '/api/leave-requests', '/api/payroll-runs',
            '/api/projects', '/api/documents'],
    // Computes payroll; the accountant posts it. Separating the two is the
    // reason this role exists instead of another builder_admin.
    deny: ['/api/leads', '/api/accounts', '/api/journal-entries'],
  },
  {
    email: 'land@acme.test', role: 'land_manager',
    allow: ['/api/land-leads', '/api/land-documents', '/api/projects', '/api/documents'],
    deny: ['/api/leads', '/api/accounts', '/api/employees'],
  },
  {
    email: 'bd@acme.test', role: 'bd_manager',
    allow: ['/api/bd-leads', '/api/land-leads', '/api/projects', '/api/market-reports'],
    deny: ['/api/leads', '/api/accounts', '/api/employees'],
  },
  {
    email: 'auditor@acme.test', role: 'auditor',
    // Reads every module. Read-only roles were once filtered to "leads
    // assigned to me" by an own-only rule that inferred scope from the absence
    // of manage_leads — an auditor is assigned nothing, so they audited
    // nothing. /api/leads returning rows is that regression's tripwire.
    allow: ['/api/leads', '/api/projects', '/api/units', '/api/bookings', '/api/accounts',
            '/api/employees', '/api/vendors', '/api/documents'],
    deny: [],
  },
];

/**
 * The platform pair lives in the platform tenant, which the demo seeder does
 * not touch — creating a super admin with a known password is not something a
 * demo script should ever do. So the addresses come from the environment.
 *
 * Defaults are the CI fixtures (scripts/seed-test-fixtures.mjs). Against a
 * local deployment, point them at your own platform accounts:
 *   PLATFORM_ADMIN_EMAIL=you@company.com PLATFORM_PASSWORD='…' node …
 */
// 'Test1234!' is what seed-test-fixtures.mjs sets, and is not the demo
// workspace password — the two seeders are independent and always have been.
const PLATFORM_PW = process.env.PLATFORM_PASSWORD ?? 'Test1234!';
const PLATFORM = [
  {
    email: process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@erptest.local',
    password: PLATFORM_PW,
    role: 'super_admin', platform: true,
    allow: ['/api/tenants', '/api/branches'],
    deny: [],
  },
  {
    email: process.env.PLATFORM_TECH_EMAIL ?? 'tech@erptest.local',
    password: PLATFORM_PW,
    role: 'tech_team', platform: true,
    allow: ['/api/tenants'],
    // Onboards and supports builders. Cannot read what is inside a workspace:
    // support access is not customer-data access.
    deny: ['/api/leads', '/api/accounts'],
  },
];

const PORTAL = [
  { email: 'buyer@acme.test',   role: 'customer' },
  { email: 'partner@acme.test', role: 'partner'  },
];

console.log('\n=== STAFF SIGN-IN, ONE ROLE AT A TIME ===');
const seen = new Map();

for (const r of [...ROLES, ...PLATFORM]) {
  console.log(`\n--- ${r.role} (${r.email}) ---`);
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: r.email, password: r.password ?? PW,
      ...(r.platform ? {} : { workspaceCode: SLUG }),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 429) {
    // Worth its own message: a rate-limited run reports every later role as
    // broken, and the first time that happened it read as nine real failures.
    console.error('\n  The login rate limit is refusing this suite. Restart the API as:');
    console.error('    AUTH_RATE_LIMIT_MAX=200 npm run dev\n');
    process.exit(2);
  }
  ok('signs in', res.status === 200 && !!body.token, `${res.status} ${body.error ?? ''}`);
  if (!body.token) continue;

  // The role comes from the database, never from anything the client sent.
  ok(`the server calls them ${r.role}`, body.user?.role === r.role, String(body.user?.role));

  const me = await get('/api/auth/me', body.token);
  const meBody = await me.json().catch(() => ({}));
  const perms = meBody.permissions ?? [];
  ok('holds at least one permission', perms.length > 0, `${perms.length}`);
  seen.set(r.role, perms.length);

  for (const p of r.allow) {
    const g = await get(p, body.token);
    ok(`reaches ${p}`, g.status === 200, String(g.status));
  }
  for (const p of r.deny) {
    const g = await get(p, body.token);
    // 403 is the answer worth having: the route exists and refused. A 404
    // would also keep the data safe but tells the caller the wrong thing.
    ok(`is refused ${p}`, g.status === 403, String(g.status));
  }
}

console.log('\n=== NO ROLE IS A COPY OF ANOTHER ===');
// Two roles holding the identical key set means one of them is decoration.
// Compared by count, which is enough to catch a map entry pasted and not
// edited — the failure that produced this check.
const admin = seen.get('builder_admin') ?? 0;
for (const [role, n] of seen) {
  if (role === 'builder_admin' || role === 'super_admin') continue;
  ok(`${role} is narrower than builder_admin`, n < admin, `${n} vs ${admin}`);
}

console.log('\n=== PORTAL SIGN-IN ===');
for (const p of PORTAL) {
  console.log(`\n--- ${p.role} (${p.email}) ---`);
  const res = await fetch(BASE + '/api/portal/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: p.email, password: PW, tenantSlug: SLUG }),
  });
  const body = await res.json().catch(() => ({}));
  ok('signs in', res.status === 200 && !!body.token, `${res.status} ${body.error ?? ''}`);
  if (!body.token) continue;
  ok(`is a ${p.role}`, body.portalUser?.role === p.role, String(body.portalUser?.role));
  // Exclusive by CHECK constraint: a customer carries a lead, a partner a
  // broker, and never both.
  ok('is linked to exactly one record',
     (p.role === 'customer') === (!!body.portalUser?.leadId && !body.portalUser?.brokerId),
     `lead=${body.portalUser?.leadId ?? '-'} broker=${body.portalUser?.brokerId ?? '-'}`);

  const ov = await get('/api/portal/overview', body.token);
  ok('opens their portal', ov.status === 200, String(ov.status));
  const view = await ov.json().catch(() => ({}));

  // ── The payload carries every field the page renders ───────────────────
  //
  // Not pedantry. The partner portal formatted `bookingValue` as currency,
  // the payload never contained it, and the page died on
  // `undefined.toLocaleString()` — a white screen behind a successful login.
  // Nobody had hit it because no partner account existed to sign in with.
  //
  // Asserting the SHAPE is what a type cast cannot do: both mappers reach the
  // view model through `as unknown as T`, which silences precisely this.
  if (p.role === 'partner') {
    const b = view.broker ?? {};
    ok('the broker summary has its figures',
       typeof b.leadsReferred === 'number' && typeof b.bookingsClosed === 'number',
       JSON.stringify({ leadsReferred: b.leadsReferred, bookingsClosed: b.bookingsClosed }));
    const lines = view.commissions ?? [];
    ok('there is a commission to check', lines.length > 0, `${lines.length}`);
    for (const c of lines.slice(0, 3)) {
      ok(`commission ${String(c.id).slice(0, 8)} says what earned it`,
         typeof c.bookingValue === 'number' && !!c.leadName && !!c.project,
         JSON.stringify({ bookingValue: c.bookingValue, leadName: c.leadName, project: c.project }));
      // Rate is derived from the two amounts, so it must agree with them.
      const expected = c.bookingValue > 0
        ? Math.round((c.amountEarned / c.bookingValue) * 10000) / 100 : null;
      ok(`…and its rate matches the amounts`, c.rate === expected,
         `${c.rate} vs ${expected}`);
    }
  } else {
    const units = view.units ?? [];
    ok('the booked unit is identified', units.length > 0 && !!units[0].unitCode,
       JSON.stringify(units[0] ?? null));
    ok('…with an area to show', units.length > 0 && typeof units[0].areaSqft === 'number');
    const bk = (view.bookings ?? [])[0];
    // The card prints "Payment plan {x}"; without this it printed nothing.
    ok('the booking names its payment plan', !!bk && !!bk.paymentPlan, JSON.stringify(bk ?? null));
  }

  // A portal token is not a staff token. Same signature, different realm —
  // the staff routes must not accept it.
  const cross = await get('/api/leads', body.token);
  ok('cannot use the portal token on staff routes', cross.status === 401 || cross.status === 403,
     String(cross.status));
}

console.log('\n=== A ROLE THE PICKER OFFERS EXISTS IN THE WORKSPACE ===');
// The picker is built from this list; if the workspace has no such role, the
// entry is an invitation to an account that cannot be created.
const PICKER_WORKSPACE_ROLES = [
  'builder_admin', 'sales_manager', 'sales_executive', 'accountant',
  'site_engineer', 'hr_manager', 'telecaller', 'land_manager', 'bd_manager', 'auditor',
];
for (const role of PICKER_WORKSPACE_ROLES) {
  ok(`${role} signed in and holds keys`, (seen.get(role) ?? 0) > 0, 'no account or no grants');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
