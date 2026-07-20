import { useState, useMemo, useEffect } from 'react';
import { Wrench, Plus, Search, Filter, Clock, AlertCircle, CheckCircle2, User, MapPin, X, Trash2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, create, update, remove } from '../services/db';
import { useTenantUsers } from '../hooks/useTenantUsers';
import { localeFor } from '../utils/format';
import type { Ticket, TicketPriority, TicketStatus, Project, Lead } from '../types';
import toast from 'react-hot-toast';

const priorityColors: Record<TicketPriority, string> = {
  high: 'bg-red-50 text-red-700',
  medium: 'bg-amber-50 text-amber-700',
  low: 'bg-zinc-100 text-zinc-500',
};

const statusColors: Record<TicketStatus, string> = {
  open: 'bg-red-50 text-red-700',
  in_progress: 'bg-blue-50 text-blue-700',
  resolved: 'bg-emerald-50 text-emerald-700',
  closed: 'bg-zinc-100 text-zinc-500',
};

const ticketCategories = ['Defect', 'Request', 'Maintenance', 'Handover', 'Documentation', 'Other'];

export default function Service() {
  const { tenant } = useAuth();
  const tenantId = tenant?.id || '';
  const appLocale = localeFor(tenant?.currency);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'all'>('all');
  const [showAdd, setShowAdd] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);

  const tickets = useMemo(
    () => getByTenant<Ticket>('tickets', tenantId).sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    ),
    [tenantId, refreshKey]
  );

  // Deep linking: listen to search query focus events
  useEffect(() => {
    const focusId = localStorage.getItem('friendly_crm_focus_ticket');
    if (focusId) {
      const target = tickets.find(t => t.id === focusId);
      if (target) {
        setSelectedTicket(target);
      }
      localStorage.removeItem('friendly_crm_focus_ticket');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);
  const users = useTenantUsers(tenantId, refreshKey);
  const projects = useMemo(() => getByTenant<Project>('projects', tenantId), [tenantId, refreshKey]);

  const filtered = tickets.filter(t => {
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    if (search && !t.title.toLowerCase().includes(search.toLowerCase()) && !t.customer.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const openCount = tickets.filter(t => t.status === 'open').length;
  const inProgressCount = tickets.filter(t => t.status === 'in_progress').length;
  const resolvedCount = tickets.filter(t => t.status === 'resolved' || t.status === 'closed').length;

  const getUserName = (id: string) => users.find(u => u.id === id)?.name || 'Unassigned';

  const handleAdd = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    const title = formData.get('title') as string;
    const customer = formData.get('customer') as string;
    if (!title || !customer) { toast.error('Title and customer are required'); return; }

    // Identity-safe link: if the typed customer matches a lead, connect the
    // ticket to it so the customer portal shows it reliably
    const matchedLead = getByTenant<Lead>('leads', tenantId)
      .find(l => l.name.trim().toLowerCase() === customer.trim().toLowerCase());
    const activeStaff = users.filter(u => u.active && u.role !== 'super_admin');
    create<Ticket>('tickets', {
      id: '', tenantId, title, customer,
      leadId: matchedLead?.id,
      project: (formData.get('project') as string) || matchedLead?.project || 'General',
      category: (formData.get('category') as string) || 'Other',
      priority: (formData.get('priority') as TicketPriority) || 'medium',
      status: 'open',
      assignedTo: (formData.get('assignedTo') as string) || activeStaff[0]?.id || '',
      createdAt: new Date().toISOString(),
    });
    setShowAdd(false);
    refresh();
    toast.success('Ticket created');
  };

  const handleStatusChange = (id: string, status: TicketStatus) => {
    update<Ticket>('tickets', id, { status });
    refresh();
    toast.success(`Status updated to ${status.replace('_', ' ')}`);
  };

  const handleDelete = (id: string) => {
    if (!confirm('Delete this ticket?')) return;
    remove('tickets', id);
    setSelectedTicket(null);
    refresh();
    toast.success('Ticket deleted');
  };

  return (
    <div className="space-y-5 max-w-[1200px]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Service Tickets</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Track defects, requests, and maintenance issues.</p>
        </div>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm">
          <Plus className="h-4 w-4" /> New Ticket
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Open Tickets', value: openCount, icon: AlertCircle, color: 'text-red-500' },
          { label: 'In Progress', value: inProgressCount, icon: Clock, color: 'text-blue-500' },
          { label: 'Resolved', value: resolvedCount, icon: CheckCircle2, color: 'text-emerald-500' },
          { label: 'Avg Resolution', value: '2.4 days', icon: Wrench, color: 'text-violet-500' },
        ].map((stat, i) => (
          <div key={i} className="bg-white rounded-2xl border border-zinc-200/60 p-4">
            <div className="flex items-center gap-2 mb-2">
              <stat.icon className={`h-5 w-5 ${stat.color}`} />
              <span className="text-[11px] font-medium text-zinc-500">{stat.label}</span>
            </div>
            <p className="text-xl font-bold text-zinc-900">{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tickets..." className="w-full pl-9 pr-4 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
          </div>
          <button className="flex items-center gap-2 px-3 py-2 bg-white border border-zinc-200 rounded-lg text-sm font-medium text-zinc-600 hover:bg-zinc-50">
            <Filter className="h-4 w-4" /> Filters
          </button>
          <div className="flex items-center gap-1 bg-zinc-100 rounded-lg p-1">
            {(['all', 'open', 'in_progress', 'resolved', 'closed'] as const).map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s as TicketStatus | 'all')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-all ${statusFilter === s ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
              >
                {s.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-zinc-400">No tickets found</div>
        ) : (
          <div className="divide-y divide-zinc-50">
            {filtered.map(ticket => (
              <div key={ticket.id} className="px-5 py-4 hover:bg-zinc-50/30 transition-colors flex items-center gap-4 cursor-pointer" onClick={() => setSelectedTicket(ticket)}>
                <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${ticket.priority === 'high' ? 'bg-red-400' : ticket.priority === 'medium' ? 'bg-amber-400' : 'bg-zinc-300'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-mono text-zinc-400">#{ticket.id.slice(0, 6).toUpperCase()}</span>
                    <h4 className="text-sm font-semibold text-zinc-900">{ticket.title}</h4>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-zinc-500 flex-wrap">
                    <span className="flex items-center gap-1"><User className="h-3 w-3" /> {ticket.customer}</span>
                    <span className="flex items-center gap-1"><MapPin className="h-3 w-3" /> {ticket.project}</span>
                    <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {new Date(ticket.createdAt).toLocaleDateString(appLocale, { day: 'numeric', month: 'short' })}</span>
                    <span>Assigned: {getUserName(ticket.assignedTo)}</span>
                  </div>
                </div>
                <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize ${priorityColors[ticket.priority]}`}>{ticket.priority}</span>
                <select
                  value={ticket.status}
                  onClick={e => e.stopPropagation()}
                  onChange={e => handleStatusChange(ticket.id, e.target.value as TicketStatus)}
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border-0 cursor-pointer capitalize ${statusColors[ticket.status]}`}
                >
                  <option value="open">Open</option>
                  <option value="in_progress">In Progress</option>
                  <option value="resolved">Resolved</option>
                  <option value="closed">Closed</option>
                </select>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Ticket Detail Modal */}
      {selectedTicket && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setSelectedTicket(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-xs font-mono text-zinc-400 mb-1">#{selectedTicket.id.slice(0, 8).toUpperCase()}</p>
                <h3 className="text-lg font-semibold text-zinc-900">{selectedTicket.title}</h3>
              </div>
              <div className="flex gap-1">
                <button onClick={() => handleDelete(selectedTicket.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500"><Trash2 className="h-4 w-4" /></button>
                <button onClick={() => setSelectedTicket(null)} className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-500"><X className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="bg-zinc-50 rounded-xl p-3">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium">Customer</p>
                <p className="text-sm font-semibold text-zinc-900 mt-0.5">{selectedTicket.customer}</p>
              </div>
              <div className="bg-zinc-50 rounded-xl p-3">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium">Project</p>
                <p className="text-sm font-semibold text-zinc-900 mt-0.5">{selectedTicket.project}</p>
              </div>
              <div className="bg-zinc-50 rounded-xl p-3">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium">Category</p>
                <p className="text-sm font-semibold text-zinc-900 mt-0.5">{selectedTicket.category}</p>
              </div>
              <div className="bg-zinc-50 rounded-xl p-3">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium">Assigned To</p>
                <p className="text-sm font-semibold text-zinc-900 mt-0.5">{getUserName(selectedTicket.assignedTo)}</p>
              </div>
              <div className="bg-zinc-50 rounded-xl p-3">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium">Priority</p>
                <span className={`inline-block mt-1 text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${priorityColors[selectedTicket.priority]}`}>{selectedTicket.priority}</span>
              </div>
              <div className="bg-zinc-50 rounded-xl p-3">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium">Created</p>
                <p className="text-sm font-semibold text-zinc-900 mt-0.5">{new Date(selectedTicket.createdAt).toLocaleDateString(appLocale, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
              </div>
            </div>
            <div className="flex gap-2">
              {(['open', 'in_progress', 'resolved', 'closed'] as TicketStatus[]).map(s => (
                <button key={s}
                  onClick={() => { handleStatusChange(selectedTicket.id, s); setSelectedTicket({ ...selectedTicket, status: s }); }}
                  className={`flex-1 py-2 rounded-xl text-xs font-semibold capitalize transition-all ${selectedTicket.status === s ? statusColors[s] + ' ring-2 ring-offset-1 ring-current/20' : 'bg-zinc-50 text-zinc-500 hover:bg-zinc-100'}`}
                >{s.replace('_', ' ')}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">New Service Ticket</h3>
              <button onClick={() => setShowAdd(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAdd} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Issue Title *</label>
                <input name="title" required placeholder="e.g., Water seepage in bathroom" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Customer Name *</label>
                <input name="customer" required placeholder="Full name" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Project</label>
                  <select name="project" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    {projects.map(p => <option key={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Category</label>
                  <select name="category" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    {ticketCategories.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Priority</label>
                  <select name="priority" defaultValue="medium" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Assign To</label>
                  <select name="assignedTo" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    {users.filter(u => u.active && u.role !== 'super_admin').map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAdd(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Create Ticket</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
