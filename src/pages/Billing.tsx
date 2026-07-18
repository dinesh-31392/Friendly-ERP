import { useState, useMemo } from 'react';
import { IndianRupee, Download, Filter, Search, CheckCircle, Clock, AlertTriangle, Plus, X, Trash2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, create, update, remove } from '../services/db';
import type { Invoice, InvoiceStatus, Lead } from '../types';
import { formatCurrency } from '../utils/format';
import toast from 'react-hot-toast';

const statusColors: Record<InvoiceStatus, string> = {
  'Paid': 'bg-emerald-50 text-emerald-700',
  'Pending': 'bg-amber-50 text-amber-700',
  'Generated': 'bg-blue-50 text-blue-700',
  'Overdue': 'bg-red-50 text-red-500',
};

const invoiceTypes = ['Booking Token', '1st Installment', '2nd Installment', '3rd Installment', 'Final Payment', 'Quotation', 'Refund'];

export default function Billing() {
  const { tenant, hasPermission } = useAuth();
  const tenantId = tenant?.id || '';
  const currency = tenant?.currency || 'INR';
  const canManage = hasPermission('manage_finance');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | 'all'>('all');
  const [showAdd, setShowAdd] = useState(false);

  const invoices = useMemo(
    () => getByTenant<Invoice>('invoices', tenantId).sort((a, b) =>
      new Date(b.date).getTime() - new Date(a.date).getTime()
    ),
    [tenantId, refreshKey]
  );
  const leads = useMemo(() => getByTenant<Lead>('leads', tenantId), [tenantId, refreshKey]);

  const filtered = invoices.filter(inv => {
    if (statusFilter !== 'all' && inv.status !== statusFilter) return false;
    if (search && !inv.leadName.toLowerCase().includes(search.toLowerCase()) && !inv.id.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // Compute stats
  const totalReceivables = invoices.filter(i => i.status === 'Pending' || i.status === 'Generated').reduce((s, i) => s + i.amount, 0);
  const collected = invoices.filter(i => i.status === 'Paid').reduce((s, i) => s + i.amount, 0);
  const pending = invoices.filter(i => i.status === 'Pending').reduce((s, i) => s + i.amount, 0);
  const overdue = invoices.filter(i => i.status === 'Overdue' || (i.status === 'Pending' && new Date(i.dueDate) < new Date())).reduce((s, i) => s + i.amount, 0);

  // Payment plan distribution (fake data based on bookings)
  const paymentPlans = [
    { label: '30-70 Plan', count: 12, color: 'bg-indigo-500' },
    { label: '20-80 Plan', count: 8, color: 'bg-violet-500' },
    { label: '40-60 Plan', count: 5, color: 'bg-emerald-500' },
    { label: 'Flexi Plan', count: 3, color: 'bg-amber-500' },
  ];
  const maxPlan = Math.max(...paymentPlans.map(p => p.count), 1);

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
    update<Invoice>('invoices', id, { status });
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

  return (
    <div className="space-y-6 max-w-[1200px]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Billing & Finance</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Invoices, payments, and collection tracking.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => toast.success('Export started')} className="flex items-center gap-2 px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">
            <Download className="h-4 w-4" /> Export
          </button>
          {canManage && (
            <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm">
              <Plus className="h-4 w-4" /> Create Invoice
            </button>
          )}
        </div>
      </div>

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
                    <td className="px-4 py-3 text-sm text-zinc-500">{new Date(inv.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
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

      <div className="bg-white rounded-2xl border border-zinc-200/60 p-5">
        <h3 className="font-semibold text-zinc-900 mb-3">Payment Plan Distribution</h3>
        <div className="flex items-center gap-4">
          {paymentPlans.map(plan => (
            <div key={plan.label} className="flex-1">
              <div className="flex justify-between text-sm mb-1">
                <span className="text-zinc-600">{plan.label}</span>
                <span className="font-semibold text-zinc-900">{plan.count}</span>
              </div>
              <div className="h-2 bg-zinc-100 rounded-full overflow-hidden">
                <div className={`h-full ${plan.color} rounded-full`} style={{ width: `${(plan.count / maxPlan) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {showAdd && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">Create Invoice</h3>
              <button onClick={() => setShowAdd(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAdd} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Customer / Lead *</label>
                <select name="leadId" required className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                  <option value="">Select a lead...</option>
                  {leads.map(l => (
                    <option key={l.id} value={l.id}>{l.name} — {l.project}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Type</label>
                  <select name="type" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    {invoiceTypes.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Status</label>
                  <select name="status" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    <option>Generated</option><option>Pending</option><option>Paid</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Amount (₹) *</label>
                  <input name="amount" type="number" required placeholder="450000" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Due Date</label>
                  <input name="dueDate" type="date" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
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
    </div>
  );
}
