/**
 * Tally XML export.
 *
 * Every builder in India runs Tally, and none of them intends to stop. An ERP
 * that cannot hand its ledger over is an ERP whose accounts team re-keys the
 * month into Tally by hand — which is where the two sets of books start to
 * disagree, and the reason "does it export to Tally" is the first question a
 * CA asks.
 *
 * The format is Tally's own request/import envelope, which is XML but not
 * XML anyone would design: element names are shouty, the structure is nested
 * TALLYMESSAGE blocks, and the tags carry meaning through attributes that look
 * decorative. What is written here is the shape Tally's import actually
 * accepts.
 *
 * TWO CONVENTIONS THAT DECIDE WHETHER AN IMPORT LANDS
 *
 * Amounts are SIGNED, and the sign is the entry type: a debit is negative and a
 * credit is positive. Getting this backwards produces a file that imports
 * cleanly and reverses every entry in the ledger, which is worse than one that
 * fails.
 *
 * Dates are YYYYMMDD with no separators. A hyphenated date is rejected by some
 * Tally versions and silently read as garbage by others.
 */

export interface TallyLine {
  accountName: string;
  debit: number;
  credit: number;
  note?: string;
}

export interface TallyVoucher {
  date: string;          // ISO or YYYY-MM-DD
  voucherNumber: string;
  narration?: string;
  /** Tally's own voucher classes. 'Journal' is the safe default for a posting
   *  that is not obviously a receipt or a payment. */
  voucherType?: 'Journal' | 'Receipt' | 'Payment' | 'Sales' | 'Purchase';
  lines: TallyLine[];
}

/**
 * XML escaping.
 *
 * Ledger names are user data — a project called "Sundar & Co" or a narration
 * containing "<" is ordinary — and an unescaped ampersand produces a file Tally
 * rejects with a parse error thirty thousand lines in, which is a miserable
 * thing to debug.
 */
export function xmlEscape(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Control characters are not legal in XML 1.0 at all, and they arrive via
    // pasted spreadsheet cells more often than anyone expects.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/** YYYYMMDD. Tally will not take a hyphen. */
export function tallyDate(value: string | Date): string {
  const s = typeof value === 'string' ? value : value.toISOString();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  // Local parts, not toISOString: a date-only value parsed at local midnight
  // shifts back a day when rendered in UTC anywhere east of Greenwich.
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * One ledger entry inside a voucher.
 *
 * ISDEEMEDPOSITIVE is Tally's way of saying "this is the debit side", and it
 * must agree with the sign of AMOUNT. They are written from the same branch
 * here precisely so they cannot drift apart.
 */
function ledgerEntry(line: TallyLine): string {
  const isDebit = Number(line.debit) > 0;
  const magnitude = isDebit ? Number(line.debit) : Number(line.credit);
  const amount = (isDebit ? -magnitude : magnitude).toFixed(2);
  return [
    '        <ALLLEDGERENTRIES.LIST>',
    `          <LEDGERNAME>${xmlEscape(line.accountName)}</LEDGERNAME>`,
    `          <ISDEEMEDPOSITIVE>${isDebit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`,
    `          <AMOUNT>${amount}</AMOUNT>`,
    line.note ? `          <NARRATION>${xmlEscape(line.note)}</NARRATION>` : '',
    '        </ALLLEDGERENTRIES.LIST>',
  ].filter(Boolean).join('\n');
}

function voucher(v: TallyVoucher): string {
  const type = v.voucherType ?? 'Journal';
  const date = tallyDate(v.date);
  return [
    '    <TALLYMESSAGE xmlns:UDF="TallyUDF">',
    `      <VOUCHER VCHTYPE="${xmlEscape(type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
    `        <DATE>${date}</DATE>`,
    `        <EFFECTIVEDATE>${date}</EFFECTIVEDATE>`,
    `        <VOUCHERTYPENAME>${xmlEscape(type)}</VOUCHERTYPENAME>`,
    `        <VOUCHERNUMBER>${xmlEscape(v.voucherNumber)}</VOUCHERNUMBER>`,
    v.narration ? `        <NARRATION>${xmlEscape(v.narration)}</NARRATION>` : '',
    v.lines.map(ledgerEntry).join('\n'),
    '      </VOUCHER>',
    '    </TALLYMESSAGE>',
  ].filter(Boolean).join('\n');
}

/**
 * The ledger masters.
 *
 * Tally will not accept a voucher naming a ledger it has never heard of, and
 * the error it gives says only "Ledger does not exist" without naming which.
 * Exporting the masters alongside the vouchers means one file imports into a
 * fresh company, which is what people actually want and what a voucher-only
 * export fails to do on its first run.
 */
function ledgerMaster(name: string, group: string): string {
  return [
    '    <TALLYMESSAGE xmlns:UDF="TallyUDF">',
    `      <LEDGER NAME="${xmlEscape(name)}" ACTION="Create">`,
    `        <NAME>${xmlEscape(name)}</NAME>`,
    `        <PARENT>${xmlEscape(group)}</PARENT>`,
    '      </LEDGER>',
    '    </TALLYMESSAGE>',
  ].join('\n');
}

/**
 * This product's account types mapped onto Tally's own groups.
 *
 * Tally's chart is a tree of named groups, not a type enum, and an import that
 * puts a bank account under "Sundry Debtors" produces a trial balance that
 * balances and means nothing. These are the standard top-level groups every
 * Tally company ships with, so they resolve without any setup.
 */
export const TALLY_GROUPS: Record<string, string> = {
  asset: 'Current Assets',
  liability: 'Current Liabilities',
  equity: 'Capital Account',
  income: 'Direct Incomes',
  revenue: 'Direct Incomes',
  expense: 'Indirect Expenses',
  bank: 'Bank Accounts',
  cash: 'Cash-in-Hand',
  receivable: 'Sundry Debtors',
  payable: 'Sundry Creditors',
};

export function tallyGroupFor(accountType: string): string {
  return TALLY_GROUPS[String(accountType ?? '').toLowerCase()] ?? 'Suspense A/c';
}

export interface TallyExportInput {
  companyName: string;
  accounts: Array<{ name: string; accountType: string }>;
  vouchers: TallyVoucher[];
}

/**
 * The whole envelope: masters first, then vouchers.
 *
 * Order is not cosmetic. Tally imports the file top to bottom, so a voucher
 * appearing before the ledger it names fails on that voucher alone and leaves a
 * partially imported month — the worst outcome, because it looks like it worked.
 */
export function buildTallyXml(input: TallyExportInput): string {
  const masters = input.accounts.map(a => ledgerMaster(a.name, tallyGroupFor(a.accountType)));
  const vouchers = input.vouchers.map(voucher);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE>',
    '  <HEADER>',
    '    <TALLYREQUEST>Import Data</TALLYREQUEST>',
    '  </HEADER>',
    '  <BODY>',
    '    <IMPORTDATA>',
    '      <REQUESTDESC>',
    '        <REPORTNAME>All Masters</REPORTNAME>',
    '        <STATICVARIABLES>',
    `          <SVCURRENTCOMPANY>${xmlEscape(input.companyName)}</SVCURRENTCOMPANY>`,
    '        </STATICVARIABLES>',
    '      </REQUESTDESC>',
    '      <REQUESTDATA>',
    masters.join('\n'),
    vouchers.join('\n'),
    '      </REQUESTDATA>',
    '    </IMPORTDATA>',
    '  </BODY>',
    '</ENVELOPE>',
    '',
  ].filter(l => l !== '').join('\n');
}

/**
 * Does a voucher balance?
 *
 * Tally rejects an unbalanced voucher, and it does so per voucher rather than
 * per file — so one bad entry in a thousand fails alone and leaves the rest
 * imported. Checking here means the export refuses to produce a file that will
 * half-import, which is much easier to act on than a Tally error log.
 */
export function unbalancedVouchers(vouchers: TallyVoucher[]): Array<{ voucherNumber: string; difference: number }> {
  const out: Array<{ voucherNumber: string; difference: number }> = [];
  for (const v of vouchers) {
    const debit = v.lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const credit = v.lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    const difference = Math.round((debit - credit) * 100) / 100;
    if (Math.abs(difference) > 0.009) out.push({ voucherNumber: v.voucherNumber, difference });
  }
  return out;
}
