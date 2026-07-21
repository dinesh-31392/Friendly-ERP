import { getByTenant, create, update, logAudit } from './db';
import type {
  Account, AccountType, JournalEntry, JournalLine, JournalSource,
  VendorBill, RaBill, PaymentMade,
} from '../types';
import { BUDGET_CATEGORIES } from '../types';
import { v4 as uuid } from 'uuid';

/**
 * Double-entry ledger. Every business event that moves money posts a balanced
 * journal entry here; the statements (trial balance / P&L / balance sheet)
 * are pure folds over posted entries — nothing is stored twice.
 *
 * The demo ledger is CASH-BASIS for customer money (income is recognised when
 * a payment lands, not when an invoice is raised) and ACCRUAL for vendor money
 * (expense on bill approval, payable cleared on payment). Stated in the UI.
 */

// Well-known system account codes auto-posting relies on
export const COA = {
  CASH: '1000',
  AP: '2000',
  RETENTION: '2100',
  STATUTORY: '2200',
  EQUITY: '3000',
  SALES: '4000',
  OTHER_INCOME: '4100',
  CONTRACTOR_WORK: '5950',
} as const;

const SEED_ACCOUNTS: { code: string; name: string; type: AccountType }[] = [
  { code: COA.CASH, name: 'Cash & Bank', type: 'asset' },
  { code: COA.AP, name: 'Accounts Payable', type: 'liability' },
  { code: COA.RETENTION, name: 'Retention Payable', type: 'liability' },
  { code: COA.STATUTORY, name: 'Statutory Deductions Payable', type: 'liability' },
  { code: COA.EQUITY, name: "Owner's Equity", type: 'equity' },
  { code: COA.SALES, name: 'Sales — Unit Bookings', type: 'income' },
  { code: COA.OTHER_INCOME, name: 'Other Income', type: 'income' },
  // One expense head per budget category, so bills post to the same cost
  // heads that budgets track (5000, 5100, … in catalog order)
  ...BUDGET_CATEGORIES.map((name, i) => ({
    code: String(5000 + i * 100), name: `${name} Expense`, type: 'expense' as AccountType,
  })),
  { code: COA.CONTRACTOR_WORK, name: 'Contractor Work (RA)', type: 'expense' },
];

/** Idempotent per tenant: seeds the standard chart on first use, then fills
 *  in any system account added by a later release. */
export function ensureCoa(tenantId: string): Account[] {
  const existing = getByTenant<Account>('accounts', tenantId);
  const byCode = new Set(existing.map(a => a.code));
  const missing = SEED_ACCOUNTS.filter(s => !byCode.has(s.code));
  const created = missing.map(s => create<Account>('accounts', {
    id: '', tenantId, code: s.code, name: s.name, type: s.type,
    isSystem: true, active: true, createdAt: new Date().toISOString(),
  }));
  return [...existing, ...created].sort((a, b) => a.code.localeCompare(b.code));
}

export function accountByCode(tenantId: string, code: string): Account | undefined {
  return getByTenant<Account>('accounts', tenantId).find(a => a.code === code);
}

/** The expense account matching a cost head (BUDGET_CATEGORIES member). */
export function expenseAccountFor(tenantId: string, category: string): Account | undefined {
  const idx = BUDGET_CATEGORIES.indexOf(category);
  const code = idx >= 0 ? String(5000 + idx * 100) : COA.CONTRACTOR_WORK;
  return accountByCode(tenantId, code);
}

export interface PostLineInput { accountId: string; debit?: number; credit?: number; note?: string }

/**
 * Post a balanced entry. Throws when debits ≠ credits (to the paisa) or the
 * entry has no lines — the ledger never stores an unbalanced posting.
 */
export function postEntry(opts: {
  tenantId: string;
  narration: string;
  lines: PostLineInput[];
  sourceType: JournalSource;
  sourceId?: string;
  projectId?: string;
  reference?: string;
  date?: string;
  actor: { id: string; name: string };
  status?: 'draft' | 'posted';
}): JournalEntry {
  const lines: JournalLine[] = opts.lines
    .filter(l => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0)
    .map(l => ({ id: uuid(), accountId: l.accountId, debit: l.debit ?? 0, credit: l.credit ?? 0, note: l.note }));
  if (lines.length < 2) throw new Error('A journal entry needs at least two lines');
  const dr = lines.reduce((s, l) => s + l.debit, 0);
  const cr = lines.reduce((s, l) => s + l.credit, 0);
  if (Math.round(dr * 100) !== Math.round(cr * 100)) {
    throw new Error(`Entry does not balance: debits ${dr} ≠ credits ${cr}`);
  }
  const status = opts.status ?? 'posted';
  const entry = create<JournalEntry>('journalEntries', {
    id: '', tenantId: opts.tenantId,
    date: opts.date ?? new Date().toISOString().slice(0, 10),
    narration: opts.narration, reference: opts.reference,
    sourceType: opts.sourceType, sourceId: opts.sourceId, projectId: opts.projectId,
    status, lines,
    createdBy: opts.actor.id,
    postedBy: status === 'posted' ? opts.actor.id : undefined,
    postedAt: status === 'posted' ? new Date().toISOString() : undefined,
    createdAt: new Date().toISOString(),
  });
  logAudit({
    tenantId: opts.tenantId, userId: opts.actor.id, userName: opts.actor.name,
    action: 'create', entity: 'journal_entry', entityId: entry.id,
    details: `${status === 'posted' ? 'Posted' : 'Drafted'} JE (${opts.sourceType}): ${opts.narration.slice(0, 60)}`,
  });
  return entry;
}

export function postDraft(entry: JournalEntry, actor: { id: string; name: string }): void {
  update<JournalEntry>('journalEntries', entry.id, {
    status: 'posted', postedBy: actor.id, postedAt: new Date().toISOString(),
  });
  logAudit({
    tenantId: entry.tenantId, userId: actor.id, userName: actor.name,
    action: 'update', entity: 'journal_entry', entityId: entry.id,
    details: `Posted draft JE: ${entry.narration.slice(0, 60)}`,
  });
}

// ── Auto-posting from business events ────────────────────────────────────────
// Each helper is a no-op (returns null) when the ledger accounts are missing —
// posting must never block the business flow that triggered it.

export function postVendorBillApproved(bill: VendorBill, actor: { id: string; name: string }): JournalEntry | null {
  const expense = expenseAccountFor(bill.tenantId, bill.category);
  const ap = accountByCode(bill.tenantId, COA.AP);
  if (!expense || !ap) return null;
  return postEntry({
    tenantId: bill.tenantId,
    narration: `Vendor bill ${bill.billNumber || bill.id.slice(0, 6)} approved (${bill.category})`,
    lines: [
      { accountId: expense.id, debit: bill.amount },
      { accountId: ap.id, credit: bill.amount },
    ],
    sourceType: 'vendor_bill', sourceId: bill.id, projectId: bill.projectId,
    reference: bill.billNumber, actor,
  });
}

export function postApPayment(payment: PaymentMade, narration: string, projectId: string | undefined, actor: { id: string; name: string }): JournalEntry | null {
  const ap = accountByCode(payment.tenantId, COA.AP);
  const cash = accountByCode(payment.tenantId, COA.CASH);
  if (!ap || !cash) return null;
  return postEntry({
    tenantId: payment.tenantId, narration,
    lines: [
      { accountId: ap.id, debit: payment.amount },
      { accountId: cash.id, credit: payment.amount },
    ],
    sourceType: 'ap_payment', sourceId: payment.id, projectId,
    reference: payment.reference, date: payment.date, actor,
  });
}

export function postRaApproved(ra: RaBill, actor: { id: string; name: string }): JournalEntry | null {
  const work = accountByCode(ra.tenantId, COA.CONTRACTOR_WORK);
  const retention = accountByCode(ra.tenantId, COA.RETENTION);
  const statutory = accountByCode(ra.tenantId, COA.STATUTORY);
  const ap = accountByCode(ra.tenantId, COA.AP);
  if (!work || !retention || !statutory || !ap) return null;
  const deductionsTotal = ra.deductions.reduce((s, d) => s + d.amount, 0);
  return postEntry({
    tenantId: ra.tenantId,
    narration: `RA-${ra.raNumber} approved — contractor work billed`,
    lines: [
      { accountId: work.id, debit: ra.grossAmount },
      { accountId: retention.id, credit: ra.retentionAmount, note: 'Retention withheld' },
      { accountId: statutory.id, credit: deductionsTotal, note: ra.deductions.map(d => d.label).join(', ') || undefined },
      { accountId: ap.id, credit: ra.netPayable, note: 'Net payable to contractor' },
    ],
    sourceType: 'ra_bill', sourceId: ra.id, projectId: ra.projectId, actor,
  });
}

export function postCustomerPayment(opts: {
  tenantId: string; amount: number; narration: string; projectId?: string;
  sourceId?: string; reference?: string; actor: { id: string; name: string };
}): JournalEntry | null {
  const cash = accountByCode(opts.tenantId, COA.CASH);
  const sales = accountByCode(opts.tenantId, COA.SALES);
  if (!cash || !sales || !(opts.amount > 0)) return null;
  return postEntry({
    tenantId: opts.tenantId, narration: opts.narration,
    lines: [
      { accountId: cash.id, debit: opts.amount },
      { accountId: sales.id, credit: opts.amount },
    ],
    sourceType: 'customer_payment', sourceId: opts.sourceId,
    projectId: opts.projectId, reference: opts.reference, actor: opts.actor,
  });
}

// ── Statements (folds over POSTED entries only) ──────────────────────────────

export interface AccountBalance { account: Account; debit: number; credit: number; net: number }

/** Per-account totals. `net` is signed by natural balance: positive means the
 *  account carries its normal balance (Dr for asset/expense, Cr otherwise). */
export function accountBalances(tenantId: string): AccountBalance[] {
  const accounts = ensureCoa(tenantId);
  const totals = new Map<string, { debit: number; credit: number }>();
  getByTenant<JournalEntry>('journalEntries', tenantId)
    .filter(e => e.status === 'posted')
    .forEach(e => e.lines.forEach(l => {
      const t = totals.get(l.accountId) ?? { debit: 0, credit: 0 };
      t.debit += l.debit; t.credit += l.credit;
      totals.set(l.accountId, t);
    }));
  return accounts.map(account => {
    const t = totals.get(account.id) ?? { debit: 0, credit: 0 };
    const drNatural = account.type === 'asset' || account.type === 'expense';
    return { account, debit: t.debit, credit: t.credit, net: drNatural ? t.debit - t.credit : t.credit - t.debit };
  });
}

export function trialBalance(tenantId: string): { rows: AccountBalance[]; totalDebit: number; totalCredit: number } {
  const rows = accountBalances(tenantId).filter(r => r.debit !== 0 || r.credit !== 0);
  return {
    rows,
    totalDebit: rows.reduce((s, r) => s + r.debit, 0),
    totalCredit: rows.reduce((s, r) => s + r.credit, 0),
  };
}

export function profitAndLoss(tenantId: string): { income: AccountBalance[]; expense: AccountBalance[]; totalIncome: number; totalExpense: number; netProfit: number } {
  const balances = accountBalances(tenantId);
  const income = balances.filter(b => b.account.type === 'income' && b.net !== 0);
  const expense = balances.filter(b => b.account.type === 'expense' && b.net !== 0);
  const totalIncome = income.reduce((s, b) => s + b.net, 0);
  const totalExpense = expense.reduce((s, b) => s + b.net, 0);
  return { income, expense, totalIncome, totalExpense, netProfit: totalIncome - totalExpense };
}

export function balanceSheet(tenantId: string): {
  assets: AccountBalance[]; liabilities: AccountBalance[]; equity: AccountBalance[];
  totalAssets: number; totalLiabilities: number; totalEquity: number; retainedEarnings: number;
} {
  const balances = accountBalances(tenantId);
  const pick = (t: AccountType) => balances.filter(b => b.account.type === t && b.net !== 0);
  const assets = pick('asset');
  const liabilities = pick('liability');
  const equity = pick('equity');
  const { netProfit } = profitAndLoss(tenantId);
  return {
    assets, liabilities, equity,
    totalAssets: assets.reduce((s, b) => s + b.net, 0),
    totalLiabilities: liabilities.reduce((s, b) => s + b.net, 0),
    totalEquity: equity.reduce((s, b) => s + b.net, 0) + netProfit,
    retainedEarnings: netProfit,
  };
}

// ── RA numbering & contractor ledger ─────────────────────────────────────────

export function nextRaNumber(tenantId: string, vendorId: string, projectId: string): number {
  return getByTenant<RaBill>('raBills', tenantId)
    .filter(r => r.vendorId === vendorId && r.projectId === projectId)
    .reduce((max, r) => Math.max(max, r.raNumber), 0) + 1;
}

/** Contractor ledger rollup: gross billed, retained, deducted, paid, outstanding. */
export function contractorLedger(tenantId: string, vendorId: string): {
  gross: number; retained: number; deducted: number; paid: number; outstanding: number;
} {
  const bills = getByTenant<RaBill>('raBills', tenantId)
    .filter(r => r.vendorId === vendorId && r.status !== 'submitted' && r.status !== 'site_approved');
  const paid = getByTenant<PaymentMade>('paymentsMade', tenantId)
    .filter(p => p.vendorId === vendorId && p.raBillId)
    .reduce((s, p) => s + p.amount, 0);
  const gross = bills.reduce((s, r) => s + r.grossAmount, 0);
  const retained = bills.reduce((s, r) => s + r.retentionAmount, 0);
  const deducted = bills.reduce((s, r) => s + r.deductions.reduce((x, d) => x + d.amount, 0), 0);
  return { gross, retained, deducted, paid, outstanding: gross - retained - deducted - paid };
}
