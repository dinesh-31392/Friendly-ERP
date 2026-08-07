/**
 * Accounts-page write dispatcher — the same demo/API split every wired module
 * uses, but built on the read-cache that accountsService already established.
 *
 * The Accounts page folds trial balance, P&L, balance sheet, fund flow and
 * project P&L SYNCHRONOUSLY out of localStorage. Converting those folds to
 * async would touch every statement in the file, so instead each dispatcher
 * writes through to the server and then mirrors the server's own row (server
 * id included) back into the local cache. Every synchronous read below stays
 * correct, and the cache never invents an id the server has not seen.
 *
 * Demo mode is untouched: the API branch is skipped entirely and the local
 * write is the only write.
 */
import { create, update, removeByTenant } from './db';
import {
  isApiEnabled,
  apiGetVendors, apiGetRaBills, apiCreateRaBill, apiUpdateRaBill,
  apiGetApPayments, apiRecordApPayment,
  apiGetBankAccounts, apiCreateBankAccount,
  apiGetBankTransactions, apiCreateBankTransaction, apiReconcileBankTransaction,
  apiGetLoans, apiCreateLoan, apiGetLoanSchedule, apiCreateLoanSchedule, apiUpdateLoanRepayment,
  type ApiRaBill, type ApiApPayment, type ApiBankAccount, type ApiBankTxn,
  type ApiLoan, type ApiLoanRepayment, type ApiVendor,
} from './apiClient';
import type {
  RaBill, RaBillStatus, RaDeduction, PaymentMade, PaymentMode,
  BankAccount, BankTransaction, Loan, LoanInstallment, LoanType, Vendor,
} from '../types';

// ── status vocabulary ────────────────────────────────────────────────────────
// The SPA names the two approval stages after who performs them; the database
// (migration 004) names them after the role. Translate at the boundary so
// neither side has to learn the other's vocabulary.
function raStatusToApp(s: string): RaBillStatus {
  if (s === 'pmc_approved') return 'site_approved';
  if (s === 'finance_approved') return 'approved';
  if (s === 'paid') return 'paid';
  return 'submitted';
}
function raStatusToDb(s: RaBillStatus): string {
  if (s === 'site_approved') return 'pmc_approved';
  if (s === 'approved') return 'finance_approved';
  return s;
}

// ── mappers ──────────────────────────────────────────────────────────────────
export function mapRaBill(r: ApiRaBill, tenantId: string): RaBill {
  return {
    id: r.id, tenantId, vendorId: r.vendorId, projectId: r.projectId, raNumber: r.raNumber,
    progressPct: r.workProgressPercentage,
    siteProgressPct: r.siteProgressPercentage ?? null,
    overrideReason: r.overrideReason ?? undefined,
    grossAmount: r.grossAmount, retentionAmount: r.retentionAmount,
    deductions: (r.deductions ?? []) as RaDeduction[],
    netPayable: r.netPayable,
    status: raStatusToApp(r.status),
    signedOffBy: r.pmcApprovedBy ?? undefined,
    signedOffAt: r.signedOffAt ?? undefined,
    approvedBy: r.financeApprovedBy ?? undefined,
    approvedAt: r.financeApprovedAt ?? undefined,
    notes: r.notes ?? '',
    createdBy: r.createdBy ?? '',
    createdAt: r.createdAt ?? new Date().toISOString(),
  };
}

export function mapVendor(r: ApiVendor, tenantId: string): Vendor {
  return {
    id: r.id, tenantId, name: r.name,
    category: r.category ?? '', contactPerson: r.contactPerson ?? '', phone: r.phone ?? '',
    email: r.email ?? undefined, address: r.address ?? undefined,
    gstin: r.taxId ?? undefined,
    rating: r.rating ?? undefined,
    status: (r.status as Vendor['status']) ?? 'active',
    createdAt: new Date().toISOString(),
  } as Vendor;
}

export function mapPayment(r: ApiApPayment, tenantId: string, vendorId: string): PaymentMade {
  return {
    id: r.id, tenantId, vendorId,
    vendorBillId: r.vendorBillId ?? undefined,
    raBillId: r.raBillId ?? undefined,
    amount: r.amount, date: (r.date || '').slice(0, 10),
    mode: (r.mode as PaymentMode) || 'bank_transfer',
    reference: r.referenceNo ?? '',
    paidBy: '', createdAt: new Date().toISOString(),
  };
}

export function mapBankAccount(r: ApiBankAccount, tenantId: string): BankAccount {
  return {
    id: r.id, tenantId, name: r.accountName,
    bankName: r.bankName ?? '', accountNumber: r.accountNumber ?? '',
    openingBalance: r.openingBalance, createdAt: new Date().toISOString(),
  };
}

export function mapBankTxn(r: ApiBankTxn, tenantId: string): BankTransaction {
  return {
    id: r.id, tenantId, bankAccountId: r.bankAccountId,
    date: (r.date || '').slice(0, 10), description: r.description,
    amount: r.amount, type: r.type, reconciled: r.reconciled,
    matchedJournalEntryId: r.matchedJournalEntryId ?? undefined,
    createdAt: new Date().toISOString(),
  };
}

/** Rebuild the SPA's embedded schedule from the server's repayment rows. The
 *  server row id rides along as `serverId` so paying an EMI can PATCH it. */
function mapSchedule(rows: ApiLoanRepayment[]): LoanInstallment[] {
  return rows
    .slice()
    .sort((a, b) => a.installmentNo - b.installmentNo)
    .map(r => ({
      number: r.installmentNo,
      dueDate: (r.dueDate || '').slice(0, 10),
      principal: r.principalComponent,
      interest: r.interestComponent,
      tds: r.tdsDeducted,
      status: r.status === 'paid' ? ('paid' as const) : ('pending' as const),
      serverId: r.id,
    }));
}

export function mapLoan(r: ApiLoan, tenantId: string, schedule: LoanInstallment[]): Loan {
  return {
    id: r.id, tenantId,
    projectId: r.projectId ?? undefined,
    lenderName: r.lenderName,
    loanType: (r.loanType as LoanType) || 'term_loan',
    principal: r.principalAmount,
    interestRatePct: r.interestRate,
    tenureMonths: r.tenureMonths ?? schedule.length,
    tdsPct: r.tdsPct ?? 0,
    startDate: (r.startDate || '').slice(0, 10),
    schedule,
    status: r.status === 'closed' ? 'closed' : 'active',
    createdAt: new Date().toISOString(),
  };
}

// ── hydration ────────────────────────────────────────────────────────────────
/**
 * Mirror the server's AP / banking / loans slice into the local read-cache.
 * Complements accountsService.hydrateLedger (accounts + journal entries); call
 * both when the Accounts page mounts in API mode. Best-effort per dataset: one
 * failing endpoint must not blank the others, so each is caught individually
 * and simply leaves that table's existing cache in place.
 */
export async function hydrateAccounts(tenantId: string): Promise<void> {
  if (!isApiEnabled()) return;

  const replace = <T extends { id: string }>(table: Parameters<typeof removeByTenant>[0], rows: T[]) => {
    removeByTenant(table, tenantId);
    rows.forEach(r => { try { create(table, r); } catch { /* cache is best-effort */ } });
  };

  await Promise.all([
    apiGetVendors().then(v => replace('vendors', v.map(x => mapVendor(x, tenantId)))).catch(() => {}),
    apiGetRaBills().then(r => replace('raBills', r.map(x => mapRaBill(x, tenantId)))).catch(() => {}),
    apiGetBankAccounts().then(a => replace('bankAccounts', a.map(x => mapBankAccount(x, tenantId)))).catch(() => {}),
    apiGetBankTransactions().then(t => replace('bankTransactions', t.map(x => mapBankTxn(x, tenantId)))).catch(() => {}),
    // Payments carry no vendor id of their own — they inherit it from the bill
    // they settle, so this resolves through the RA bills fetched above.
    apiGetApPayments().then(async (p) => {
      const ras = await apiGetRaBills().catch(() => [] as ApiRaBill[]);
      const vendorOf = new Map(ras.map(r => [r.id, r.vendorId]));
      replace('paymentsMade', p.map(x => mapPayment(x, tenantId, (x.raBillId && vendorOf.get(x.raBillId)) || '')));
    }).catch(() => {}),
    apiGetLoans().then(async (loans) => {
      const withSchedules = await Promise.all(loans.map(async (l) => {
        const sched = await apiGetLoanSchedule(l.id).catch(() => [] as ApiLoanRepayment[]);
        return mapLoan(l, tenantId, mapSchedule(sched));
      }));
      replace('loans', withSchedules);
    }).catch(() => {}),
  ]);
}

// ── RA bills ─────────────────────────────────────────────────────────────────
export async function createRaBill(input: Omit<RaBill, 'id'>): Promise<RaBill> {
  if (!isApiEnabled()) return create<RaBill>('raBills', { ...input, id: '' } as RaBill);
  const created = await apiCreateRaBill({
    vendorId: input.vendorId, projectId: input.projectId,
    workProgressPercentage: input.progressPct,
    grossAmount: input.grossAmount, retentionAmount: input.retentionAmount,
    deductions: input.deductions,
    siteProgressPercentage: input.siteProgressPct,
    overrideReason: input.overrideReason,
    notes: input.notes,
  });
  return create<RaBill>('raBills', mapRaBill(created, input.tenantId));
}

export async function setRaStatus(ra: RaBill, status: RaBillStatus, actorId: string): Promise<void> {
  const stamp = status === 'site_approved'
    ? { signedOffBy: actorId, signedOffAt: new Date().toISOString() }
    : status === 'approved'
      ? { approvedBy: actorId, approvedAt: new Date().toISOString() }
      : {};
  if (!isApiEnabled()) { update<RaBill>('raBills', ra.id, { status, ...stamp }); return; }
  const updated = await apiUpdateRaBill(ra.id, raStatusToDb(status));
  update<RaBill>('raBills', ra.id, mapRaBill(updated, ra.tenantId));
}

// ── AP payments ──────────────────────────────────────────────────────────────
export async function recordRaPayment(input: Omit<PaymentMade, 'id'>): Promise<PaymentMade> {
  if (!isApiEnabled()) return create<PaymentMade>('paymentsMade', { ...input, id: '' } as PaymentMade);
  const created = await apiRecordApPayment({
    raBillId: input.raBillId, amount: input.amount,
    mode: input.mode, referenceNo: input.reference,
  });
  return create<PaymentMade>('paymentsMade', mapPayment(created, input.tenantId, input.vendorId));
}

// ── Banking ──────────────────────────────────────────────────────────────────
export async function createBankAccount(input: Omit<BankAccount, 'id'>): Promise<BankAccount> {
  if (!isApiEnabled()) return create<BankAccount>('bankAccounts', { ...input, id: '' } as BankAccount);
  const created = await apiCreateBankAccount({
    accountName: input.name, bankName: input.bankName, accountNumber: input.accountNumber,
    openingBalance: input.openingBalance,
  });
  return create<BankAccount>('bankAccounts', mapBankAccount(created, input.tenantId));
}

export async function createBankTxn(input: Omit<BankTransaction, 'id'>): Promise<BankTransaction> {
  if (!isApiEnabled()) return create<BankTransaction>('bankTransactions', { ...input, id: '' } as BankTransaction);
  const created = await apiCreateBankTransaction({
    bankAccountId: input.bankAccountId, txnDate: input.date,
    description: input.description, amount: input.amount, type: input.type,
  });
  return create<BankTransaction>('bankTransactions', mapBankTxn(created, input.tenantId));
}

export async function reconcileTxn(txn: BankTransaction, journalEntryId: string): Promise<void> {
  if (!isApiEnabled()) {
    update<BankTransaction>('bankTransactions', txn.id, { reconciled: true, matchedJournalEntryId: journalEntryId });
    return;
  }
  const updated = await apiReconcileBankTransaction(txn.id, true, journalEntryId);
  update<BankTransaction>('bankTransactions', txn.id, mapBankTxn(updated, txn.tenantId));
}

// ── Loans ────────────────────────────────────────────────────────────────────
export async function createLoan(input: Omit<Loan, 'id'>): Promise<Loan> {
  if (!isApiEnabled()) return create<Loan>('loans', { ...input, id: '' } as Loan);
  const created = await apiCreateLoan({
    lenderName: input.lenderName, projectId: input.projectId, loanType: input.loanType,
    principalAmount: input.principal, interestRate: input.interestRatePct,
    startDate: input.startDate, tenureMonths: input.tenureMonths, tdsPct: input.tdsPct,
  });
  // The amortisation is computed client-side (buildLoanSchedule) and pushed as
  // rows, so the server holds the same schedule the user is looking at.
  const rows = await apiCreateLoanSchedule(created.id, input.schedule.map(i => ({
    installmentNo: i.number, dueDate: i.dueDate,
    principalComponent: i.principal, interestComponent: i.interest, tdsDeducted: i.tds,
  })));
  return create<Loan>('loans', mapLoan(created, input.tenantId, mapSchedule(rows)));
}

export async function payLoanInstallment(loan: Loan, number: number): Promise<LoanInstallment[]> {
  const schedule = loan.schedule.map(i =>
    i.number === number ? { ...i, status: 'paid' as const, paidAt: new Date().toISOString() } : i);
  const allPaid = schedule.every(i => i.status === 'paid');
  if (isApiEnabled()) {
    const serverId = loan.schedule.find(i => i.number === number)?.serverId;
    if (serverId) await apiUpdateLoanRepayment(serverId, 'paid');
  }
  update<Loan>('loans', loan.id, { schedule, status: allPaid ? 'closed' : 'active' });
  return schedule;
}
