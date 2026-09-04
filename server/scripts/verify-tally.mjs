/**
 * The Tally export, and the two conventions that decide whether it lands.
 *
 * WHAT THIS IS FOR
 *
 * Every builder in India runs Tally and none of them intends to stop. Without
 * an export, the accounts team re-keys the month by hand — which is where the
 * two sets of books start to disagree, and why "does it export to Tally" is the
 * first question a CA asks.
 *
 * THE ASSERTIONS THAT MATTER
 *
 * Amounts are SIGNED, and the sign is the entry type: a debit is negative and a
 * credit is positive. Backwards, the file imports cleanly and REVERSES every
 * entry in the ledger — far worse than one that fails, because nobody notices
 * until a trial balance is upside down.
 *
 * Masters come before vouchers. Tally imports top to bottom, so a voucher
 * naming a ledger it has not yet created fails on that voucher alone and leaves
 * a partially imported month, which looks like success.
 *
 * And a draft entry is not an export. Pushing unapproved postings into the
 * accounts puts them in front of a CA under the builder's name.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'tl' + Math.random().toString(36).slice(2, 8);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

async function workspace(slug, perms) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email) VALUES ($1,$2,$3,$4) RETURNING id`,
    [`${MARK} ${slug}`, `Sundar & Co ${slug}`, `${MARK}-${slug}`, `${MARK}-${slug}@tl.test`])).rows[0];
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'Accounts',false) RETURNING id`, [t.id])).rows[0];
  if (perms.length) {
    await admin.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  }
  const email = `${MARK}-${slug}@tl.test`;
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,'Accounts',$3,$4,true)`,
    [t.id, role.id, email, await argon2.hash(PW, { type: argon2.argon2id })]);
  const token = (await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json()).token;
  if (!token) throw new Error(`login failed for ${email}`);
  return { tenantId: t.id, token };
}

const account = async (w, code, name, type) => (await admin.query(
  `INSERT INTO chart_of_accounts (tenant_id, code, name, account_type)
   VALUES ($1,$2,$3,$4) RETURNING id`, [w.tenantId, code, name, type])).rows[0].id;

/**
 * A journal entry with its lines, at a chosen status.
 *
 * Always created as a DRAFT and promoted afterwards. `trg_je_balanced_entry`
 * refuses a posted entry with fewer than two lines, so inserting it as posted
 * and adding lines after fails on the header insert — the ledger is protecting
 * itself, and the fixture has to work the way the application does.
 */
async function entry(w, { date, reference, narration, status, lines }) {
  const je = (await admin.query(
    `INSERT INTO journal_entries (tenant_id, entry_date, reference, narration, status)
     VALUES ($1,$2::date,$3,$4,'draft') RETURNING id`,
    [w.tenantId, date, reference, narration])).rows[0];
  for (const l of lines) {
    await admin.query(
      `INSERT INTO journal_entry_lines (tenant_id, journal_entry_id, account_id, debit, credit, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [w.tenantId, je.id, l.accountId, l.debit ?? 0, l.credit ?? 0, l.note ?? null]);
  }
  if (status !== 'draft') {
    await admin.query('UPDATE journal_entries SET status = $1 WHERE id = $2', [status, je.id]);
  }
  return je.id;
}

const api = (token, path) => fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });

const A = await workspace('a', ['view_accounts']);
const B = await workspace('b', ['view_accounts']);

// An ampersand in the company name and a ledger name, deliberately: an
// unescaped one produces a file Tally rejects with a parse error thirty
// thousand lines in.
const bank = await account(A, '1100', 'HDFC Bank & Trust', 'asset');
const sales = await account(A, '4000', 'Sales <Residential>', 'income');
const suspenseish = await account(A, '9999', 'Odd Account', 'equity');

console.log('\n=== IT IS WELL-FORMED XML TALLY WILL PARSE ===');
await entry(A, {
  date: '2026-05-10', reference: 'JV-001', narration: 'Booking receipt', status: 'posted',
  lines: [{ accountId: bank, debit: 500000 }, { accountId: sales, credit: 500000 }],
});

const res = await api(A.token, '/api/exports/tally?from=2026-05-01&to=2026-05-31');
ok('the export returns 200', res.status === 200, String(res.status));
ok('as XML', (res.headers.get('content-type') ?? '').includes('xml'), res.headers.get('content-type'));
ok('as an attachment, not inline',
   /^attachment/.test(res.headers.get('content-disposition') ?? ''),
   res.headers.get('content-disposition'));
ok('and is not cached', /no-store/.test(res.headers.get('cache-control') ?? ''));

const xml = await res.text();
ok('it declares an XML prolog', xml.startsWith('<?xml version="1.0"'));
ok('and uses Tally\'s import envelope',
   xml.includes('<TALLYREQUEST>Import Data</TALLYREQUEST>') && xml.includes('<IMPORTDATA>'));
ok('naming the company', xml.includes('SVCURRENTCOMPANY'));

console.log('\n=== USER DATA IS ESCAPED, OR THE FILE IS UNPARSEABLE ===');
ok('an ampersand in the company name is escaped',
   xml.includes('Sundar &amp; Co') && !/Sundar & Co/.test(xml), 'raw & present');
ok('an ampersand in a ledger name is escaped', xml.includes('HDFC Bank &amp; Trust'));
ok('angle brackets in a ledger name are escaped',
   xml.includes('Sales &lt;Residential&gt;') && !xml.includes('<Residential>'));
// The cheapest possible proof it parses: no stray unescaped entity.
ok('no bare ampersand survives anywhere',
   !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'unescaped & found');

console.log('\n=== THE SIGN CONVENTION — BACKWARDS REVERSES THE LEDGER ===');
const entries = [...xml.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)]
  .map(m => ({
    ledger: /<LEDGERNAME>([\s\S]*?)<\/LEDGERNAME>/.exec(m[1])?.[1] ?? '',
    positive: /<ISDEEMEDPOSITIVE>(\w+)<\/ISDEEMEDPOSITIVE>/.exec(m[1])?.[1] ?? '',
    amount: Number(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/.exec(m[1])?.[1] ?? 'NaN'),
  }));
ok('both sides of the entry are written', entries.length === 2, String(entries.length));

const debitSide = entries.find(e => e.ledger.includes('HDFC'));
const creditSide = entries.find(e => e.ledger.includes('Sales'));
ok('the DEBIT is negative', debitSide?.amount === -500000, String(debitSide?.amount));
ok('and marked deemed-positive', debitSide?.positive === 'Yes', debitSide?.positive);
ok('the CREDIT is positive', creditSide?.amount === 500000, String(creditSide?.amount));
ok('and marked not deemed-positive', creditSide?.positive === 'No', creditSide?.positive);
ok('the two sides sum to zero, as Tally requires',
   Math.abs((debitSide?.amount ?? 0) + (creditSide?.amount ?? 0)) < 0.001);

console.log('\n=== DATES CARRY NO SEPARATORS ===');
ok('the voucher date is YYYYMMDD', xml.includes('<DATE>20260510</DATE>'),
   /<DATE>([^<]*)<\/DATE>/.exec(xml)?.[1]);
ok('and no hyphenated date leaks through', !/<DATE>\d{4}-\d{2}-\d{2}<\/DATE>/.test(xml));

console.log('\n=== MASTERS COME BEFORE THE VOUCHERS THAT NAME THEM ===');
// Tally imports top to bottom. A voucher naming a ledger it has not created
// fails alone and leaves a partially imported month.
const firstLedgerMaster = xml.indexOf('<LEDGER NAME=');
const firstVoucher = xml.indexOf('<VOUCHER ');
ok('ledger masters are emitted', firstLedgerMaster > -1);
ok('and appear before the first voucher',
   firstLedgerMaster > -1 && firstLedgerMaster < firstVoucher,
   `master@${firstLedgerMaster} voucher@${firstVoucher}`);

console.log('\n=== ACCOUNTS LAND IN THE RIGHT TALLY GROUP ===');
// A bank under "Sundry Debtors" produces a trial balance that balances and
// means nothing.
const groupOf = (ledger) => {
  const re = new RegExp(`<LEDGER NAME="${ledger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?<PARENT>([^<]*)</PARENT>`);
  return re.exec(xml)?.[1] ?? '';
};
ok('an asset lands in Current Assets', groupOf('HDFC Bank &amp; Trust') === 'Current Assets',
   groupOf('HDFC Bank &amp; Trust'));
ok('income lands in Direct Incomes', groupOf('Sales &lt;Residential&gt;') === 'Direct Incomes',
   groupOf('Sales &lt;Residential&gt;'));

console.log('\n=== A DRAFT IS NOT AN EXPORT ===');
await entry(A, {
  date: '2026-05-12', reference: 'JV-DRAFT', narration: 'Not approved', status: 'draft',
  lines: [{ accountId: bank, debit: 999 }, { accountId: sales, credit: 999 }],
});
const xml2 = await (await api(A.token, '/api/exports/tally?from=2026-05-01&to=2026-05-31')).text();
ok('a draft entry does not reach Tally', !xml2.includes('JV-DRAFT'), 'draft exported');
ok('and its amount is absent too', !xml2.includes('999.00'));

console.log('\n=== AN UNBALANCED VOUCHER CANNOT EXIST TO BE EXPORTED ===');
// The export refuses to produce a file containing one, because Tally rejects
// them a voucher at a time and the rest of the month lands looking like
// success. It turns out that guard can never fire through normal use: the
// ledger will not let a posted entry be unbalanced in the first place. Both
// are worth having, and the stronger of the two is asserted here.
const rejected = await entry(A, {
  date: '2026-05-20', reference: 'JV-BAD', narration: 'Out of balance', status: 'posted',
  lines: [{ accountId: bank, debit: 100 }, { accountId: sales, credit: 60 }],
}).then(() => 'accepted', e => e.code);
ok('the LEDGER refuses to post an unbalanced entry', rejected === '23514', String(rejected));
ok('so no unbalanced voucher ever reaches the exporter',
   !(await (await api(A.token, '/api/exports/tally?from=2026-05-01&to=2026-05-31')).text()).includes('JV-BAD'));

// The exporter's own guard, exercised directly — it is defence in depth for a
// ledger that changes, and it should still be correct.
const { unbalancedVouchers } = await import('../src/tally.ts');
const flagged = unbalancedVouchers([
  { date: '2026-05-20', voucherNumber: 'JV-SYNTH', lines: [{ accountName: 'A', debit: 100, credit: 0 }, { accountName: 'B', debit: 0, credit: 60 }] },
  { date: '2026-05-21', voucherNumber: 'JV-OK', lines: [{ accountName: 'A', debit: 50, credit: 0 }, { accountName: 'B', debit: 0, credit: 50 }] },
]);
ok('the exporter flags an unbalanced voucher', flagged.length === 1, String(flagged.length));
ok('naming it', flagged[0]?.voucherNumber === 'JV-SYNTH', flagged[0]?.voucherNumber);
ok('with the amount it is out by', Math.abs(flagged[0]?.difference - 40) < 0.01, String(flagged[0]?.difference));
ok('and leaves a balanced one alone', !flagged.some(f => f.voucherNumber === 'JV-OK'));

console.log('\n=== PREFLIGHT ANSWERS THE SAME QUESTION BEFORE MONTH END ===');
const pre = (await (await api(A.token, '/api/exports/tally/preflight?from=2026-05-01&to=2026-05-31')).json()).preflight;
ok('preflight reports ready', pre.ready === true, String(pre.ready));
ok('with nothing unbalanced', pre.unbalanced.length === 0, JSON.stringify(pre.unbalanced));
ok('it counts the vouchers it would send', pre.vouchers >= 1, String(pre.vouchers));
ok('and the ledgers', pre.ledgers >= 2, String(pre.ledgers));

console.log('\n=== AN UNMAPPED ACCOUNT TYPE IS SURFACED, NOT SWALLOWED ===');
await entry(A, {
  date: '2026-05-22', reference: 'JV-EQ', narration: 'Equity movement', status: 'posted',
  lines: [{ accountId: suspenseish, debit: 10 }, { accountId: bank, credit: 10 }],
});
const preSusp = (await (await api(A.token, '/api/exports/tally/preflight?from=2026-05-01&to=2026-05-31')).json()).preflight;
ok('equity maps to a real group rather than Suspense',
   !preSusp.suspense.some(s => s.name === 'Odd Account'),
   JSON.stringify(preSusp.suspense));

console.log('\n=== IT IS PERMISSIONED AND TENANT-SCOPED ===');
const crossXml = await (await api(B.token, '/api/exports/tally?from=2026-05-01&to=2026-05-31')).text();
ok('another tenant sees none of these vouchers', !crossXml.includes('JV-001'), 'leaked');
ok('nor these ledgers', !crossXml.includes('HDFC Bank'), 'leaked');

const noPerm = await workspace('c', []);
const denied = await api(noPerm.token, '/api/exports/tally?from=2026-05-01&to=2026-05-31');
ok('a user without view_accounts is refused', denied.status === 403, String(denied.status));

for (const w of [A, B, noPerm]) await admin.query('DELETE FROM tenants WHERE id = $1', [w.tenantId]);
await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
