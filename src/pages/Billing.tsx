import { useState, useMemo } from 'react';
import {
  IndianRupee, Download, Filter, Search, CheckCircle, Clock, AlertTriangle,
  Plus, X, Trash2, Receipt, Landmark, PiggyBank, ArrowUpRight, ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, create, update, remove, logAudit } from '../services/db';
import { isBillOverdue, projectActuals, formatPoNumber } from '../services/procurementService';
import { isFilingOverdue, markFiled } from '../services/complianceService';
import { needsApproval } from '../services/approvalService';
import { postVendorBillApproved, postApPayment, postCustomerPayment } from '../services/accountsService';
import type { Invoice, InvoiceStatus, Lead, Vendor, VendorBill, VendorBillStatus, Project, ProjectBudget, PurchaseOrder, ComplianceItem, FilingFrequency, PaymentMade, PaymentMode } from '../types';
import { BUDGET_CATEGORIES, FILING_AUTHORITIES, PAYMENT_MODES } from '../types';
import { formatCurrency } from '../utils/format';
import { downloadCsv } from '../utils/csv';
import toast from 'react-hot-toast';

const statusColors: Record<InvoiceStatus, string> = {
  'Paid': 'bg-emerald-50 text-emerald-700',
  'Pending': 'bg-amber-50 text-amber-700',
  'Generated': 'bg-blue-50 text-blue-700',
  'Overdue': 'bg-red-50 text-red-500',
};

const billStatusColors: Record<VendorBillStatus, string> = {
  pending: 'bg-amber-50 text-amber-700',
  approved: 'bg-blue-50 text-blue-700',
  paid: 'bg-emerald-50 text-emerald-700',
};

const invoiceTypes = ['Booking Token', '1st Installment', '2nd Installment', '3rd Installment', 'Final Payment', 'Quotation', 'Refund'];

type Tab = 'receivables' | 'payables' | 'budgets' | 'compliance';

export default function Billing() {
  const { user, tenant, hasPermission } = useAuth();
  const tenantId = tenant?.id || '';
  const currency = tenant?.currency || 'INR';
  const canManage = hasPermission('manage_finance');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  const [tab, setTab] = useState<Tab>('receivables');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | 'all'>('all');
  const [showAdd, setShowAdd] = useState(false);
  const [showAddBill, setShowAddBill] = useState(false);
  const [showAddFiling, setShowAddFiling] = useState(false);
  const [payingBill, setPayingBill] = useState<VendorBill | null>(null);
  const [budgetProjectId, setBudgetProjectId] = useState('');
  const canApproveBills = hasPermission('approve_vendor_bills');
  const actor = user ? { id: user.id, name: user.name } : { id: '', name: 'System' };

  const invoices = useMemo(
    () => getByTenant<Invoice>('invoices', tenantId).sort((a, b) =>
      new Date(b.date).getTime() - new Date(a.date).getTime()
    ),
    [tenantId, refreshKey]
  );
  const leads = useMemo(() => getByTenant<Lead>('leads', tenantId), [tenantId, refreshKey]);
  const vendors = useMemo(() => getByTenant<Vendor>('vendors', tenantId), [tenantId, refreshKey]);
  const bills = useMemo(
    () => getByTenant<VendorBill>('vendorBills', tenantId).sort((a, b) =>
      new Date(b.billDate).getTime() - new Date(a.billDate).getTime()
    ),
    [tenantId, refreshKey]
  );
  const projects = useMemo(() => getByTenant<Project>('projects', tenantId), [tenantId, refreshKey]);
  const budgets = useMemo(() => getByTenant<ProjectBudget>('projectBudgets', tenantId), [tenantId, refreshKey]);
  const pos = useMemo(() => getByTenant<PurchaseOrder>('purchaseOrders', tenantId), [tenantId, refreshKey]);
  const filings = useMemo(
    () => getByTenant<ComplianceItem>('complianceItems', tenantId).sort((a, b) => {
      // Pending first (by due date), filed history after (most recent first)
      if ((a.status === 'pending') !== (b.status === 'pending')) return a.status === 'pending' ? -1 : 1;
      return a.status === 'pending'
        ? new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
        : new Date(b.filedAt || 0).getTime() - new Date(a.filedAt || 0).getTime();
    }),
    [tenantId, refreshKey]
  );

  const vendorName = (id: string) => vendors.find(v => v.id === id)?.name || '—';
  const projectName = (id?: string) => projects.find(p => p.id === id)?.name || '—';
  const audit = (action: string, entity: string, entityId: string, details: string) => {
    if (user) logAudit({ tenantId, userId: user.id, userName: user.name, action, entity, entityId, details });
  };

  const filtered = invoices.filter(inv => {
    if (statusFilter !== 'all' && inv.status !== statusFilter) return false;
    if (search && !inv.leadName.toLowerCase().includes(search.toLowerCase()) && !inv.id.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // AR stats
  const totalReceivables = invoices.filter(i => i.status === 'Pending' || i.status === 'Generated').reduce((s, i) => s + i.amount, 0);
  const collected = invoices.filter(i => i.status === 'Paid').reduce((s, i) => s + i.amount, 0);
  const pending = invoices.filter(i => i.status === 'Pending').reduce((s, i) => s + i.amount, 0);
  const overdue = invoices.filter(i => i.status === 'Overdue' || (i.status === 'Pending' && new Date(i.dueDate) < new Date())).reduce((s, i) => s + i.amount, 0);

  // AP stats
  const payableOutstanding = bills.filter(b => b.status !== 'paid').reduce((s, b) => s + b.amount, 0);
  const payableOverdue = bills.filter(isBillOverdue).reduce((s, b) => s + b.amount, 0);
  const paidOut = bills.filter(b => b.status === 'paid').reduce((s, b) => s + b.amount, 0);
  const awaitingApproval = bills.filter(b => b.status === 'pending').length;

  // Budget tab derivations
  const budgetProject = projects.find(p => p.id === budgetProjectId) || projects[0];
  const projectBudgetLines = budgets.filter(b => b.projectId === budgetProject?.id);
  const actuals = budgetProject ? projectActuals(tenantId, budgetProject.id) : new Map<string, number>();
  // Categories with either a budget line or actual spend, in canonical order
  const budgetRows = BUDGET_CATEGORIES
    .map(category => ({
      category,
      line: projectBudgetLines.find(b => b.category === category),
      actual: actuals.get(category) ?? 0,
    }))
    .filter(r => r.line || r.actual > 0);
  const totalBudgeted = projectBudgetLines.reduce((s, b) => s + b.budgeted, 0);
  const totalActual = [...actuals.values()].reduce((s, v) => s + v, 0);

  const handleAdd = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canManage) { toast.error('You do not have permission to create invoices'); return; }
    const form = e.currentTarget;
    const formData = new FormData(form);
    const leadId = formData.get('leadId') as string;
    const lead = leads.find(l => l.id === leadId);
    if (!lead) { toast.error('Please select a lead'); return; }
    const amount = Number(formData.get('amount'));
    if (!amount) { toast.error('Amount is required'); return; }

    create<Invoice>('invoices', {
      id: '', tenantId, leadId, leadName: lead.name, project: lead.project,
      type: (formData.get('type') as string) || 'Quotation',
      amount, date: new Date().toISOString(),
      dueDate: (formData.get('dueDate') as string) ? new Date(formData.get('dueDate') as string).toISOString() : new Date(Date.now() + 86400000 * 30).toISOString(),
      status: (formData.get('status') as InvoiceStatus) || 'Generated',
    });
    setShowAdd(false);
    refresh();
    toast.success('Invoice created');
  };

  const handleStatusChange = (id: string, status: InvoiceStatus) => {
    if (!canManage) { toast.error('You do not have permission to update invoices'); return; }
    const inv = invoices.find(i => i.id === id);
    update<Invoice>('invoices', id, { status });
    // Cash landing → ledger. Only on the transition INTO Paid, never twice.
    if (status === 'Paid' && inv && inv.status !== 'Paid') {
      postCustomerPayment({
        tenantId, amount: inv.amount,
        narration: `Collection — ${inv.type} from ${inv.leadName} (${inv.project})`,
        sourceId: inv.id, actor,
      });
    }
    refresh();
    toast.success(`Marked as ${status}`);
  };

  const handleDelete = (id: string) => {
    if (!canManage) { toast.error('You do not have permission to delete invoices'); return; }
    if (!confirm('Delete this invoice?')) return;
    remove('invoices', id);
    refresh();
    toast.success('Invoice deleted');
  };

  // ── Vendor bills (AP) ──────────────────────────────────────────────────────
  const handleAddBill = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const vendorId = fd.get('vendorId') as string;
    const amount = Number(fd.get('amount'));
    if (!vendorId) { toast.error('Pick a vendor'); return; }
    if (!(amount > 0)) { toast.error('Amount is required'); return; }
    const poId = (fd.get('poId') as string) || undefined;
    const po = pos.find(p => p.id === poId);
    const created = create<VendorBill>('vendorBills', {
      id: '', tenantId, vendorId, poId,
      projectId: (fd.get('projectId') as string) || po?.projectId || undefined,
      billNumber: (fd.get('billNumber') as string) || '',
      category: (fd.get('category') as string) || 'Materials',
      amount,
      billDate: (fd.get('billDate') as string) || new Date().toISOString().slice(0, 10),
      dueDate: (fd.get('dueDate') as string) || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      status: 'pending',
      notes: (fd.get('notes') as string) || '',
      createdAt: new Date().toISOString(),
    });
    audit('create', 'vendor_bill', created.id, `Recorded bill ${created.billNumber || created.id.slice(0, 6)} from ${vendorName(vendorId)} — ${formatCurrency(amount, currency)}`);
    setShowAddBill(false);
    refresh();
    toast.success('Vendor bill recorded');
  };

  const approveBill = (bill: VendorBill) => {
    if (!canManage) { toast.error('You do not have permission to update bills'); return; }
    // Configurable threshold (Settings → Approvals): big bills need the
    // approve_vendor_bills grant, small ones the maker can clear alone.
    if (needsApproval(tenantId, 'vendor_bill', bill.amount) && !canApproveBills) {
      toast.error('This bill is above the approval threshold — only a vendor-bill approver can approve it.');
      return;
    }
    update<VendorBill>('vendorBills', bill.id, { status: 'approved' });
    postVendorBillApproved(bill, actor);
    audit('update', 'vendor_bill', bill.id, `Approved bill ${bill.billNumber || bill.id.slice(0, 6)} — posted to ledger`);
    refresh();
    toast.success('Bill approved and posted');
  };

  const handlePayBill = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!payingBill) return;
    const fd = new FormData(e.currentTarget);
    const payment = create<PaymentMade>('paymentsMade', {
      id: '', tenantId, vendorId: payingBill.vendorId, vendorBillId: payingBill.id,
      amount: payingBill.amount,
      date: (fd.get('date') as string) || new Date().toISOString().slice(0, 10),
      mode: (fd.get('mode') as PaymentMode) || 'bank_transfer',
      reference: (fd.get('reference') as string) || '',
      paidBy: actor.id, createdAt: new Date().toISOString(),
    });
    update<VendorBill>('vendorBills', payingBill.id, { status: 'paid', paidAt: new Date().toISOString() });
    postApPayment(payment, `Paid vendor bill ${payingBill.billNumber || payingBill.id.slice(0, 6)} to ${vendorName(payingBill.vendorId)}`, payingBill.projectId, actor);
    audit('payment', 'vendor_bill', payingBill.id, `Paid ${formatCurrency(payingBill.amount, currency)} (${payment.mode}${payment.reference ? ` · ${payment.reference}` : ''})`);
    setPayingBill(null);
    refresh();
    toast.success('Payment recorded and posted');
  };

  const deleteBill = (bill: VendorBill) => {
    if (!confirm('Delete this vendor bill?')) return;
    remove('vendorBills', bill.id);
    audit('delete', 'vendor_bill', bill.id, `Deleted bill ${bill.billNumber || bill.id.slice(0, 6)}`);
    refresh();
    toast.success('Bill deleted');
  };

  // ── Budgets ────────────────────────────────────────────────────────────────
  const setBudgetLine = (category: string, value: number) => {
    if (!budgetProject) return;
    const existing = projectBudgetLines.find(b => b.category === category);
    if (existing) {
      if (value <= 0) remove('projectBudgets', existing.id);
      else update<ProjectBudget>('projectBudgets', existing.id, { budgeted: value });
    } else if (value > 0) {
      create<ProjectBudget>('projectBudgets', {
        id: '', tenantId, projectId: budgetProject.id, category, budgeted: value,
        createdAt: new Date().toISOString(),
      });
    }
    refresh();
  };

  const handleAddBudgetLine = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!budgetProject) return;
    const fd = new FormData(e.currentTarget);
    const category = fd.get('category') as string;
    const amount = Number(fd.get('amount'));
    if (!category || !(amount > 0)) { toast.error('Pick a cost head and a positive amount'); return; }
    if (projectBudgetLines.some(b => b.category === category)) { toast.error('That cost head already has a budget — edit it in the table'); return; }
    setBudgetLine(category, amount);
    audit('create', 'project_budget', budgetProject.id, `Budgeted ${formatCurrency(amount, currency)} for ${category} on ${budgetProject.name}`);
    (e.target as HTMLFormElement).reset();
    toast.success('Budget line added');
  };

  // ── Compliance filings ─────────────────────────────────────────────────────
  const handleAddFiling = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const title = (fd.get('title') as string)?.trim();
    const dueDate = fd.get('dueDate') as string;
    if (!title || !dueDate) { toast.error('Title and due date are required'); return; }
    const created = create<ComplianceItem>('complianceItems', {
      id: '', tenantId, title,
      authority: (fd.get('authority') as string) || 'Other',
      dueDate,
      frequency: (fd.get('frequency') as FilingFrequency) || 'one_time',
      projectId: (fd.get('projectId') as string) || undefined,
      notes: (fd.get('notes') as string) || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    audit('create', 'compliance_item', created.id, `Tracked filing "${title}" due ${dueDate}`);
    setShowAddFiling(false);
    refresh();
    toast.success('Filing tracked');
  };

  const handleMarkFiled = (item: ComplianceItem) => {
    if (!user) return;
    const next = markFiled(item, { id: user.id, name: user.name });
    refresh();
    toast.success(next ? `Filed — next ${item.title} tracked for ${new Date(next.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : 'Marked filed');
  };

  const deleteFiling = (item: ComplianceItem) => {
    if (!confirm(`Stop tracking "${item.title}"?`)) return;
    remove('complianceItems', item.id);
    refresh();
    toast.success('Filing removed');
  };

  /** Real export of whichever tab is on screen — Excel-safe CSV. */
  const handleExport = () => {
    const today = new Date().toISOString().slice(0, 10);
    if (tab === 'receivables') {
      if (invoices.length === 0) { toast.error('Nothing to export yet'); return; }
      downloadCsv(`invoices-${today}.csv`, [
        ['Invoice', 'Customer', 'Project', 'Type', 'Amount', 'Date', 'Due Date', 'Status'],
        ...invoices.map(i => [i.id.slice(0, 6).toUpperCase(), i.leadName, i.project, i.type, i.amount, i.date.slice(0, 10), i.dueDate.slice(0, 10), i.status]),
      ]);
    } else if (tab === 'payables') {
      if (bills.length === 0) { toast.error('Nothing to export yet'); return; }
      downloadCsv(`vendor-bills-${today}.csv`, [
        ['Bill No', 'Vendor', 'Project', 'Cost Head', 'Amount', 'Bill Date', 'Due Date', 'Status', 'Overdue'],
        ...bills.map(b => [b.billNumber || b.id.slice(0, 6), vendorName(b.vendorId), projectName(b.projectId), b.category, b.amount, b.billDate, b.dueDate, b.status, isBillOverdue(b) ? 'yes' : 'no']),
      ]);
    } else if (tab === 'budgets') {
      if (!budgetProject || budgetRows.length === 0) { toast.error('Nothing to export yet'); return; }
      downloadCsv(`budget-vs-actual-${budgetProject.name.replace(/\s+/g, '-').toLowerCase()}-${today}.csv`, [
        ['Project', 'Cost Head', 'Budgeted', 'Actual', 'Variance'],
        ...budgetRows.map(r => [budgetProject.name, r.category, r.line?.budgeted ?? 0, r.actual, (r.line?.budgeted ?? 0) - r.actual]),
      ]);
    } else {
      if (filings.length === 0) { toast.error('Nothing to export yet'); return; }
      downloadCsv(`compliance-filings-${today}.csv`, [
        ['Filing', 'Authority', 'Project', 'Due Date', 'Frequency', 'Status', 'Filed At'],
        ...filings.map(f => [f.title, f.authority, f.projectId ? projectName(f.projectId) : '', f.dueDate, f.frequency.replace('_', ' '), isFilingOverdue(f) ? 'OVERDUE' : f.status, f.filedAt?.slice(0, 10) ?? '']),
      ]);
    }
    toast.success('Exported as CSV (opens in Excel)');
  };

  const fmtDate = (d?: string) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const inputCls = 'w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20';
  const labelCls = 'block text-xs font-semibold text-zinc-500 uppercase mb-1';

  const TAB_DEFS: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'receivables', label: 'Receivables', icon: Receipt },
    { id: 'payables', label: 'Payables', icon: Landmark },
    { id: 'budgets', label: 'Budget vs Actual', icon: PiggyBank },
    { id: 'compliance', label: 'Compliance', icon: ShieldCheck },
  ];
  const filingsDue = filings.filter(f => f.status === 'pending' && new Date(f.dueDate).getTime() <= Date.now() + 14 * 86400000).length;

  return (
    <div className="space-y-6 max-w-[1200px]">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Billing & Finance</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Customer collections, vendor payables and project budgets in one place.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExport} className="flex items-center gap-2 px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">
            <Download className="h-4 w-4" /> Export CSV
          </button>
          {canManage && tab === 'receivables' && (
            <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm">
              <Plus className="h-4 w-4" /> Create Invoice
            </button>
          )}
          {canManage && tab === 'payables' && (
            <button
              onClick={() => {
                if (vendors.length === 0) { toast.error('Add a vendor in Procurement first'); return; }
                setShowAddBill(true);
              }}
              className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm"
            >
              <Plus className="h-4 w-4" /> Record Bill
            </button>
          )}
          {canManage && tab === 'compliance' && (
            <button onClick={() => setShowAddFiling(true)} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm">
              <Plus className="h-4 w-4" /> Track Filing
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-white border border-zinc-200 rounded-xl p-1 overflow-x-auto">
        {TAB_DEFS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${tab === t.id ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}
          >
            <t.icon className="h-4 w-4" /> {t.label}
            {t.id === 'compliance' && filingsDue > 0 && (
              <span className={`text-[10px] font-bold px-1.5 rounded-full ${tab === 'compliance' ? 'bg-white/20' : 'bg-red-100 text-red-600'}`}>{filingsDue}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Receivables ── */}
      {tab === 'receivables' && (<>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Receivables', value: formatCurrency(totalReceivables, currency), icon: IndianRupee, color: 'text-emerald-600' },
          { label: 'Collected', value: formatCurrency(collected, currency), icon: CheckCircle, color: 'text-indigo-600' },
          { label: 'Pending', value: formatCurrency(pending, currency), icon: Clock, color: 'text-amber-600' },
          { label: 'Overdue', value: formatCurrency(overdue, currency), icon: AlertTriangle, color: 'text-red-500' },
        ].map((card, i) => (
          <div key={i} className="bg-white rounded-2xl border border-zinc-200/60 p-4">
            <div className="flex items-center gap-2 mb-2">
              <card.icon className={`h-5 w-5 ${card.color}`} />
              <span className="text-[11px] font-medium text-zinc-500">{card.label}</span>
            </div>
            <p className="text-xl font-bold text-zinc-900">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-3 flex-wrap">
          <h3 className="font-semibold text-zinc-900">Invoices</h3>
          <div className="flex-1" />
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." className="pl-8 pr-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 w-48" />
          </div>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as InvoiceStatus | 'all')} className="px-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
            <option value="all">All Status</option>
            <option value="Paid">Paid</option>
            <option value="Pending">Pending</option>
            <option value="Generated">Generated</option>
            <option value="Overdue">Overdue</option>
          </select>
          <button className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-500"><Filter className="h-4 w-4" /></button>
        </div>
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-zinc-400">No invoices found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-zinc-50/30 border-b border-zinc-100">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Invoice</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Customer</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Project</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Type</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Amount</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Due Date</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Status</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(inv => (
                  <tr key={inv.id} className="border-b border-zinc-50 hover:bg-zinc-50/30 transition-colors">
                    <td className="px-4 py-3 text-sm font-medium text-zinc-900">#{inv.id.slice(0, 6).toUpperCase()}</td>
                    <td className="px-4 py-3 text-sm text-zinc-600">{inv.leadName}</td>
                    <td className="px-4 py-3 text-sm text-zinc-600">{inv.project}</td>
                    <td className="px-4 py-3 text-sm text-zinc-600">{inv.type}</td>
                    <td className="px-4 py-3 text-sm font-semibold text-zinc-900 text-right">{formatCurrency(inv.amount, currency)}</td>
                    <td className="px-4 py-3 text-sm text-zinc-500">{fmtDate(inv.dueDate)}</td>
                    <td className="px-4 py-3 text-center">
                      {canManage ? (
                        <select
                          value={inv.status}
                          onChange={e => handleStatusChange(inv.id, e.target.value as InvoiceStatus)}
                          className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border-0 cursor-pointer ${statusColors[inv.status]}`}
                        >
                          <option value="Paid">Paid</option>
                          <option value="Pending">Pending</option>
                          <option value="Generated">Generated</option>
                          <option value="Overdue">Overdue</option>
                        </select>
                      ) : (
                        <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${statusColors[inv.status]}`}>{inv.status}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canManage && (
                        <button onClick={() => handleDelete(inv.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 transition-colors">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </>)}

      {/* ── Payables ── */}
      {tab === 'payables' && (<>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Outstanding Payables', value: formatCurrency(payableOutstanding, currency), icon: Landmark, color: 'text-indigo-600' },
          { label: 'Overdue to Vendors', value: formatCurrency(payableOverdue, currency), icon: AlertTriangle, color: 'text-red-500' },
          { label: 'Paid Out', value: formatCurrency(paidOut, currency), icon: CheckCircle, color: 'text-emerald-600' },
          { label: 'Awaiting Approval', value: String(awaitingApproval), icon: Clock, color: 'text-amber-600' },
        ].map((card, i) => (
          <div key={i} className="bg-white rounded-2xl border border-zinc-200/60 p-4">
            <div className="flex items-center gap-2 mb-2">
              <card.icon className={`h-5 w-5 ${card.color}`} />
              <span className="text-[11px] font-medium text-zinc-500">{card.label}</span>
            </div>
            <p className="text-xl font-bold text-zinc-900">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100">
          <h3 className="font-semibold text-zinc-900">Vendor Bills</h3>
        </div>
        {bills.length === 0 ? (
          <div className="py-16 text-center">
            <Landmark className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
            <p className="text-sm text-zinc-400">No vendor bills yet. Record contractor and supplier bills to track what you owe.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-zinc-50/30 border-b border-zinc-100">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Bill</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Vendor</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase hidden md:table-cell">Project</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase hidden sm:table-cell">Cost Head</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Amount</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Due</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {bills.map(bill => {
                  const po = pos.find(p => p.id === bill.poId);
                  const isOver = isBillOverdue(bill);
                  return (
                    <tr key={bill.id} className="border-b border-zinc-50 hover:bg-zinc-50/30 transition-colors">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-zinc-900">{bill.billNumber || `#${bill.id.slice(0, 6).toUpperCase()}`}</p>
                        <p className="text-[11px] text-zinc-400">{fmtDate(bill.billDate)}{po ? ` · ${formatPoNumber(po.number)}` : ''}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-zinc-600">{vendorName(bill.vendorId)}</td>
                      <td className="px-4 py-3 text-sm text-zinc-600 hidden md:table-cell">{projectName(bill.projectId)}</td>
                      <td className="px-4 py-3 text-sm text-zinc-600 hidden sm:table-cell">{bill.category}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-zinc-900 text-right">{formatCurrency(bill.amount, currency)}</td>
                      <td className={`px-4 py-3 text-sm ${isOver ? 'text-red-600 font-semibold' : 'text-zinc-500'}`}>
                        {fmtDate(bill.dueDate)}{isOver ? ' ⚠' : ''}
                      </td>
                      <td className="px-4 py-3 text-center whitespace-nowrap">
                        <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${billStatusColors[bill.status]}`}>{bill.status}</span>
                        {canManage && bill.status === 'pending' && (
                          <button onClick={() => approveBill(bill)} className="ml-1.5 text-[11px] font-semibold px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100">Approve</button>
                        )}
                        {canManage && bill.status === 'approved' && (
                          <button onClick={() => setPayingBill(bill)} className="ml-1.5 text-[11px] font-semibold px-2 py-1 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100">Pay</button>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {canManage && (
                          <button onClick={() => deleteBill(bill)} className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 transition-colors">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </>)}

      {/* ── Budget vs Actual ── */}
      {tab === 'budgets' && (
        projects.length === 0 ? (
          <div className="bg-white rounded-2xl border border-zinc-200/60 py-16 text-center">
            <PiggyBank className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
            <p className="text-sm text-zinc-400">Create a project first — budgets are tracked per project.</p>
          </div>
        ) : (<>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <select
            value={budgetProject?.id || ''}
            onChange={e => setBudgetProjectId(e.target.value)}
            className="px-4 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm font-medium text-zinc-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          >
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-zinc-500">Budgeted: <span className="font-bold text-zinc-900">{formatCurrency(totalBudgeted, currency)}</span></span>
            <span className="text-zinc-500">Actual: <span className={`font-bold ${totalBudgeted > 0 && totalActual > totalBudgeted ? 'text-red-600' : 'text-zinc-900'}`}>{formatCurrency(totalActual, currency)}</span></span>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100">
            <h3 className="font-semibold text-zinc-900">Cost Heads — {budgetProject?.name}</h3>
            <p className="text-xs text-zinc-500 mt-0.5">Actuals are approved + paid vendor bills in each cost head. Record bills under Payables.</p>
          </div>
          {budgetRows.length === 0 ? (
            <div className="py-14 text-center text-sm text-zinc-400">No budget lines yet — add the first cost head below.</div>
          ) : (
            <div className="divide-y divide-zinc-50">
              {budgetRows.map(({ category, line, actual }) => {
                const budgeted = line?.budgeted ?? 0;
                const pct = budgeted > 0 ? Math.min(150, (actual / budgeted) * 100) : (actual > 0 ? 100 : 0);
                const over = budgeted > 0 && actual > budgeted;
                return (
                  <div key={category} className="px-5 py-3.5">
                    <div className="flex items-center justify-between gap-3 mb-1.5 flex-wrap">
                      <p className="text-sm font-medium text-zinc-900">{category}</p>
                      <div className="flex items-center gap-3 text-xs">
                        <span className="text-zinc-500">
                          {formatCurrency(actual, currency)} of{' '}
                          {canManage && line ? (
                            <input
                              type="number"
                              defaultValue={line.budgeted}
                              onBlur={e => { const v = Number(e.target.value); if (v !== line.budgeted) setBudgetLine(category, v); }}
                              className="w-28 px-2 py-0.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs text-right font-semibold"
                            />
                          ) : (
                            <span className="font-semibold text-zinc-800">{budgeted > 0 ? formatCurrency(budgeted, currency) : 'unbudgeted'}</span>
                          )}
                        </span>
                        {over && (
                          <span className="inline-flex items-center gap-1 font-semibold text-red-600">
                            <ArrowUpRight className="h-3 w-3" /> {formatCurrency(actual - budgeted, currency)} over
                          </span>
                        )}
                        {!over && budgeted > 0 && (
                          <span className="text-emerald-600 font-semibold">{formatCurrency(budgeted - actual, currency)} left</span>
                        )}
                      </div>
                    </div>
                    <div className="h-2 bg-zinc-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${over ? 'bg-red-500' : pct > 80 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {canManage && budgetProject && (
            <form onSubmit={handleAddBudgetLine} className="px-5 py-4 border-t border-zinc-100 flex items-end gap-3 flex-wrap bg-zinc-50/40">
              <div className="flex-1 min-w-[160px]">
                <label className={labelCls}>Cost Head</label>
                <select name="category" className={inputCls}>
                  {BUDGET_CATEGORIES.filter(c => !projectBudgetLines.some(b => b.category === c)).map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="flex-1 min-w-[140px]">
                <label className={labelCls}>Budget Amount ({currency})</label>
                <input name="amount" type="number" min="0" placeholder="5000000" className={inputCls} />
              </div>
              <button type="submit" className="px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">
                Add Budget Line
              </button>
            </form>
          )}
        </div>
        </>)
      )}

      {/* ── Compliance ── */}
      {tab === 'compliance' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100">
            <h3 className="font-semibold text-zinc-900">Statutory Filings & Deadlines</h3>
            <p className="text-xs text-zinc-500 mt-0.5">GST, RERA, TDS, PF/ESI — marking a recurring filing as filed automatically tracks the next period.</p>
          </div>
          {filings.length === 0 ? (
            <div className="py-16 text-center">
              <ShieldCheck className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-400">No filings tracked yet. Add your recurring returns once — deadlines then surface on the dashboard.</p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-50">
              {filings.map(f => {
                const overdueF = isFilingOverdue(f);
                const daysLeft = Math.ceil((new Date(f.dueDate).getTime() - Date.now()) / 86400000);
                return (
                  <div key={f.id} className="flex items-center gap-3 px-5 py-3 flex-wrap">
                    <div className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${f.status === 'filed' ? 'bg-emerald-50' : overdueF ? 'bg-red-50' : 'bg-indigo-50'}`}>
                      <ShieldCheck className={`h-5 w-5 ${f.status === 'filed' ? 'text-emerald-500' : overdueF ? 'text-red-500' : 'text-indigo-500'}`} />
                    </div>
                    <div className="flex-1 min-w-[220px]">
                      <p className="text-sm font-medium text-zinc-900">{f.title}</p>
                      <p className="text-[11px] text-zinc-500">
                        {f.authority}{f.projectId ? ` · ${projectName(f.projectId)}` : ''} · {f.frequency.replace('_', '-')}
                        {f.status === 'filed' && f.filedAt ? ` · filed ${fmtDate(f.filedAt)}` : ''}
                      </p>
                    </div>
                    {f.status === 'pending' && (
                      <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${overdueF ? 'bg-red-50 text-red-600' : daysLeft <= 14 ? 'bg-amber-50 text-amber-700' : 'bg-zinc-100 text-zinc-600'}`}>
                        {overdueF ? `overdue since ${fmtDate(f.dueDate)}` : `due ${fmtDate(f.dueDate)}`}
                      </span>
                    )}
                    {f.status === 'filed' && <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700">filed</span>}
                    {canManage && f.status === 'pending' && (
                      <button onClick={() => handleMarkFiled(f)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors">Mark Filed</button>
                    )}
                    {canManage && (
                      <button onClick={() => deleteFiling(f)} className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-300 hover:text-red-500 transition-colors">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Pay vendor bill modal — records the payment (mode + reference) and
          posts the AP → cash journal entry */}
      {payingBill && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setPayingBill(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-indigo-600">{payingBill.billNumber || `#${payingBill.id.slice(0, 6).toUpperCase()}`}</span>
              <button onClick={() => setPayingBill(null)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <h3 className="text-lg font-semibold text-zinc-900 mb-1">Record Payment</h3>
            <p className="text-[11px] text-zinc-500 mb-4">{vendorName(payingBill.vendorId)} · {formatCurrency(payingBill.amount, currency)}</p>
            <form onSubmit={handlePayBill} className="space-y-3">
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
              <button type="submit" className="w-full px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">
                Pay {formatCurrency(payingBill.amount, currency)}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Track filing modal */}
      {showAddFiling && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddFiling(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">Track a Filing</h3>
              <button onClick={() => setShowAddFiling(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddFiling} className="space-y-3">
              <div>
                <label className={labelCls}>Filing *</label>
                <input name="title" required placeholder="GSTR-3B monthly return" className={inputCls} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Authority</label>
                  <select name="authority" className={inputCls}>
                    {FILING_AUTHORITIES.map(a => <option key={a}>{a}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Frequency</label>
                  <select name="frequency" className={inputCls}>
                    <option value="one_time">One-time</option>
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="annual">Annual</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Next Due Date *</label>
                  <input name="dueDate" type="date" required className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Project</label>
                  <select name="projectId" className={inputCls}>
                    <option value="">Company-wide</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className={labelCls}>Notes</label>
                <input name="notes" placeholder="Portal link, CA contact…" className={inputCls} />
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddFiling(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Track Filing</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create invoice modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">Create Invoice</h3>
              <button onClick={() => setShowAdd(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAdd} className="space-y-3">
              <div>
                <label className={labelCls}>Customer / Lead *</label>
                <select name="leadId" required className={inputCls}>
                  <option value="">Select a lead...</option>
                  {leads.map(l => (
                    <option key={l.id} value={l.id}>{l.name} — {l.project}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Type</label>
                  <select name="type" className={inputCls}>
                    {invoiceTypes.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Status</label>
                  <select name="status" className={inputCls}>
                    <option>Generated</option><option>Pending</option><option>Paid</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Amount (₹) *</label>
                  <input name="amount" type="number" required placeholder="450000" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Due Date</label>
                  <input name="dueDate" type="date" className={inputCls} />
                </div>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAdd(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Create Invoice</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Record vendor bill modal */}
      {showAddBill && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddBill(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">Record Vendor Bill</h3>
              <button onClick={() => setShowAddBill(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddBill} className="space-y-3">
              <div>
                <label className={labelCls}>Vendor *</label>
                <select name="vendorId" required className={inputCls}>
                  <option value="">Select vendor...</option>
                  {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Bill Number</label>
                  <input name="billNumber" placeholder="INV/2026/0417" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Amount ({currency}) *</label>
                  <input name="amount" type="number" min="0" step="any" required placeholder="250000" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Against PO</label>
                  <select name="poId" className={inputCls}>
                    <option value="">None</option>
                    {pos.filter(p => p.status !== 'cancelled').map(p => (
                      <option key={p.id} value={p.id}>{formatPoNumber(p.number)} — {vendorName(p.vendorId)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Project</label>
                  <select name="projectId" className={inputCls}>
                    <option value="">Not project-specific</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Cost Head</label>
                  <select name="category" defaultValue="Materials" className={inputCls}>
                    {BUDGET_CATEGORIES.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Bill Date</label>
                  <input name="billDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Due Date</label>
                  <input name="dueDate" type="date" className={inputCls} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Notes</label>
                <input name="notes" placeholder="RA bill 3 — plumbing contractor" className={inputCls} />
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddBill(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Record Bill</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
