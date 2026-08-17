import { getByTenant, create, update, removeByTenant, logAudit } from './db';
import type {
  Account, AccountType, JournalEntry, JournalLine, JournalSource,
  VendorBill, RaBill, PaymentMade, Loan, LoanInstallment, PaymentPlan, Invoice,
} from '../types';
import { BUDGET_CATEGORIES } from '../types';
import { todayISO } from '../utils/format';
import { v4 as uuid } from 'uuid';
import {
  isApiEnabled, apiGetAccounts, apiCreateAccount, apiGetJournalEntries, apiPostJournalEntry,
} from './apiClient';

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
  LOANS: '2300',
  CUSTOMER_ADVANCES: '2400',   // buyer money received before possession (deferred revenue)
  GST_OUTPUT: '2500',          // output GST collected — a statutory liability
  EQUITY: '3000',
  SALES: '4000',
  OTHER_INCOME: '4100',
  CONTRACTOR_WORK: '5950',
  INTEREST: '5980',
} as const;

const SEED_ACCOUNTS: { code: string; name: string; type: AccountType }[] = [
  { code: COA.CASH, name: 'Cash & Bank', type: 'asset' },
  { code: COA.AP, name: 'Accounts Payable', type: 'liability' },
  { code: COA.RETENTION, name: 'Retention Payable', type: 'liability' },
  { code: COA.STATUTORY, name: 'Statutory Deductions Payable', type: 'liability' },
  { code: COA.CUSTOMER_ADVANCES, name: 'Customer Advances (deferred revenue)', type: 'liability' },
  { code: COA.GST_OUTPUT, name: 'GST Output Payable', type: 'liability' },
  { code: COA.LOANS, name: 'Loans Payable', type: 'liability' },
  { code: COA.EQUITY, name: "Owner's Equity", type: 'equity' },
  { code: COA.SALES, name: 'Sales — Unit Bookings', type: 'income' },
  { code: COA.OTHER_INCOME, name: 'Other Income', type: 'income' },
  // One expense head per budget category, so bills post to the same cost
  // heads that budgets track (5000, 5100, … in catalog order)
  ...BUDGET_CATEGORIES.map((name, i) => ({
    code: String(5000 + i * 100), name: `${name} Expense`, type: 'expense' as AccountType,
  })),
  { code: COA.CONTRACTOR_WORK, name: 'Contractor Work (RA)', type: 'expense' },
  { code: COA.INTEREST, name: 'Interest Expense', type: 'expense' },
];

/**
 * The chart of accounts. Synchronous on purpose — the statements read it during
 * render. In API mode the server owns the chart, so this only reads the local
 * cache that hydrateLedger() populated at login; it never seeds client-side
 * (that would mint local ids the server has never heard of). In demo mode it
 * seeds the standard chart on first use and fills in any account a later release
 * added.
 */
export function ensureCoa(tenantId: string): Account[] {
  const existing = getByTenant<Account>('accounts', tenantId);
  if (isApiEnabled()) return existing.slice().sort((a, b) => a.code.localeCompare(b.code));
  const byCode = new Set(existing.map(a => a.code));
  const missing = SEED_ACCOUNTS.filter(s => !byCode.has(s.code));
  const created = missing.map(s => create<Account>('accounts', {
    id: '', tenantId, code: s.code, name: s.name, type: s.type,
    isSystem: true, active: true, createdAt: new Date().toISOString(),
  }));
  return [...existing, ...created].sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Load the server ledger into the local read-cache (API mode only). Ensures the
 * standard chart exists server-side (seeding any missing system account), then
 * mirrors accounts + posted journal entries into localStorage so the synchronous
 * statement folds read fresh, server-authoritative data. Call it once after an
 * API login; postEntry keeps the cache current after that. No-op in demo mode.
 */
export async function hydrateLedger(tenantId: string): Promise<void> {
  if (!isApiEnabled()) return;
  let accounts = await apiGetAccounts();
  const haveCodes = new Set(accounts.map(a => a.code));
  const missing = SEED_ACCOUNTS.filter(s => !haveCodes.has(s.code));
  // Sequential (not Promise.all) to stay well clear of the API rate limit.
  for (const s of missing) {
    await apiCreateAccount({ code: s.code, name: s.name, type: s.type, isSystem: true });
  }
  if (missing.length) accounts = await apiGetAccounts();
  const entries = await apiGetJournalEntries();
  // Replace this tenant's slice of the cache with the server truth.
  removeByTenant('accounts', tenantId);
  accounts.forEach(a => { try { create<Account>('accounts', a); } catch { /* cache best-effort */ } });
  removeByTenant('journalEntries', tenantId);
  entries.forEach(e => { try { create<JournalEntry>('journalEntries', e); } catch { /* cache best-effort */ } });
}

/** Mirror a freshly-posted server entry into the local read-cache so the
 *  synchronous statements pick it up before the next hydrate. Best-effort. */
function cacheEntry(entry: JournalEntry): void {
  try { create<JournalEntry>('journalEntries', entry); } catch { /* cache full — next hydrate reconciles */ }
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
export async function postEntry(opts: {
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
}): Promise<JournalEntry> {
  const lines: JournalLine[] = opts.lines
    .filter(l => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0)
    .map(l => ({ id: uuid(), accountId: l.accountId, debit: l.debit ?? 0, credit: l.credit ?? 0, note: l.note }));
  // Client-side balance check — fail fast before a round-trip. The server
  // re-validates the same invariant (defence in depth) before it commits.
  if (lines.length < 2) throw new Error('A journal entry needs at least two lines');
  const dr = lines.reduce((s, l) => s + l.debit, 0);
  const cr = lines.reduce((s, l) => s + l.credit, 0);
  if (Math.round(dr * 100) !== Math.round(cr * 100)) {
    throw new Error(`Entry does not balance: debits ${dr} ≠ credits ${cr}`);
  }
  const status = opts.status ?? 'posted';

  let entry: JournalEntry;
  if (isApiEnabled()) {
    // API mode always posts (drafts aren't part of the server flow). The server
    // is the source of truth; mirror the result into the read-cache.
    entry = await apiPostJournalEntry({
      date: opts.date, narration: opts.narration, reference: opts.reference,
      sourceType: opts.sourceType, sourceId: opts.sourceId, projectId: opts.projectId,
      status: 'posted', lines,
    });
    cacheEntry(entry);
  } else {
    entry = create<JournalEntry>('journalEntries', {
      id: '', tenantId: opts.tenantId,
      date: opts.date ?? todayISO(),
      narration: opts.narration, reference: opts.reference,
      sourceType: opts.sourceType, sourceId: opts.sourceId, projectId: opts.projectId,
      status, lines,
      createdBy: opts.actor.id,
      postedBy: status === 'posted' ? opts.actor.id : undefined,
      postedAt: status === 'posted' ? new Date().toISOString() : undefined,
      createdAt: new Date().toISOString(),
    });
  }
  logAudit({
    tenantId: opts.tenantId, userId: opts.actor.id, userName: opts.actor.name,
    action: 'create', entity: 'journal_entry', entityId: entry.id,
    details: `${entry.status === 'posted' ? 'Posted' : 'Drafted'} JE (${opts.sourceType}): ${opts.narration.slice(0, 60)}`,
  });
  return entry;
}

/** Post a saved draft. Demo-only: in API mode entries are always created posted,
 *  so there are no server drafts to flip. */
export function postDraft(entry: JournalEntry, actor: { id: string; name: string }): void {
  if (isApiEnabled()) return;
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

export async function postVendorBillApproved(bill: VendorBill, actor: { id: string; name: string }): Promise<JournalEntry | null> {
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

export async function postApPayment(payment: PaymentMade, narration: string, projectId: string | undefined, actor: { id: string; name: string }): Promise<JournalEntry | null> {
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

export async function postRaApproved(ra: RaBill, actor: { id: string; name: string }): Promise<JournalEntry | null> {
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

/**
 * Collect a buyer receipt. Real-estate GAAP: money received before possession
 * is NOT revenue — it is a customer advance (deferred), and the GST portion is a
 * statutory output-tax liability. So a collection posts:
 *   Dr Cash/Bank           (total received)
 *     Cr GST Output Payable (gstAmount — the tax slice of this receipt)
 *     Cr Customer Advances  (the rest — deferred until possession)
 * Revenue (Cr Sales) is recognized later, at possession, via
 * postPossessionRevenue. Passing gstAmount 0 (or omitting it) books the whole
 * receipt to Customer Advances.
 */
export async function postCustomerPayment(opts: {
  tenantId: string; amount: number; narration: string; projectId?: string;
  gstAmount?: number; sourceId?: string; reference?: string; actor: { id: string; name: string };
}): Promise<JournalEntry | null> {
  const cash = accountByCode(opts.tenantId, COA.CASH);
  const advances = accountByCode(opts.tenantId, COA.CUSTOMER_ADVANCES);
  const gstOut = accountByCode(opts.tenantId, COA.GST_OUTPUT);
  if (!cash || !advances || !gstOut || !(opts.amount > 0)) return null;
  const gst = Math.max(0, Math.min(opts.gstAmount ?? 0, opts.amount));
  const advance = opts.amount - gst;
  const lines = [
    { accountId: cash.id, debit: opts.amount },
    ...(advance > 0 ? [{ accountId: advances.id, credit: advance }] : []),
    ...(gst > 0 ? [{ accountId: gstOut.id, credit: gst }] : []),
  ];
  return postEntry({
    tenantId: opts.tenantId, narration: opts.narration,
    lines,
    sourceType: 'customer_payment', sourceId: opts.sourceId,
    projectId: opts.projectId, reference: opts.reference, actor: opts.actor,
  });
}

/**
 * Recognize revenue at possession/handover: move the accumulated customer
 * advance (net of GST already parked as a liability) into Sales.
 *   Dr Customer Advances (net-of-GST consideration)
 *     Cr Sales — Unit Bookings
 */
export async function postPossessionRevenue(opts: {
  tenantId: string; netRevenue: number; narration: string; projectId?: string;
  sourceId?: string; actor: { id: string; name: string };
}): Promise<JournalEntry | null> {
  const advances = accountByCode(opts.tenantId, COA.CUSTOMER_ADVANCES);
  const sales = accountByCode(opts.tenantId, COA.SALES);
  if (!advances || !sales || !(opts.netRevenue > 0)) return null;
  return postEntry({
    tenantId: opts.tenantId, narration: opts.narration,
    lines: [
      { accountId: advances.id, debit: opts.netRevenue },
      { accountId: sales.id, credit: opts.netRevenue },
    ],
    sourceType: 'revenue_recognition', sourceId: opts.sourceId,
    projectId: opts.projectId, actor: opts.actor,
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

// ── Loans (annuity EMI, TDS on interest) ─────────────────────────────────────

/**
 * Standard annuity schedule: EMI = P·r·(1+r)ⁿ / ((1+r)ⁿ − 1) at monthly rate
 * r. Interest accrues on the reducing balance; the final installment absorbs
 * rounding so principals sum exactly to P. TDS (when set) is withheld from
 * each interest payment.
 */
export function buildLoanSchedule(
  principal: number, annualRatePct: number, tenureMonths: number, tdsPct: number, startDate: string,
): LoanInstallment[] {
  const r = annualRatePct / 1200;
  const n = Math.max(1, Math.round(tenureMonths));
  const emi = r > 0
    ? principal * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1)
    : principal / n;
  const start = new Date(startDate);
  const schedule: LoanInstallment[] = [];
  let balance = principal;
  for (let k = 1; k <= n; k++) {
    const interest = Math.round(balance * r);
    const principalPart = k === n ? balance : Math.min(balance, Math.round(emi - interest));
    balance -= principalPart;
    const due = new Date(start);
    due.setMonth(due.getMonth() + k);
    schedule.push({
      number: k,
      dueDate: due.toISOString().slice(0, 10),
      principal: principalPart,
      interest,
      tds: Math.round(interest * (tdsPct || 0) / 100),
      status: 'pending',
    });
  }
  return schedule;
}

/** Receiving the money: Dr Cash / Cr Loans Payable. */
export async function postLoanDisbursed(loan: Loan, actor: { id: string; name: string }): Promise<JournalEntry | null> {
  const cash = accountByCode(loan.tenantId, COA.CASH);
  const loans = accountByCode(loan.tenantId, COA.LOANS);
  if (!cash || !loans) return null;
  return postEntry({
    tenantId: loan.tenantId,
    narration: `Loan disbursed — ${loan.lenderName} (${loan.loanType.replace('_', ' ')})`,
    lines: [
      { accountId: cash.id, debit: loan.principal },
      { accountId: loans.id, credit: loan.principal },
    ],
    sourceType: 'manual', sourceId: loan.id, projectId: loan.projectId, actor,
  });
}

/** One EMI: Dr Loans Payable (principal) + Dr Interest Expense (interest) /
 *  Cr Statutory (TDS withheld) + Cr Cash (net outflow). */
export async function postLoanRepayment(loan: Loan, inst: LoanInstallment, actor: { id: string; name: string }): Promise<JournalEntry | null> {
  const cash = accountByCode(loan.tenantId, COA.CASH);
  const loans = accountByCode(loan.tenantId, COA.LOANS);
  const interest = accountByCode(loan.tenantId, COA.INTEREST);
  const statutory = accountByCode(loan.tenantId, COA.STATUTORY);
  if (!cash || !loans || !interest || !statutory) return null;
  return postEntry({
    tenantId: loan.tenantId,
    narration: `Loan EMI #${inst.number} — ${loan.lenderName}`,
    lines: [
      { accountId: loans.id, debit: inst.principal },
      { accountId: interest.id, debit: inst.interest },
      { accountId: statutory.id, credit: inst.tds, note: inst.tds > 0 ? 'TDS on interest' : undefined },
      { accountId: cash.id, credit: inst.principal + inst.interest - inst.tds },
    ],
    sourceType: 'manual', sourceId: loan.id, projectId: loan.projectId, actor,
  });
}

export function loansDueSoon(tenantId: string, days = 7): { loan: Loan; inst: LoanInstallment }[] {
  const horizon = Date.now() + days * 86400000;
  const out: { loan: Loan; inst: LoanInstallment }[] = [];
  getByTenant<Loan>('loans', tenantId).filter(l => l.status === 'active').forEach(loan => {
    const next = loan.schedule.find(i => i.status === 'pending');
    if (next && new Date(next.dueDate).getTime() <= horizon) out.push({ loan, inst: next });
  });
  return out;
}

// ── Tax remittance ───────────────────────────────────────────────────────────

/** Paying a filed statutory amount: Dr Statutory Payable / Cr Cash. */
export async function postTaxRemitted(opts: {
  tenantId: string; amount: number; narration: string; sourceId?: string;
  actor: { id: string; name: string };
}): Promise<JournalEntry | null> {
  const statutory = accountByCode(opts.tenantId, COA.STATUTORY);
  const cash = accountByCode(opts.tenantId, COA.CASH);
  if (!statutory || !cash || !(opts.amount > 0)) return null;
  return postEntry({
    tenantId: opts.tenantId, narration: opts.narration,
    lines: [
      { accountId: statutory.id, debit: opts.amount },
      { accountId: cash.id, credit: opts.amount },
    ],
    sourceType: 'manual', sourceId: opts.sourceId, actor: opts.actor,
  });
}

/** Current accrued statutory liability (RA deductions, loan TDS, …). */
export function statutoryLiability(tenantId: string): number {
  return accountBalances(tenantId).find(b => b.account.code === COA.STATUTORY)?.net ?? 0;
}

export function cashBalance(tenantId: string): number {
  return accountBalances(tenantId).find(b => b.account.code === COA.CASH)?.net ?? 0;
}

// ── Fund flow & cost-center (project) P&L ────────────────────────────────────

export interface FundFlowLine { label: string; amount: number; due: string }

/** Projected cash for the next `days`: booked receivables coming due vs
 *  approved payables and EMIs falling due. Derived, never stored. */
export function fundFlow(tenantId: string, days = 30): {
  cash: number;
  inflows: FundFlowLine[]; outflows: FundFlowLine[];
  totalIn: number; totalOut: number; projected: number;
} {
  const horizon = Date.now() + days * 86400000;
  const inWindow = (d: string) => new Date(d).getTime() <= horizon;
  const inflows: FundFlowLine[] = [];
  const outflows: FundFlowLine[] = [];

  getByTenant<PaymentPlan>('paymentPlans', tenantId).forEach(plan =>
    plan.installments
      .filter(i => i.status !== 'paid' && inWindow(i.dueDate))
      .forEach(i => inflows.push({ label: `Installment — ${i.description}`, amount: i.amount, due: i.dueDate }))
  );
  getByTenant<Invoice>('invoices', tenantId)
    // 'Booking Token' invoices are already represented in the booking's payment
    // schedule (counted above), so excluding them here avoids projecting the same
    // money twice in the cash-flow forecast.
    .filter(i => (i.status === 'Pending' || i.status === 'Overdue' || i.status === 'Generated') && i.type !== 'Booking Token' && inWindow(i.dueDate))
    .forEach(i => inflows.push({ label: `Invoice — ${i.leadName} (${i.type})`, amount: i.amount, due: i.dueDate }));

  getByTenant<VendorBill>('vendorBills', tenantId)
    .filter(b => b.status === 'approved')
    .forEach(b => outflows.push({ label: `Vendor bill ${b.billNumber || b.id.slice(0, 6)}`, amount: b.amount, due: b.dueDate }));
  getByTenant<RaBill>('raBills', tenantId)
    .filter(r => r.status === 'approved')
    .forEach(r => outflows.push({ label: `RA-${r.raNumber} net payable`, amount: r.netPayable, due: r.createdAt.slice(0, 10) }));
  getByTenant<Loan>('loans', tenantId).filter(l => l.status === 'active').forEach(loan =>
    loan.schedule
      .filter(i => i.status === 'pending' && inWindow(i.dueDate))
      .forEach(i => outflows.push({ label: `EMI #${i.number} — ${loan.lenderName}`, amount: i.principal + i.interest - i.tds, due: i.dueDate }))
  );

  inflows.sort((a, b) => a.due.localeCompare(b.due));
  outflows.sort((a, b) => a.due.localeCompare(b.due));
  const cash = cashBalance(tenantId);
  const totalIn = inflows.reduce((s, l) => s + l.amount, 0);
  const totalOut = outflows.reduce((s, l) => s + l.amount, 0);
  return { cash, inflows, outflows, totalIn, totalOut, projected: cash + totalIn - totalOut };
}

/** Cost-center P&L: income/expense per project from posted entries (the
 *  entry's projectId is the cost-center dimension). */
export function projectPnl(tenantId: string): { projectId: string | null; income: number; expense: number; net: number }[] {
  const accounts = new Map(getByTenant<Account>('accounts', tenantId).map(a => [a.id, a]));
  const rows = new Map<string | null, { income: number; expense: number }>();
  getByTenant<JournalEntry>('journalEntries', tenantId)
    .filter(e => e.status === 'posted')
    .forEach(e => {
      const key = e.projectId ?? null;
      const row = rows.get(key) ?? { income: 0, expense: 0 };
      e.lines.forEach(l => {
        const acc = accounts.get(l.accountId);
        if (!acc) return;
        if (acc.type === 'income') row.income += l.credit - l.debit;
        if (acc.type === 'expense') row.expense += l.debit - l.credit;
      });
      rows.set(key, row);
    });
  return [...rows.entries()]
    .map(([projectId, r]) => ({ projectId, income: r.income, expense: r.expense, net: r.income - r.expense }))
    .filter(r => r.income !== 0 || r.expense !== 0)
    .sort((a, b) => b.net - a.net);
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
