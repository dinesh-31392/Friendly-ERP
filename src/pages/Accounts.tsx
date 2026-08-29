import { useState, useMemo, useEffect } from 'react';
import {
  Landmark, BookOpen, Scale, HardHat, Plus, X, Trash2, CheckCircle2,
  ArrowDownToLine, FileText, Banknote,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, update, logAudit } from '../services/db';
import { isApiEnabled } from '../services/apiClient';
import TallyExportPanel from '../components/TallyExportPanel';
import {
  ensureCoa, postEntry, postDraft, postRaApproved, postApPayment,
  trialBalance, profitAndLoss, balanceSheet, nextRaNumber, contractorLedger,
  buildLoanSchedule, postLoanDisbursed, postLoanRepayment,
  fundFlow, projectPnl, cashBalance, COA, hydrateLedger,
} from '../services/accountsService';
import * as accountsWrites from '../services/accountsWrites';
import { projectProgress } from '../services/executionService';
import { formatCurrency, formatCurrencyFull, todayISO } from '../utils/format';
import { downloadCsv } from '../utils/csv';
import type {
  Account, AccountType, JournalEntry, Project, Vendor, RaBill, RaDeduction,
  PaymentMade, PaymentMode, BankAccount, BankTransaction, Loan, LoanInstallment, LoanType,
} from '../types';
import { ACCOUNT_TYPES, PAYMENT_MODES, LOAN_TYPES } from '../types';
import { v4 as uuid } from 'uuid';
import toast from 'react-hot-toast';

type Tab = 'ledger' | 'journal' | 'statements' | 'ra' | 'banking' | 'loans';

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'ledger', label: 'Chart of Accounts', icon: BookOpen },
  { id: 'journal', label: 'Journal', icon: FileText },
  { id: 'statements', label: 'Statements', icon: Scale },
  { id: 'ra', label: 'RA Bills', icon: HardHat },
  { id: 'banking', label: 'Banking', icon: Landmark },
  { id: 'loans', label: 'Loans', icon: Banknote },
];

/** Minimal RFC-4180-ish line parser (quoted cells, doubled quotes). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

const SOURCE_LABELS: Record<JournalEntry['sourceType'], string> = {
  manual: 'Manual', vendor_bill: 'Vendor Bill', ra_bill: 'RA Bill',
  customer_payment: 'Collection', ap_payment: 'Payment', revenue_recognition: 'Revenue (Possession)',
};

interface DraftLine { key: string; accountId: string; debit: string; credit: string }
const emptyLine = (): DraftLine => ({ key: uuid(), accountId: '', debit: '', credit: '' });

export default function Accounts() {
  const { user, tenant, hasPermission } = useAuth();
  const tenantId = tenant?.id || '';
  const currency = tenant?.currency || 'INR';
  const canManage = hasPermission('manage_accounts');
  const canSignOff = hasPermission('signoff_ra_bills');
  const canApprove = hasPermission('approve_vendor_bills');
  const canPay = hasPermission('manage_finance');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  // API mode: pull the server ledger AND the AP/banking/loans slice into the
  // read-cache on mount, then refresh so the statements render server-
  // authoritative data even on a direct reload onto this page (before
  // AuthContext's hydrate finishes). No-op in demo mode.
  useEffect(() => {
    if (!isApiEnabled() || !tenantId) return;
    let cancelled = false;
    Promise.all([hydrateLedger(tenantId), accountsWrites.hydrateAccounts(tenantId)])
      .then(() => { if (!cancelled) refresh(); })
      .catch(() => toast.error('Could not reach the server — showing locally cached data'));
    return () => { cancelled = true; };
  }, [tenantId]);

  const [tab, setTab] = useState<Tab>('ledger');
  const [statement, setStatement] = useState<'tb' | 'pl' | 'bs' | 'ff' | 'pp'>('tb');
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showAddJe, setShowAddJe] = useState(false);
  const [showAddRa, setShowAddRa] = useState(false);
  const [payingRa, setPayingRa] = useState<RaBill | null>(null);
  const [journalFilter, setJournalFilter] = useState('all');
  const [jeLines, setJeLines] = useState<DraftLine[]>([emptyLine(), emptyLine()]);
  const [showAddBank, setShowAddBank] = useState(false);
  const [showAddTxn, setShowAddTxn] = useState(false);
  const [bankId, setBankId] = useState('');
  const [matchingTxn, setMatchingTxn] = useState<BankTransaction | null>(null);
  const [showAddLoan, setShowAddLoan] = useState(false);
  const [openLoanId, setOpenLoanId] = useState<string | null>(null);

  const accounts = useMemo(() => ensureCoa(tenantId), [tenantId, refreshKey]);
  const entries = useMemo(
    () => getByTenant<JournalEntry>('journalEntries', tenantId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [tenantId, refreshKey]
  );
  const raBills = useMemo(
    () => getByTenant<RaBill>('raBills', tenantId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [tenantId, refreshKey]
  );
  const vendors = useMemo(() => getByTenant<Vendor>('vendors', tenantId), [tenantId, refreshKey]);
  const projects = useMemo(() => getByTenant<Project>('projects', tenantId), [tenantId, refreshKey]);

  const tb = useMemo(() => trialBalance(tenantId), [tenantId, refreshKey]);
  const pl = useMemo(() => profitAndLoss(tenantId), [tenantId, refreshKey]);
  const bs = useMemo(() => balanceSheet(tenantId), [tenantId, refreshKey]);
  const ff = useMemo(() => fundFlow(tenantId), [tenantId, refreshKey]);
  const pp = useMemo(() => projectPnl(tenantId), [tenantId, refreshKey]);

  const bankAccounts = useMemo(
    () => getByTenant<BankAccount>('bankAccounts', tenantId).sort((a, b) => a.name.localeCompare(b.name)),
    [tenantId, refreshKey]
  );
  const activeBank = bankAccounts.find(b => b.id === bankId) || bankAccounts[0];
  const bankTxns = useMemo(
    () => activeBank
      ? getByTenant<BankTransaction>('bankTransactions', tenantId)
          .filter(t => t.bankAccountId === activeBank.id)
          .sort((a, b) => b.date.localeCompare(a.date))
      : [],
    [tenantId, refreshKey, activeBank?.id]
  );
  const loans = useMemo(
    () => getByTenant<Loan>('loans', tenantId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [tenantId, refreshKey]
  );

  const accountName = (id: string) => accounts.find(a => a.id === id);
  const vendorName = (id: string) => vendors.find(v => v.id === id)?.name || '—';
  const projectName = (id?: string) => projects.find(p => p.id === id)?.name || '—';
  const actor = user ? { id: user.id, name: user.name } : { id: '', name: 'System' };
  const audit = (action: string, entity: string, entityId: string, details: string) => {
    if (user) logAudit({ tenantId, userId: user.id, userName: user.name, action, entity, entityId, details });
  };

  const inputCls = 'w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20';
  const labelCls = 'block text-xs font-semibold text-zinc-500 uppercase mb-1';
  const fmtDate = (d?: string) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

  // ── Chart of accounts ──────────────────────────────────────────────────────
  const handleAddAccount = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const code = (fd.get('code') as string)?.trim();
    const name = (fd.get('name') as string)?.trim();
    if (!code || !name) { toast.error('Code and name are required'); return; }
    if (accounts.some(a => a.code === code)) { toast.error(`Account code ${code} already exists`); return; }
    try {
      // Goes through the dispatcher, not straight to the local store. Written
      // locally, the account was invisible to every other user and to the
      // server's own reports — and hydrateLedger replaces the cached chart from
      // the server at each sign-in, so it vanished by the next login.
      const created = await accountsWrites.createAccount({
        tenantId, code, name,
        type: (fd.get('type') as AccountType) || 'expense',
        isSystem: false, active: true, createdAt: new Date().toISOString(),
      });
      audit('create', 'account', created.id, `Added ledger account ${code} — ${name}`);
      setShowAddAccount(false);
      refresh();
      toast.success('Account added');
    } catch (err) {
      // The duplicate-code check above is a courtesy; the database holds the
      // real UNIQUE constraint and its 409 must reach the user rather than
      // leaving a form that appears to have done nothing.
      toast.error(err instanceof Error ? err.message : 'Could not add the account');
    }
  };

  const toggleAccount = async (a: Account) => {
    if (a.isSystem) { toast.error('System accounts back automatic postings and stay active'); return; }
    try {
      await accountsWrites.setAccountActive(a, !a.active);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the account');
    }
  };

  // ── Manual journal entry ───────────────────────────────────────────────────
  const jeTotals = jeLines.reduce(
    (acc, l) => ({ dr: acc.dr + (Number(l.debit) || 0), cr: acc.cr + (Number(l.credit) || 0) }),
    { dr: 0, cr: 0 }
  );
  const jeBalanced = jeTotals.dr > 0 && Math.round(jeTotals.dr * 100) === Math.round(jeTotals.cr * 100);

  const handleAddJe = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const narration = (fd.get('narration') as string)?.trim();
    if (!narration) { toast.error('Write a narration'); return; }
    try {
      await postEntry({
        tenantId, narration,
        reference: (fd.get('reference') as string) || undefined,
        projectId: (fd.get('projectId') as string) || undefined,
        date: (fd.get('date') as string) || undefined,
        lines: jeLines.map(l => ({ accountId: l.accountId, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 }))
          .filter(l => l.accountId),
        sourceType: 'manual',
        status: (fd.get('status') as 'draft' | 'posted') || 'posted',
        actor,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not post the entry');
      return;
    }
    setShowAddJe(false);
    setJeLines([emptyLine(), emptyLine()]);
    refresh();
    toast.success('Journal entry saved');
  };

  // ── RA billing ─────────────────────────────────────────────────────────────
  const [raDeductions, setRaDeductions] = useState<RaDeduction[]>([]);
  const [raVendorId, setRaVendorId] = useState('');
  const [raProjectId, setRaProjectId] = useState('');
  const [raGross, setRaGross] = useState('');
  const [raRetentionPct, setRaRetentionPct] = useState('5');
  const [raProgress, setRaProgress] = useState('');

  const raSiteProgress = raProjectId ? projectProgress(tenantId, raProjectId) : null;
  const raProgressNum = Number(raProgress) || 0;
  const raNeedsOverride = raSiteProgress !== null && raProgressNum > raSiteProgress;
  const raGrossNum = Number(raGross) || 0;
  const raRetention = Math.round(raGrossNum * (Number(raRetentionPct) || 0) / 100);
  // Only labelled deductions are stored and posted to the ledger, so the net
  // payable must be computed from the SAME set. A blank-label amount previously
  // reduced the net without a matching ledger credit, so the approval entry
  // failed to balance — and status was already flipped to 'approved' by then.
  const raValidDeductions = raDeductions.filter(d => d.label.trim() && d.amount > 0);
  const raDeductionsTotal = raValidDeductions.reduce((s, d) => s + d.amount, 0);
  const raNet = raGrossNum - raRetention - raDeductionsTotal;
  const raLedgerFor = raVendorId ? contractorLedger(tenantId, raVendorId) : null;

  const openAddRa = () => {
    if (vendors.length === 0) { toast.error('Add the contractor in Procurement → Vendors first'); return; }
    if (projects.length === 0) { toast.error('Create a project first'); return; }
    setRaVendorId(''); setRaProjectId(''); setRaGross(''); setRaProgress('');
    setRaRetentionPct('5'); setRaDeductions([]);
    setShowAddRa(true);
  };

  const handleAddRa = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (!raVendorId || !raProjectId) { toast.error('Pick the contractor and the project'); return; }
    if (!(raGrossNum > 0)) { toast.error('Gross amount is required'); return; }
    if (!(raProgressNum > 0) || raProgressNum > 100) { toast.error('Work progress must be between 1 and 100%'); return; }
    if (raNet < 0) { toast.error('Deductions and retention exceed the gross amount'); return; }
    if (raDeductions.some(d => d.amount > 0 && !d.label.trim())) {
      toast.error('Every deduction needs a label — an unlabelled amount would unbalance the ledger.');
      return;
    }
    const overrideReason = (fd.get('overrideReason') as string)?.trim();
    if (raNeedsOverride && !overrideReason) {
      toast.error(`Claimed ${raProgressNum}% exceeds the site's logged ${raSiteProgress}% — an override reason is required`);
      return;
    }
    let created: RaBill;
    try {
      created = await accountsWrites.createRaBill({
        tenantId, vendorId: raVendorId, projectId: raProjectId,
        // Server-assigned in API mode; this is the demo-mode sequence.
        raNumber: nextRaNumber(tenantId, raVendorId, raProjectId),
        progressPct: raProgressNum,
        siteProgressPct: raSiteProgress,
        overrideReason: raNeedsOverride ? overrideReason : undefined,
        grossAmount: raGrossNum,
        retentionAmount: raRetention,
        deductions: raValidDeductions,
        netPayable: raNet,
        status: 'submitted',
        notes: (fd.get('notes') as string) || '',
        createdBy: actor.id,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not submit the RA bill');
      return;
    }
    audit('create', 'ra_bill', created.id, `RA-${created.raNumber} submitted for ${vendorName(raVendorId)} on ${projectName(raProjectId)} — ${formatCurrency(raGrossNum, currency)} gross`);
    setShowAddRa(false);
    refresh();
    toast.success(`RA-${created.raNumber} submitted — awaiting site sign-off`);
  };

  const signOffRa = async (ra: RaBill) => {
    try {
      await accountsWrites.setRaStatus(ra, 'site_approved', actor.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not record the sign-off');
      return;
    }
    audit('update', 'ra_bill', ra.id, `Site sign-off on RA-${ra.raNumber} (${vendorName(ra.vendorId)})`);
    refresh();
    toast.success('Progress verified — over to finance');
  };

  const approveRa = async (ra: RaBill) => {
    // Post to the ledger FIRST — postEntry validates the balance (and the server
    // re-validates + commits) before anything persists, so a throw here leaves
    // no journal entry AND no status change. Only flip the RA to 'approved' once
    // the posting succeeded.
    try {
      await postRaApproved({ ...ra, status: 'approved' }, actor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not post the ledger entry — RA not approved');
      return;
    }
    try {
      await accountsWrites.setRaStatus(ra, 'approved', actor.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ledger entry posted, but the RA status did not save');
      return;
    }
    audit('update', 'ra_bill', ra.id, `Finance approved RA-${ra.raNumber} — ${formatCurrency(ra.netPayable, currency)} payable`);
    refresh();
    toast.success('RA bill approved and posted to the ledger');
  };

  const handlePayRa = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!payingRa) return;
    const fd = new FormData(e.currentTarget);
    let payment: PaymentMade;
    try {
      payment = await accountsWrites.recordRaPayment({
        tenantId, vendorId: payingRa.vendorId, raBillId: payingRa.id,
        amount: payingRa.netPayable,
        date: (fd.get('date') as string) || todayISO(),
        mode: (fd.get('mode') as PaymentMode) || 'bank_transfer',
        reference: (fd.get('reference') as string) || '',
        paidBy: actor.id, createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not record the payment');
      return;
    }
    // In API mode the payment route already flipped the RA to paid server-side,
    // so only the read-cache needs catching up — a second PATCH would be a
    // redundant round trip.
    if (isApiEnabled()) update<RaBill>('raBills', payingRa.id, { status: 'paid' });
    else await accountsWrites.setRaStatus(payingRa, 'paid', actor.id);
    try {
      await postApPayment(payment, `Paid RA-${payingRa.raNumber} to ${vendorName(payingRa.vendorId)}`, payingRa.projectId, actor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Payment recorded, but posting to the ledger failed');
    }
    audit('payment', 'ra_bill', payingRa.id, `Paid RA-${payingRa.raNumber} — ${formatCurrency(payingRa.netPayable, currency)} (${payment.mode})`);
    setPayingRa(null);
    refresh();
    toast.success('Payment recorded and posted');
  };

  // ── Banking & reconciliation ───────────────────────────────────────────────
  const handleAddBank = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = (fd.get('name') as string)?.trim();
    if (!name) { toast.error('Account name is required'); return; }
    let created: BankAccount;
    try {
      created = await accountsWrites.createBankAccount({
        tenantId, name,
        bankName: (fd.get('bankName') as string) || '',
        accountNumber: (fd.get('accountNumber') as string) || '',
        openingBalance: Number(fd.get('openingBalance')) || 0,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add the bank account');
      return;
    }
    audit('create', 'bank_account', created.id, `Added bank account "${name}"`);
    setBankId(created.id);
    setShowAddBank(false);
    refresh();
    toast.success('Bank account added');
  };

  const handleAddTxn = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!activeBank) return;
    const fd = new FormData(e.currentTarget);
    const amount = Number(fd.get('amount'));
    if (!(amount > 0)) { toast.error('Amount is required'); return; }
    try {
      await accountsWrites.createBankTxn({
        tenantId, bankAccountId: activeBank.id,
        date: (fd.get('date') as string) || todayISO(),
        description: (fd.get('description') as string) || 'Manual entry',
        amount,
        type: (fd.get('type') as 'debit' | 'credit') || 'debit',
        reconciled: false,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add the statement line');
      return;
    }
    setShowAddTxn(false);
    refresh();
    toast.success('Statement line added');
  };

  const importStatement = (file: File) => {
    if (!activeBank) return;
    file.text().then(text => {
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) { toast.error('CSV needs a header row and at least one line'); return; }
      const header = parseCsvLine(lines[0]).map(h => h.toLowerCase());
      const col = (n: string) => header.indexOf(n);
      if (col('date') < 0 || col('amount') < 0 || col('type') < 0) {
        toast.error('CSV must have date, description, amount, type columns — download the template');
        return;
      }
      let imported = 0, skipped = 0, failed = 0;
      // Sequential, not Promise.all: an import is dozens of rows and the API
      // rate-limits bursts. A row that fails is counted, not fatal — a partial
      // import the user can see is better than losing the whole file.
      const run = async () => {
        for (const line of lines.slice(1)) {
          const cells = parseCsvLine(line);
          const amount = Number(cells[col('amount')]);
          const type = cells[col('type')].toLowerCase();
          if (!(amount > 0) || (type !== 'debit' && type !== 'credit')) { skipped++; continue; }
          try {
            await accountsWrites.createBankTxn({
              tenantId, bankAccountId: activeBank.id,
              date: cells[col('date')] || todayISO(),
              description: col('description') >= 0 ? cells[col('description')] : '',
              amount, type: type as 'debit' | 'credit',
              reconciled: false, createdAt: new Date().toISOString(),
            });
            imported++;
          } catch { failed++; }
        }
      };
      return run().then(() => {
        audit('create', 'bank_statement', activeBank.id, `Imported ${imported} statement line(s) into ${activeBank.name}`);
        refresh();
        if (failed) toast.error(`${failed} line${failed === 1 ? '' : 's'} could not be saved`);
        toast.success(`${imported} line${imported === 1 ? '' : 's'} imported${skipped ? `, ${skipped} skipped` : ''}`);
      });
    }).catch(() => toast.error('Could not read that file'));
  };

  const downloadBankTemplate = () => {
    downloadCsv('bank-statement-template.csv', [
      ['date', 'description', 'amount', 'type'],
      ['2026-07-15', 'NEFT UTR2026071512345 BuildRight', 250000, 'debit'],
      ['2026-07-18', 'IMPS collection Rohan Verma', 750000, 'credit'],
    ]);
  };

  /** Candidate JEs for a bank line: posted entries whose cash movement equals
   *  the amount on the matching side and that no other line has claimed. */
  const matchCandidates = (txn: BankTransaction): JournalEntry[] => {
    const cashAcc = accounts.find(a => a.code === COA.CASH);
    if (!cashAcc) return [];
    const claimed = new Set(
      getByTenant<BankTransaction>('bankTransactions', tenantId)
        .filter(t => t.matchedJournalEntryId)
        .map(t => t.matchedJournalEntryId as string)
    );
    return entries.filter(e =>
      e.status === 'posted' && !claimed.has(e.id) &&
      e.lines.some(l => l.accountId === cashAcc.id &&
        // bank debit = money out = ledger credits cash; bank credit = the reverse
        (txn.type === 'debit' ? l.credit === txn.amount : l.debit === txn.amount))
    ).slice(0, 8);
  };

  const confirmMatch = async (txn: BankTransaction, je: JournalEntry) => {
    try {
      await accountsWrites.reconcileTxn(txn, je.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the reconciliation');
      return;
    }
    audit('update', 'bank_transaction', txn.id, `Reconciled "${txn.description.slice(0, 40)}" against JE: ${je.narration.slice(0, 40)}`);
    setMatchingTxn(null);
    refresh();
    toast.success('Matched and reconciled');
  };

  const bankBalance = activeBank
    ? activeBank.openingBalance
      + bankTxns.filter(t => t.type === 'credit').reduce((s, t) => s + t.amount, 0)
      - bankTxns.filter(t => t.type === 'debit').reduce((s, t) => s + t.amount, 0)
    : 0;
  const unreconciledCount = bankTxns.filter(t => !t.reconciled).length;

  // ── Loans ──────────────────────────────────────────────────────────────────
  const handleAddLoan = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const lenderName = (fd.get('lenderName') as string)?.trim();
    const principal = Number(fd.get('principal'));
    const rate = Number(fd.get('rate'));
    const tenure = Number(fd.get('tenure'));
    if (!lenderName || !(principal > 0) || !(tenure > 0)) { toast.error('Lender, principal and tenure are required'); return; }
    const startDate = (fd.get('startDate') as string) || todayISO();
    let created: Loan;
    try {
      created = await accountsWrites.createLoan({
        tenantId,
        projectId: (fd.get('projectId') as string) || undefined,
        lenderName,
        loanType: (fd.get('loanType') as LoanType) || 'term_loan',
        principal, interestRatePct: rate, tenureMonths: tenure,
        tdsPct: Number(fd.get('tdsPct')) || 0,
        startDate,
        schedule: buildLoanSchedule(principal, rate, tenure, Number(fd.get('tdsPct')) || 0, startDate),
        status: 'active',
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not record the loan');
      return;
    }
    try {
      await postLoanDisbursed(created, actor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Loan recorded, but posting to the ledger failed');
    }
    audit('create', 'loan', created.id, `Loan from ${lenderName} — ${formatCurrency(principal, currency)} at ${rate}% for ${tenure} months`);
    setShowAddLoan(false);
    setOpenLoanId(created.id);
    refresh();
    toast.success('Loan recorded — disbursement posted to the ledger');
  };

  const payInstallment = async (loan: Loan, number: number) => {
    const inst = loan.schedule.find(i => i.number === number);
    if (!inst || inst.status === 'paid') return;
    const firstPending = loan.schedule.find(i => i.status === 'pending');
    if (firstPending && firstPending.number !== number) {
      toast.error(`EMI #${firstPending.number} is due first — repayments post in order`);
      return;
    }
    let schedule: LoanInstallment[];
    try {
      schedule = await accountsWrites.payLoanInstallment(loan, number);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not record the EMI');
      return;
    }
    const allPaid = schedule.every(i => i.status === 'paid');
    try {
      await postLoanRepayment(loan, inst, actor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'EMI recorded, but posting to the ledger failed');
    }
    audit('payment', 'loan', loan.id, `Paid EMI #${inst.number} to ${loan.lenderName} — ${formatCurrency(inst.principal + inst.interest - inst.tds, currency)} net`);
    refresh();
    toast.success(allPaid ? 'Final EMI paid — loan closed' : `EMI #${inst.number} paid and posted`);
  };

  const exportStatement = () => {
    const today = todayISO();
    if (statement === 'tb') {
      downloadCsv(`trial-balance-${today}.csv`, [
        ['Code', 'Account', 'Type', 'Debit', 'Credit'],
        ...tb.rows.map(r => [r.account.code, r.account.name, r.account.type, r.debit, r.credit]),
        ['', 'TOTAL', '', tb.totalDebit, tb.totalCredit],
      ]);
    } else if (statement === 'pl') {
      downloadCsv(`profit-and-loss-${today}.csv`, [
        ['Section', 'Account', 'Amount'],
        ...pl.income.map(r => ['Income', r.account.name, r.net]),
        ...pl.expense.map(r => ['Expense', r.account.name, r.net]),
        ['', 'Net Profit', pl.netProfit],
      ]);
    } else if (statement === 'bs') {
      downloadCsv(`balance-sheet-${today}.csv`, [
        ['Section', 'Account', 'Amount'],
        ...bs.assets.map(r => ['Assets', r.account.name, r.net]),
        ...bs.liabilities.map(r => ['Liabilities', r.account.name, r.net]),
        ...bs.equity.map(r => ['Equity', r.account.name, r.net]),
        ['Equity', 'Retained Earnings (P&L)', bs.retainedEarnings],
      ]);
    } else if (statement === 'ff') {
      downloadCsv(`fund-flow-${today}.csv`, [
        ['Direction', 'Item', 'Due', 'Amount'],
        ...ff.inflows.map(l => ['Inflow', l.label, l.due.slice(0, 10), l.amount]),
        ...ff.outflows.map(l => ['Outflow', l.label, l.due.slice(0, 10), l.amount]),
        ['', 'Cash today', '', ff.cash],
        ['', 'Projected (30d)', '', ff.projected],
      ]);
    } else {
      downloadCsv(`project-pnl-${today}.csv`, [
        ['Project', 'Income', 'Expense', 'Net'],
        ...pp.map(r => [r.projectId ? projectName(r.projectId) : 'Head office / unallocated', r.income, r.expense, r.net]),
      ]);
    }
    toast.success('Exported as CSV');
  };

  const filteredEntries = journalFilter === 'all'
    ? entries
    : entries.filter(e => e.lines.some(l => l.accountId === journalFilter));

  const raStatusCls: Record<RaBill['status'], string> = {
    submitted: 'bg-amber-50 text-amber-700',
    site_approved: 'bg-blue-50 text-blue-700',
    approved: 'bg-indigo-50 text-indigo-700',
    paid: 'bg-emerald-50 text-emerald-700',
  };
  const raStatusLabel: Record<RaBill['status'], string> = {
    submitted: 'Awaiting site sign-off', site_approved: 'Awaiting finance', approved: 'Approved — payable', paid: 'Paid',
  };

  return (
    <div className="space-y-6 max-w-[1400px]">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Accounts & Ledger</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Double-entry ledger every module settles into — bills, collections and contractor RA billing.</p>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gradient-to-br from-indigo-500 to-violet-600 rounded-2xl p-4 text-white">
          <div className="flex items-center gap-2 mb-2">
            <Banknote className="h-5 w-5 text-indigo-200" />
            <span className="text-xs font-medium text-indigo-200">Cash & Bank</span>
          </div>
          <p className="text-3xl font-bold">{formatCurrency(bs.assets.find(a => a.account.code === '1000')?.net ?? 0, currency)}</p>
          <p className="text-xs text-indigo-200 mt-1">from posted entries</p>
        </div>
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Landmark className="h-5 w-5 text-zinc-400" />
            <span className="text-xs font-medium text-zinc-500">Payables Outstanding</span>
          </div>
          <p className="text-2xl font-bold text-zinc-900">{formatCurrency(bs.liabilities.reduce((s, b) => s + b.net, 0), currency)}</p>
          <p className="text-xs text-zinc-500 mt-1">incl. retention & statutory</p>
        </div>
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Scale className="h-5 w-5 text-zinc-400" />
            <span className="text-xs font-medium text-zinc-500">Net Profit (cash-basis)</span>
          </div>
          <p className={`text-2xl font-bold ${pl.netProfit < 0 ? 'text-red-600' : 'text-zinc-900'}`}>{formatCurrency(pl.netProfit, currency)}</p>
          <p className="text-xs text-zinc-500 mt-1">{formatCurrency(pl.totalIncome, currency)} in · {formatCurrency(pl.totalExpense, currency)} out</p>
        </div>
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-2">
            <HardHat className="h-5 w-5 text-zinc-400" />
            <span className="text-xs font-medium text-zinc-500">RA Pipeline</span>
          </div>
          <p className="text-2xl font-bold text-zinc-900">{raBills.filter(r => r.status !== 'paid').length}</p>
          <p className="text-xs text-zinc-500 mt-1">{raBills.filter(r => r.status === 'submitted').length} at site · {raBills.filter(r => r.status === 'site_approved').length} at finance</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-white border border-zinc-200 rounded-xl p-1 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${tab === t.id ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}
          >
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      {/* ── Chart of Accounts ── */}
      {tab === 'ledger' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-3">
            <h3 className="font-semibold text-zinc-900">Chart of Accounts</h3>
            <div className="flex-1" />
            {canManage && (
              <button onClick={() => setShowAddAccount(true)} className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors">
                <Plus className="h-3.5 w-3.5" /> Add Account
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-zinc-50/30 border-b border-zinc-100">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Code</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Account</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase hidden sm:table-cell">Debits</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase hidden sm:table-cell">Credits</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Balance</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Status</th>
                </tr>
              </thead>
              <tbody>
                {ACCOUNT_TYPES.map(group => {
                  const rows = accounts.filter(a => a.type === group.id);
                  if (rows.length === 0) return null;
                  return [
                    <tr key={group.id} className="bg-zinc-50/60">
                      <td colSpan={6} className="px-4 py-2 text-[11px] font-bold text-zinc-500 uppercase tracking-wider">{group.label}</td>
                    </tr>,
                    ...rows.map(a => {
                      const bal = tb.rows.find(r => r.account.id === a.id);
                      return (
                        <tr key={a.id} className="border-b border-zinc-50 hover:bg-zinc-50/30 transition-colors">
                          <td className="px-4 py-2.5 text-xs font-mono font-semibold text-indigo-600">{a.code}</td>
                          <td className="px-4 py-2.5 text-sm text-zinc-800">{a.name}{a.isSystem && <span className="ml-1.5 text-[9px] font-semibold text-zinc-400 uppercase">sys</span>}</td>
                          <td className="px-4 py-2.5 text-sm text-zinc-600 text-right hidden sm:table-cell">{bal ? formatCurrency(bal.debit, currency) : '—'}</td>
                          <td className="px-4 py-2.5 text-sm text-zinc-600 text-right hidden sm:table-cell">{bal ? formatCurrency(bal.credit, currency) : '—'}</td>
                          <td className="px-4 py-2.5 text-sm font-semibold text-zinc-900 text-right">{bal ? formatCurrency(bal.net, currency) : '—'}</td>
                          <td className="px-4 py-2.5 text-center">
                            <button
                              disabled={!canManage || a.isSystem}
                              onClick={() => toggleAccount(a)}
                              className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${a.active ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-500'} ${canManage && !a.isSystem ? 'cursor-pointer hover:opacity-80' : ''}`}
                            >{a.active ? 'active' : 'inactive'}</button>
                          </td>
                        </tr>
                      );
                    }),
                  ];
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Journal ── */}
      {tab === 'journal' && (
        <div className="space-y-4">
        <TallyExportPanel />
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-3 flex-wrap">
            <h3 className="font-semibold text-zinc-900">Journal Entries</h3>
            <div className="flex-1" />
            <select value={journalFilter} onChange={e => setJournalFilter(e.target.value)} className="px-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs max-w-[220px]">
              <option value="all">All accounts</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
            </select>
            {canManage && (
              <button onClick={() => { setJeLines([emptyLine(), emptyLine()]); setShowAddJe(true); }} className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors">
                <Plus className="h-3.5 w-3.5" /> New Entry
              </button>
            )}
          </div>
          {filteredEntries.length === 0 ? (
            <div className="py-16 text-center">
              <FileText className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">No journal entries yet. Approving bills, collecting payments and RA billing post here automatically.</p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-50">
              {filteredEntries.slice(0, 50).map(e => {
                const total = e.lines.reduce((s, l) => s + l.debit, 0);
                return (
                  <div key={e.id} className="px-5 py-3">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${e.sourceType === 'manual' ? 'bg-zinc-100 text-zinc-600' : 'bg-indigo-50 text-indigo-600'}`}>
                        {SOURCE_LABELS[e.sourceType]}
                      </span>
                      <p className="text-sm font-medium text-zinc-900 flex-1 min-w-[200px]">{e.narration}</p>
                      <span className="text-[11px] text-zinc-400">{fmtDate(e.date)}</span>
                      <span className="text-sm font-bold text-zinc-900">{formatCurrency(total, currency)}</span>
                      {e.status === 'draft' ? (
                        canManage
                          ? <button onClick={() => { postDraft(e, actor); refresh(); toast.success('Entry posted'); }} className="text-[11px] font-semibold px-2.5 py-1 rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100">Post Draft</button>
                          : <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-amber-50 text-amber-700">draft</span>
                      ) : (
                        <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700">posted</span>
                      )}
                    </div>
                    <div className="mt-1.5 space-y-0.5">
                      {e.lines.map(l => {
                        const acc = accountName(l.accountId);
                        return (
                          <p key={l.id} className="text-[11px] text-zinc-500 pl-1">
                            {l.credit > 0 && <span className="inline-block w-8" />}
                            <span className="font-mono text-zinc-400">{acc?.code}</span> {acc?.name || 'Unknown account'}
                            <span className="font-semibold text-zinc-700"> {l.debit > 0 ? `Dr ${formatCurrency(l.debit, currency)}` : `Cr ${formatCurrency(l.credit, currency)}`}</span>
                            {l.note ? <span className="text-zinc-400"> · {l.note}</span> : null}
                          </p>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        </div>
      )}

      {/* ── Statements ── */}
      {tab === 'statements' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-1 bg-white border border-zinc-200 rounded-xl p-1 overflow-x-auto">
              {([['tb', 'Trial Balance'], ['pl', 'Profit & Loss'], ['bs', 'Balance Sheet'], ['ff', 'Fund Flow'], ['pp', 'Project P&L']] as const).map(([id, label]) => (
                <button key={id} onClick={() => setStatement(id)} className={`px-3.5 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${statement === id ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}>{label}</button>
              ))}
            </div>
            <button onClick={exportStatement} className="flex items-center gap-2 px-3 py-2 bg-white border border-zinc-200 rounded-xl text-xs font-medium text-zinc-600 hover:bg-zinc-50">
              <ArrowDownToLine className="h-3.5 w-3.5" /> Export CSV
            </button>
          </div>
          <p className="text-[11px] text-zinc-400">Customer collections are recognised on receipt (cash-basis); vendor expenses on bill approval (accrual). Generated live from posted entries.</p>

          <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
            {statement === 'tb' && (
              tb.rows.length === 0 ? <div className="py-16 text-center text-sm text-zinc-400">Nothing posted yet.</div> : (
                <table className="w-full">
                  <thead>
                    <tr className="bg-zinc-50/30 border-b border-zinc-100">
                      <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Account</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Debit</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tb.rows.map(r => (
                      <tr key={r.account.id} className="border-b border-zinc-50">
                        <td className="px-4 py-2.5 text-sm text-zinc-800"><span className="font-mono text-xs text-zinc-400 mr-2">{r.account.code}</span>{r.account.name}</td>
                        <td className="px-4 py-2.5 text-sm text-zinc-700 text-right">{r.debit ? formatCurrencyFull(r.debit, currency) : '—'}</td>
                        <td className="px-4 py-2.5 text-sm text-zinc-700 text-right">{r.credit ? formatCurrencyFull(r.credit, currency) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-zinc-50/50">
                      <td className="px-4 py-3 text-sm font-bold text-zinc-900">Total</td>
                      <td className="px-4 py-3 text-sm font-bold text-zinc-900 text-right">{formatCurrencyFull(tb.totalDebit, currency)}</td>
                      <td className="px-4 py-3 text-sm font-bold text-right">
                        <span className={tb.totalDebit === tb.totalCredit ? 'text-zinc-900' : 'text-red-600'}>{formatCurrencyFull(tb.totalCredit, currency)}</span>
                        {tb.totalDebit === tb.totalCredit && <span className="ml-2 text-[10px] font-semibold text-emerald-600">✓ balanced</span>}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )
            )}

            {statement === 'pl' && (
              <div className="divide-y divide-zinc-100">
                <StatementSection title="Income" rows={pl.income.map(r => ({ label: r.account.name, amount: r.net }))} total={pl.totalIncome} currency={currency} />
                <StatementSection title="Expenses" rows={pl.expense.map(r => ({ label: r.account.name, amount: r.net }))} total={pl.totalExpense} currency={currency} />
                <div className="px-5 py-4 flex items-center justify-between">
                  <p className="text-sm font-bold text-zinc-900">Net Profit</p>
                  <p className={`text-sm font-bold ${pl.netProfit < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{formatCurrencyFull(pl.netProfit, currency)}</p>
                </div>
              </div>
            )}

            {statement === 'bs' && (
              <div className="divide-y divide-zinc-100">
                <StatementSection title="Assets" rows={bs.assets.map(r => ({ label: r.account.name, amount: r.net }))} total={bs.totalAssets} currency={currency} />
                <StatementSection title="Liabilities" rows={bs.liabilities.map(r => ({ label: r.account.name, amount: r.net }))} total={bs.totalLiabilities} currency={currency} />
                <StatementSection
                  title="Equity"
                  rows={[...bs.equity.map(r => ({ label: r.account.name, amount: r.net })), { label: 'Retained Earnings (current P&L)', amount: bs.retainedEarnings }]}
                  total={bs.totalEquity} currency={currency}
                />
                <div className="px-5 py-4 flex items-center justify-between">
                  <p className="text-sm font-bold text-zinc-900">Liabilities + Equity</p>
                  <p className="text-sm font-bold text-zinc-900">
                    {formatCurrencyFull(bs.totalLiabilities + bs.totalEquity, currency)}
                    {Math.round(bs.totalAssets) === Math.round(bs.totalLiabilities + bs.totalEquity) && <span className="ml-2 text-[10px] font-semibold text-emerald-600">✓ = assets</span>}
                  </p>
                </div>
              </div>
            )}

            {statement === 'ff' && (
              <div className="divide-y divide-zinc-100">
                <div className="px-5 py-4 flex items-center justify-between">
                  <p className="text-sm font-semibold text-zinc-700">Cash today (ledger)</p>
                  <p className="text-sm font-bold text-zinc-900">{formatCurrencyFull(ff.cash, currency)}</p>
                </div>
                <StatementSection title="Expected In (next 30 days)" rows={ff.inflows.map(l => ({ label: `${l.label} · due ${new Date(l.due).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`, amount: l.amount }))} total={ff.totalIn} currency={currency} />
                <StatementSection title="Committed Out" rows={ff.outflows.map(l => ({ label: `${l.label} · due ${new Date(l.due).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`, amount: l.amount }))} total={ff.totalOut} currency={currency} />
                <div className="px-5 py-4 flex items-center justify-between">
                  <p className="text-sm font-bold text-zinc-900">Projected position</p>
                  <p className={`text-sm font-bold ${ff.projected < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{formatCurrencyFull(ff.projected, currency)}</p>
                </div>
              </div>
            )}

            {statement === 'pp' && (
              pp.length === 0 ? <div className="py-16 text-center text-sm text-zinc-400">No project-tagged postings yet.</div> : (
                <table className="w-full">
                  <thead>
                    <tr className="bg-zinc-50/30 border-b border-zinc-100">
                      <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Cost Center</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Income</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Expense</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pp.map(r => (
                      <tr key={r.projectId ?? 'ho'} className="border-b border-zinc-50">
                        <td className="px-4 py-2.5 text-sm text-zinc-800">{r.projectId ? projectName(r.projectId) : 'Head office / unallocated'}</td>
                        <td className="px-4 py-2.5 text-sm text-zinc-700 text-right">{formatCurrencyFull(r.income, currency)}</td>
                        <td className="px-4 py-2.5 text-sm text-zinc-700 text-right">{formatCurrencyFull(r.expense, currency)}</td>
                        <td className={`px-4 py-2.5 text-sm font-semibold text-right ${r.net < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{formatCurrencyFull(r.net, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}
          </div>
        </div>
      )}

      {/* ── Banking & Reconciliation ── */}
      {tab === 'banking' && (
        bankAccounts.length === 0 ? (
          <div className="bg-white rounded-2xl border border-zinc-200/60 py-16 text-center">
            <Landmark className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
            <p className="text-sm text-zinc-500 mb-4">Add your bank account, import the statement, and reconcile it line-by-line against the ledger.</p>
            {canManage && (
              <button onClick={() => setShowAddBank(true)} className="px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700">
                Add Bank Account
              </button>
            )}
          </div>
        ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <select value={activeBank?.id || ''} onChange={e => setBankId(e.target.value)} className="px-4 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm font-medium">
              {bankAccounts.map(b => <option key={b.id} value={b.id}>{b.name}{b.bankName ? ` — ${b.bankName}` : ''}</option>)}
            </select>
            <div className="flex-1" />
            {canManage && (<>
              <button onClick={downloadBankTemplate} className="px-3 py-2 bg-white border border-zinc-200 rounded-xl text-xs font-medium text-zinc-600 hover:bg-zinc-50">CSV Template</button>
              <label className="px-3 py-2 bg-emerald-50 text-emerald-700 rounded-xl text-xs font-semibold hover:bg-emerald-100 cursor-pointer">
                Import Statement
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) importStatement(f); e.target.value = ''; }} />
              </label>
              <button onClick={() => setShowAddTxn(true)} className="px-3 py-2 bg-white border border-zinc-200 rounded-xl text-xs font-medium text-zinc-600 hover:bg-zinc-50">Add Line</button>
              <button onClick={() => setShowAddBank(true)} className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700">
                <Plus className="h-3.5 w-3.5" /> Bank Account
              </button>
            </>)}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
              <p className="text-xs font-medium text-zinc-500 mb-1">Bank Balance (statement)</p>
              <p className="text-xl font-bold text-zinc-900">{formatCurrency(bankBalance, currency)}</p>
            </div>
            <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
              <p className="text-xs font-medium text-zinc-500 mb-1">Books — Cash & Bank</p>
              <p className="text-xl font-bold text-zinc-900">{formatCurrency(cashBalance(tenantId), currency)}</p>
            </div>
            <div className={`rounded-2xl border p-4 ${unreconciledCount > 0 ? 'bg-amber-50/60 border-amber-200' : 'bg-white border-zinc-200/60'}`}>
              <p className={`text-xs font-medium mb-1 ${unreconciledCount > 0 ? 'text-amber-600' : 'text-zinc-500'}`}>Unreconciled Lines</p>
              <p className={`text-xl font-bold ${unreconciledCount > 0 ? 'text-amber-600' : 'text-zinc-900'}`}>{unreconciledCount}</p>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
            {bankTxns.length === 0 ? (
              <div className="py-14 text-center text-sm text-zinc-400">No statement lines yet — import a CSV or add lines manually.</div>
            ) : (
              <div className="divide-y divide-zinc-50">
                {bankTxns.map(t => (
                  <div key={t.id} className="px-5 py-3 flex items-center gap-3 flex-wrap">
                    <span className={`h-7 w-7 rounded-lg flex items-center justify-center text-[10px] font-bold shrink-0 ${t.type === 'credit' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                      {t.type === 'credit' ? 'IN' : 'OUT'}
                    </span>
                    <div className="flex-1 min-w-[200px]">
                      <p className="text-sm text-zinc-800">{t.description || '—'}</p>
                      <p className="text-[11px] text-zinc-400">{fmtDate(t.date)}</p>
                    </div>
                    <p className="text-sm font-semibold text-zinc-900">{formatCurrency(t.amount, currency)}</p>
                    {t.reconciled ? (
                      <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700">reconciled</span>
                    ) : canManage ? (
                      <button onClick={() => setMatchingTxn(t)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-100">Match</button>
                    ) : (
                      <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-amber-50 text-amber-700">open</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        )
      )}

      {/* ── Loans ── */}
      {tab === 'loans' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-zinc-500">{loans.filter(l => l.status === 'active').length} active loan{loans.filter(l => l.status === 'active').length === 1 ? '' : 's'}</p>
            {canManage && (
              <button onClick={() => setShowAddLoan(true)} className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors">
                <Plus className="h-3.5 w-3.5" /> Record Loan
              </button>
            )}
          </div>
          {loans.length === 0 ? (
            <div className="bg-white rounded-2xl border border-zinc-200/60 py-16 text-center">
              <Banknote className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">No borrowings recorded. A loan posts its disbursement and every EMI to the ledger, TDS included.</p>
            </div>
          ) : (
            loans.map(loan => {
              const outstanding = loan.schedule.filter(i => i.status === 'pending').reduce((s, i) => s + i.principal, 0);
              const nextDue = loan.schedule.find(i => i.status === 'pending');
              const isOpen = openLoanId === loan.id;
              return (
                <div key={loan.id} className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
                  <button onClick={() => setOpenLoanId(isOpen ? null : loan.id)} className="w-full px-5 py-4 flex items-center gap-3 flex-wrap text-left hover:bg-zinc-50/40">
                    <div className="flex-1 min-w-[220px]">
                      <p className="text-sm font-semibold text-zinc-900">{loan.lenderName} <span className="text-[10px] font-medium text-zinc-400 uppercase">{LOAN_TYPES.find(t => t.id === loan.loanType)?.label}</span></p>
                      <p className="text-[11px] text-zinc-500">
                        {formatCurrency(loan.principal, currency)} at {loan.interestRatePct}% · {loan.tenureMonths} months
                        {loan.projectId ? ` · ${projectName(loan.projectId)}` : ''}
                        {nextDue ? ` · next EMI ${fmtDate(nextDue.dueDate)}` : ''}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-zinc-900">{formatCurrency(outstanding, currency)}</p>
                      <p className="text-[10px] text-zinc-400">principal outstanding</p>
                    </div>
                    <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${loan.status === 'active' ? 'bg-blue-50 text-blue-700' : 'bg-emerald-50 text-emerald-700'}`}>{loan.status}</span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-zinc-100 max-h-72 overflow-y-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="bg-zinc-50/30 border-b border-zinc-100">
                            <th className="text-left px-4 py-2 text-[10px] font-semibold text-zinc-500 uppercase">#</th>
                            <th className="text-left px-4 py-2 text-[10px] font-semibold text-zinc-500 uppercase">Due</th>
                            <th className="text-right px-4 py-2 text-[10px] font-semibold text-zinc-500 uppercase">Principal</th>
                            <th className="text-right px-4 py-2 text-[10px] font-semibold text-zinc-500 uppercase">Interest</th>
                            <th className="text-right px-4 py-2 text-[10px] font-semibold text-zinc-500 uppercase">TDS</th>
                            <th className="text-right px-4 py-2 text-[10px] font-semibold text-zinc-500 uppercase">Net EMI</th>
                            <th className="px-4 py-2" />
                          </tr>
                        </thead>
                        <tbody>
                          {loan.schedule.map(inst => (
                            <tr key={inst.number} className="border-b border-zinc-50">
                              <td className="px-4 py-2 text-xs text-zinc-500">{inst.number}</td>
                              <td className="px-4 py-2 text-xs text-zinc-700">{fmtDate(inst.dueDate)}</td>
                              <td className="px-4 py-2 text-xs text-zinc-700 text-right">{formatCurrencyFull(inst.principal, currency)}</td>
                              <td className="px-4 py-2 text-xs text-zinc-700 text-right">{formatCurrencyFull(inst.interest, currency)}</td>
                              <td className="px-4 py-2 text-xs text-zinc-700 text-right">{inst.tds ? formatCurrencyFull(inst.tds, currency) : '—'}</td>
                              <td className="px-4 py-2 text-xs font-semibold text-zinc-900 text-right">{formatCurrencyFull(inst.principal + inst.interest - inst.tds, currency)}</td>
                              <td className="px-4 py-2 text-right">
                                {inst.status === 'paid' ? (
                                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">paid</span>
                                ) : canPay ? (
                                  <button onClick={() => payInstallment(loan, inst.number)} className="text-[10px] font-semibold px-2 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">Pay</button>
                                ) : (
                                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">pending</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ── RA Bills ── */}
      {tab === 'ra' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-3">
            <div>
              <h3 className="font-semibold text-zinc-900">Contractor RA Bills</h3>
              <p className="text-xs text-zinc-500 mt-0.5">Two-stage approval: site verifies progress, then finance approves payment.</p>
            </div>
            <div className="flex-1" />
            {canManage && (
              <button onClick={openAddRa} className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors">
                <Plus className="h-3.5 w-3.5" /> New RA Bill
              </button>
            )}
          </div>
          {raBills.length === 0 ? (
            <div className="py-16 text-center">
              <HardHat className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">No RA bills yet. Contractor running-account bills are capped to the site's verified progress.</p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-50">
              {raBills.map(ra => (
                <div key={ra.id} className="px-5 py-3.5">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-xs font-mono font-semibold text-indigo-600">RA-{ra.raNumber}</span>
                    <div className="flex-1 min-w-[220px]">
                      <p className="text-sm font-medium text-zinc-900">{vendorName(ra.vendorId)} · {projectName(ra.projectId)}</p>
                      <p className="text-[11px] text-zinc-500">
                        {ra.progressPct}% claimed{ra.siteProgressPct !== null ? ` (site log: ${ra.siteProgressPct}%)` : ''}
                        {ra.overrideReason && <span className="text-amber-600 font-medium"> · override: {ra.overrideReason}</span>}
                        {' · '}{fmtDate(ra.createdAt)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-zinc-900">{formatCurrency(ra.netPayable, currency)} <span className="text-[10px] font-normal text-zinc-400">net</span></p>
                      <p className="text-[10px] text-zinc-400">{formatCurrency(ra.grossAmount, currency)} gross − {formatCurrency(ra.retentionAmount, currency)} ret − {formatCurrency(ra.deductions.reduce((s, d) => s + d.amount, 0), currency)} ded</p>
                    </div>
                    <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${raStatusCls[ra.status]}`}>{raStatusLabel[ra.status]}</span>
                    {ra.status === 'submitted' && canSignOff && (
                      <button onClick={() => signOffRa(ra)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-blue-50 text-blue-700 hover:bg-blue-100">Verify Progress</button>
                    )}
                    {ra.status === 'site_approved' && canApprove && (
                      <button onClick={() => approveRa(ra)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-50 text-emerald-700 hover:bg-emerald-100">Approve</button>
                    )}
                    {ra.status === 'approved' && canPay && (
                      <button onClick={() => setPayingRa(ra)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-100 inline-flex items-center gap-1">
                        <Banknote className="h-3 w-3" /> Record Payment
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Modals ── */}

      {showAddAccount && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddAccount(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Add Ledger Account</h3>
              <button onClick={() => setShowAddAccount(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddAccount} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Code *</label>
                  <input name="code" required placeholder="5990" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Type</label>
                  <select name="type" defaultValue="expense" className={inputCls}>
                    {ACCOUNT_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className={labelCls}>Account Name *</label>
                  <input name="name" required placeholder="Site Security Expense" className={inputCls} />
                </div>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddAccount(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Add Account</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAddJe && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddJe(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Manual Journal Entry</h3>
              <button onClick={() => setShowAddJe(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddJe} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className={labelCls}>Narration *</label>
                  <input name="narration" required placeholder="Month-end adjustment — office rent" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Date</label>
                  <input name="date" type="date" defaultValue={todayISO()} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Reference</label>
                  <input name="reference" placeholder="Voucher no." className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Cost Center (Project)</label>
                  <select name="projectId" className={inputCls}>
                    <option value="">Head office</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Save As</label>
                  <select name="status" defaultValue="posted" className={inputCls}>
                    <option value="posted">Post immediately</option>
                    <option value="draft">Draft (post later)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className={labelCls}>Lines</label>
                <div className="space-y-2">
                  {jeLines.map(line => (
                    <div key={line.key} className="grid grid-cols-12 gap-2 items-center">
                      <select
                        value={line.accountId}
                        onChange={e => setJeLines(ls => ls.map(x => x.key === line.key ? { ...x, accountId: e.target.value } : x))}
                        className="col-span-6 px-2 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-xs"
                      >
                        <option value="">Account…</option>
                        {accounts.filter(a => a.active).map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                      </select>
                      <input
                        value={line.debit} placeholder="Debit" type="number" min="0" step="any"
                        onChange={e => setJeLines(ls => ls.map(x => x.key === line.key ? { ...x, debit: e.target.value, credit: e.target.value ? '' : x.credit } : x))}
                        className="col-span-2 px-2 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-xs text-right"
                      />
                      <input
                        value={line.credit} placeholder="Credit" type="number" min="0" step="any"
                        onChange={e => setJeLines(ls => ls.map(x => x.key === line.key ? { ...x, credit: e.target.value, debit: e.target.value ? '' : x.debit } : x))}
                        className="col-span-3 px-2 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-xs text-right"
                      />
                      <button type="button" onClick={() => setJeLines(ls => ls.length > 2 ? ls.filter(x => x.key !== line.key) : ls)} className="col-span-1 p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 justify-self-center">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <div className="flex items-center justify-between">
                    <button type="button" onClick={() => setJeLines(ls => [...ls, emptyLine()])} className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-700 px-1 py-1">
                      <Plus className="h-3.5 w-3.5" /> Add line
                    </button>
                    <p className={`text-xs font-bold ${jeBalanced ? 'text-emerald-600' : 'text-red-600'}`}>
                      Dr {formatCurrency(jeTotals.dr, currency)} · Cr {formatCurrency(jeTotals.cr, currency)} {jeBalanced ? '✓ balanced' : '— must balance'}
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddJe(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" disabled={!jeBalanced} className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm disabled:opacity-40">Save Entry</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAddRa && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddRa(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">New RA Bill</h3>
              <button onClick={() => setShowAddRa(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddRa} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Contractor *</label>
                  <select value={raVendorId} onChange={e => setRaVendorId(e.target.value)} required className={inputCls}>
                    <option value="">Select…</option>
                    {vendors.filter(v => v.status === 'active').map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Project *</label>
                  <select value={raProjectId} onChange={e => setRaProjectId(e.target.value)} required className={inputCls}>
                    <option value="">Select…</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Cumulative Progress % *</label>
                  <input value={raProgress} onChange={e => setRaProgress(e.target.value)} type="number" min="1" max="100" required placeholder="45" className={inputCls} />
                  {raProjectId && (
                    <p className={`text-[11px] mt-1 ${raNeedsOverride ? 'text-amber-600 font-medium' : 'text-zinc-400'}`}>
                      Site log: {raSiteProgress === null ? 'no tasks logged' : `${raSiteProgress}% complete`}
                    </p>
                  )}
                </div>
                <div>
                  <label className={labelCls}>Gross Amount ({currency}) *</label>
                  <input value={raGross} onChange={e => setRaGross(e.target.value)} type="number" min="0" step="any" required placeholder="1200000" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Retention %</label>
                  <input value={raRetentionPct} onChange={e => setRaRetentionPct(e.target.value)} type="number" min="0" max="100" step="any" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Notes</label>
                  <input name="notes" placeholder="Work covered by this RA" className={inputCls} />
                </div>
              </div>

              {raNeedsOverride && (
                <div>
                  <label className={`${labelCls} text-amber-600`}>Override Reason * <span className="normal-case font-normal">(claim exceeds the site's logged progress)</span></label>
                  <input name="overrideReason" placeholder="e.g. finishing work not yet reflected in task log" className={`${inputCls} border-amber-300`} />
                </div>
              )}

              <div>
                <label className={labelCls}>Deductions (TDS, advance recovery…)</label>
                <div className="space-y-2">
                  {raDeductions.map((d, i) => (
                    <div key={i} className="flex gap-2">
                      <input value={d.label} onChange={e => setRaDeductions(ds => ds.map((x, xi) => xi === i ? { ...x, label: e.target.value } : x))} placeholder="TDS 2%" className={inputCls} />
                      <input value={d.amount || ''} type="number" min="0" step="any" onChange={e => setRaDeductions(ds => ds.map((x, xi) => xi === i ? { ...x, amount: Number(e.target.value) || 0 } : x))} placeholder="Amount" className={`${inputCls} max-w-[140px] text-right`} />
                      <button type="button" onClick={() => setRaDeductions(ds => ds.filter((_, xi) => xi !== i))} className="p-2 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 shrink-0"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setRaDeductions(ds => [...ds, { label: '', amount: 0 }])} className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-700 px-1 py-1">
                    <Plus className="h-3.5 w-3.5" /> Add deduction
                  </button>
                </div>
              </div>

              <div className="bg-zinc-50 rounded-xl p-3 text-sm flex items-center justify-between">
                <span className="text-zinc-500">Net payable</span>
                <span className={`font-bold ${raNet < 0 ? 'text-red-600' : 'text-zinc-900'}`}>
                  {formatCurrencyFull(raNet, currency)}
                  <span className="text-[10px] font-normal text-zinc-400 ml-1.5">= gross − {formatCurrency(raRetention, currency)} retention − {formatCurrency(raDeductionsTotal, currency)} deductions</span>
                </span>
              </div>

              {raLedgerFor && raLedgerFor.gross > 0 && (
                <p className="text-[11px] text-zinc-500 bg-indigo-50/50 rounded-xl px-3 py-2">
                  Contractor ledger: {formatCurrency(raLedgerFor.gross, currency)} billed · {formatCurrency(raLedgerFor.retained, currency)} retained · {formatCurrency(raLedgerFor.paid, currency)} paid · <span className="font-semibold text-zinc-700">{formatCurrency(raLedgerFor.outstanding, currency)} outstanding</span>
                </p>
              )}

              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddRa(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Submit for Sign-off</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAddBank && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddBank(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Add Bank Account</h3>
              <button onClick={() => setShowAddBank(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddBank} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className={labelCls}>Account Name *</label>
                  <input name="name" required placeholder="HDFC Current A/c" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Bank</label>
                  <input name="bankName" placeholder="HDFC Bank" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Account No. (last digits)</label>
                  <input name="accountNumber" placeholder="…4821" className={inputCls} />
                </div>
                <div className="col-span-2">
                  <label className={labelCls}>Opening Balance ({currency})</label>
                  <input name="openingBalance" type="number" step="any" placeholder="0" className={inputCls} />
                </div>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddBank(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Add Account</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAddTxn && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddTxn(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Add Statement Line</h3>
              <button onClick={() => setShowAddTxn(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddTxn} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Type</label>
                  <select name="type" className={inputCls}>
                    <option value="debit">Debit (money out)</option>
                    <option value="credit">Credit (money in)</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Amount *</label>
                  <input name="amount" type="number" min="0" step="any" required className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Date</label>
                  <input name="date" type="date" defaultValue={todayISO()} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Description</label>
                  <input name="description" placeholder="NEFT UTR…" className={inputCls} />
                </div>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddTxn(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Add Line</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {matchingTxn && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setMatchingTxn(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold text-zinc-900">Match Statement Line</h3>
              <button onClick={() => setMatchingTxn(null)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <p className="text-[11px] text-zinc-500 mb-4">
              {matchingTxn.type === 'credit' ? 'Money in' : 'Money out'} · {formatCurrencyFull(matchingTxn.amount, currency)} · {fmtDate(matchingTxn.date)} — pick the ledger entry this line settles.
            </p>
            {(() => {
              const candidates = matchCandidates(matchingTxn);
              if (candidates.length === 0) {
                return <p className="text-sm text-zinc-400 bg-zinc-50 rounded-xl p-4">No unmatched ledger entry moves cash by exactly this amount. Post the missing entry in the Journal first, then match.</p>;
              }
              return (
                <div className="space-y-2">
                  {candidates.map(je => (
                    <button
                      key={je.id}
                      onClick={() => confirmMatch(matchingTxn, je)}
                      className="w-full text-left px-4 py-3 rounded-xl border border-zinc-200 hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors"
                    >
                      <p className="text-sm font-medium text-zinc-900">{je.narration}</p>
                      <p className="text-[11px] text-zinc-500">{SOURCE_LABELS[je.sourceType]} · {fmtDate(je.date)}{je.reference ? ` · ${je.reference}` : ''}</p>
                    </button>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {showAddLoan && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddLoan(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Record Loan</h3>
              <button onClick={() => setShowAddLoan(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddLoan} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Lender *</label>
                  <input name="lenderName" required placeholder="HDFC Bank" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Type</label>
                  <select name="loanType" className={inputCls}>
                    {LOAN_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Principal ({currency}) *</label>
                  <input name="principal" type="number" min="1" step="any" required placeholder="10000000" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Interest % p.a. *</label>
                  <input name="rate" type="number" min="0" step="any" required placeholder="11.5" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Tenure (months) *</label>
                  <input name="tenure" type="number" min="1" required placeholder="24" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>TDS on Interest %</label>
                  <input name="tdsPct" type="number" min="0" step="any" placeholder="10" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Disbursed On</label>
                  <input name="startDate" type="date" defaultValue={todayISO()} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Project (Cost Center)</label>
                  <select name="projectId" className={inputCls}>
                    <option value="">Company-level</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              </div>
              <p className="text-[11px] text-zinc-400">The EMI schedule is generated on save; disbursement posts Dr Cash / Cr Loans Payable.</p>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowAddLoan(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Record Loan</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {payingRa && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setPayingRa(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-mono font-semibold text-indigo-600">RA-{payingRa.raNumber}</span>
              <button onClick={() => setPayingRa(null)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <h3 className="text-lg font-bold text-zinc-900 mb-1">Record Payment</h3>
            <p className="text-[11px] text-zinc-500 mb-4">{vendorName(payingRa.vendorId)} · net payable {formatCurrencyFull(payingRa.netPayable, currency)}</p>
            <form onSubmit={handlePayRa} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Mode</label>
                  <select name="mode" className={inputCls}>
                    {PAYMENT_MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Date</label>
                  <input name="date" type="date" defaultValue={todayISO()} className={inputCls} />
                </div>
                <div className="col-span-2">
                  <label className={labelCls}>Reference (UTR / cheque no.)</label>
                  <input name="reference" placeholder="UTR2026072100123" className={inputCls} />
                </div>
              </div>
              <button type="submit" className="w-full px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm flex items-center justify-center gap-2">
                <CheckCircle2 className="h-4 w-4" /> Pay {formatCurrencyFull(payingRa.netPayable, currency)}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function StatementSection({ title, rows, total, currency }: {
  title: string; rows: { label: string; amount: number }[]; total: number; currency: string;
}) {
  return (
    <div className="px-5 py-4">
      <p className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider mb-2">{title}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-400">Nothing recorded</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center justify-between text-sm">
              <span className="text-zinc-700">{r.label}</span>
              <span className="font-medium text-zinc-900">{formatCurrencyFull(r.amount, currency)}</span>
            </div>
          ))}
          <div className="flex items-center justify-between text-sm pt-1.5 border-t border-zinc-100">
            <span className="font-semibold text-zinc-500">Total {title}</span>
            <span className="font-bold text-zinc-900">{formatCurrencyFull(total, currency)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
