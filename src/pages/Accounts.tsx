import { useState, useMemo } from 'react';
import {
  Landmark, BookOpen, Scale, HardHat, Plus, X, Trash2, CheckCircle2,
  ArrowDownToLine, FileText, Banknote,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, create, update, logAudit } from '../services/db';
import {
  ensureCoa, postEntry, postDraft, postRaApproved, postApPayment,
  trialBalance, profitAndLoss, balanceSheet, nextRaNumber, contractorLedger,
} from '../services/accountsService';
import { projectProgress } from '../services/executionService';
import { formatCurrency, formatCurrencyFull } from '../utils/format';
import { downloadCsv } from '../utils/csv';
import type {
  Account, AccountType, JournalEntry, Project, Vendor, RaBill, RaDeduction,
  PaymentMade, PaymentMode,
} from '../types';
import { ACCOUNT_TYPES, PAYMENT_MODES } from '../types';
import { v4 as uuid } from 'uuid';
import toast from 'react-hot-toast';

type Tab = 'ledger' | 'journal' | 'statements' | 'ra';

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'ledger', label: 'Chart of Accounts', icon: BookOpen },
  { id: 'journal', label: 'Journal', icon: FileText },
  { id: 'statements', label: 'Statements', icon: Scale },
  { id: 'ra', label: 'RA Bills', icon: HardHat },
];

const SOURCE_LABELS: Record<JournalEntry['sourceType'], string> = {
  manual: 'Manual', vendor_bill: 'Vendor Bill', ra_bill: 'RA Bill',
  customer_payment: 'Collection', ap_payment: 'Payment',
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

  const [tab, setTab] = useState<Tab>('ledger');
  const [statement, setStatement] = useState<'tb' | 'pl' | 'bs'>('tb');
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showAddJe, setShowAddJe] = useState(false);
  const [showAddRa, setShowAddRa] = useState(false);
  const [payingRa, setPayingRa] = useState<RaBill | null>(null);
  const [journalFilter, setJournalFilter] = useState('all');
  const [jeLines, setJeLines] = useState<DraftLine[]>([emptyLine(), emptyLine()]);

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
  const handleAddAccount = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const code = (fd.get('code') as string)?.trim();
    const name = (fd.get('name') as string)?.trim();
    if (!code || !name) { toast.error('Code and name are required'); return; }
    if (accounts.some(a => a.code === code)) { toast.error(`Account code ${code} already exists`); return; }
    const created = create<Account>('accounts', {
      id: '', tenantId, code, name,
      type: (fd.get('type') as AccountType) || 'expense',
      isSystem: false, active: true, createdAt: new Date().toISOString(),
    });
    audit('create', 'account', created.id, `Added ledger account ${code} — ${name}`);
    setShowAddAccount(false);
    refresh();
    toast.success('Account added');
  };

  const toggleAccount = (a: Account) => {
    if (a.isSystem) { toast.error('System accounts back automatic postings and stay active'); return; }
    update<Account>('accounts', a.id, { active: !a.active });
    refresh();
  };

  // ── Manual journal entry ───────────────────────────────────────────────────
  const jeTotals = jeLines.reduce(
    (acc, l) => ({ dr: acc.dr + (Number(l.debit) || 0), cr: acc.cr + (Number(l.credit) || 0) }),
    { dr: 0, cr: 0 }
  );
  const jeBalanced = jeTotals.dr > 0 && Math.round(jeTotals.dr * 100) === Math.round(jeTotals.cr * 100);

  const handleAddJe = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const narration = (fd.get('narration') as string)?.trim();
    if (!narration) { toast.error('Write a narration'); return; }
    try {
      postEntry({
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
  const raDeductionsTotal = raDeductions.reduce((s, d) => s + d.amount, 0);
  const raNet = raGrossNum - raRetention - raDeductionsTotal;
  const raLedgerFor = raVendorId ? contractorLedger(tenantId, raVendorId) : null;

  const openAddRa = () => {
    if (vendors.length === 0) { toast.error('Add the contractor in Procurement → Vendors first'); return; }
    if (projects.length === 0) { toast.error('Create a project first'); return; }
    setRaVendorId(''); setRaProjectId(''); setRaGross(''); setRaProgress('');
    setRaRetentionPct('5'); setRaDeductions([]);
    setShowAddRa(true);
  };

  const handleAddRa = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (!raVendorId || !raProjectId) { toast.error('Pick the contractor and the project'); return; }
    if (!(raGrossNum > 0)) { toast.error('Gross amount is required'); return; }
    if (!(raProgressNum > 0) || raProgressNum > 100) { toast.error('Work progress must be between 1 and 100%'); return; }
    if (raNet < 0) { toast.error('Deductions and retention exceed the gross amount'); return; }
    const overrideReason = (fd.get('overrideReason') as string)?.trim();
    if (raNeedsOverride && !overrideReason) {
      toast.error(`Claimed ${raProgressNum}% exceeds the site's logged ${raSiteProgress}% — an override reason is required`);
      return;
    }
    const created = create<RaBill>('raBills', {
      id: '', tenantId, vendorId: raVendorId, projectId: raProjectId,
      raNumber: nextRaNumber(tenantId, raVendorId, raProjectId),
      progressPct: raProgressNum,
      siteProgressPct: raSiteProgress,
      overrideReason: raNeedsOverride ? overrideReason : undefined,
      grossAmount: raGrossNum,
      retentionAmount: raRetention,
      deductions: raDeductions.filter(d => d.label.trim() && d.amount > 0),
      netPayable: raNet,
      status: 'submitted',
      notes: (fd.get('notes') as string) || '',
      createdBy: actor.id,
      createdAt: new Date().toISOString(),
    });
    audit('create', 'ra_bill', created.id, `RA-${created.raNumber} submitted for ${vendorName(raVendorId)} on ${projectName(raProjectId)} — ${formatCurrency(raGrossNum, currency)} gross`);
    setShowAddRa(false);
    refresh();
    toast.success(`RA-${created.raNumber} submitted — awaiting site sign-off`);
  };

  const signOffRa = (ra: RaBill) => {
    update<RaBill>('raBills', ra.id, { status: 'site_approved', signedOffBy: actor.id, signedOffAt: new Date().toISOString() });
    audit('update', 'ra_bill', ra.id, `Site sign-off on RA-${ra.raNumber} (${vendorName(ra.vendorId)})`);
    refresh();
    toast.success('Progress verified — over to finance');
  };

  const approveRa = (ra: RaBill) => {
    update<RaBill>('raBills', ra.id, { status: 'approved', approvedBy: actor.id, approvedAt: new Date().toISOString() });
    postRaApproved({ ...ra, status: 'approved' }, actor);
    audit('update', 'ra_bill', ra.id, `Finance approved RA-${ra.raNumber} — ${formatCurrency(ra.netPayable, currency)} payable`);
    refresh();
    toast.success('RA bill approved and posted to the ledger');
  };

  const handlePayRa = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!payingRa) return;
    const fd = new FormData(e.currentTarget);
    const payment = create<PaymentMade>('paymentsMade', {
      id: '', tenantId, vendorId: payingRa.vendorId, raBillId: payingRa.id,
      amount: payingRa.netPayable,
      date: (fd.get('date') as string) || new Date().toISOString().slice(0, 10),
      mode: (fd.get('mode') as PaymentMode) || 'bank_transfer',
      reference: (fd.get('reference') as string) || '',
      paidBy: actor.id, createdAt: new Date().toISOString(),
    });
    update<RaBill>('raBills', payingRa.id, { status: 'paid' });
    postApPayment(payment, `Paid RA-${payingRa.raNumber} to ${vendorName(payingRa.vendorId)}`, payingRa.projectId, actor);
    audit('payment', 'ra_bill', payingRa.id, `Paid RA-${payingRa.raNumber} — ${formatCurrency(payingRa.netPayable, currency)} (${payment.mode})`);
    setPayingRa(null);
    refresh();
    toast.success('Payment recorded and posted');
  };

  const exportStatement = () => {
    const today = new Date().toISOString().slice(0, 10);
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
    } else {
      downloadCsv(`balance-sheet-${today}.csv`, [
        ['Section', 'Account', 'Amount'],
        ...bs.assets.map(r => ['Assets', r.account.name, r.net]),
        ...bs.liabilities.map(r => ['Liabilities', r.account.name, r.net]),
        ...bs.equity.map(r => ['Equity', r.account.name, r.net]),
        ['Equity', 'Retained Earnings (P&L)', bs.retainedEarnings],
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
      )}

      {/* ── Statements ── */}
      {tab === 'statements' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-1 bg-white border border-zinc-200 rounded-xl p-1">
              {([['tb', 'Trial Balance'], ['pl', 'Profit & Loss'], ['bs', 'Balance Sheet']] as const).map(([id, label]) => (
                <button key={id} onClick={() => setStatement(id)} className={`px-3.5 py-2 rounded-lg text-sm font-medium transition-all ${statement === id ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}>{label}</button>
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
          </div>
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
                  <input name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className={inputCls} />
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
                  <input name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className={inputCls} />
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
