import { useState, useEffect, useMemo } from 'react';
import { Loader2, Plus, X, Inbox } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  isApiEnabled, apiGetServiceRequests, apiCreateServiceRequest, apiUpdateServiceRequest,
  apiGetCustomers, type ApiServiceRequest, type ApiCustomer,
} from '../services/apiClient';
import { useTenantUsers } from '../hooks/useTenantUsers';
import { useAuth } from '../context/AuthContext';

/**
 * Service requests raised against a CUSTOMER.
 *
 * Not the same thing as a ticket, which is why both exist: `service_tickets`
 * is the internal work item — a defect on a unit, assigned to an engineer —
 * while `service_requests` is what a buyer asks the builder for after they
 * have paid. A document copy, a payment query, a transfer. Different table,
 * different permissions path, different person raising it.
 *
 * The API for it has been live and gated on the service permissions the whole
 * time with no screen at all, so a request could be raised through the portal
 * and then sat in a table nobody could open.
 */

const CATEGORIES = ['maintenance', 'document_request', 'payment_query', 'transfer_request', 'other'] as const;
const STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;

const STATUS_STYLE: Record<string, string> = {
  open:        'bg-red-50 text-red-700',
  in_progress: 'bg-blue-50 text-blue-700',
  resolved:    'bg-emerald-50 text-emerald-700',
  closed:      'bg-zinc-100 text-zinc-500',
};

const pretty = (s: string) => (s ?? '').replace(/_/g, ' ');

export default function ServiceRequestsPanel({ canManage }: { canManage: boolean }) {
  const { tenant } = useAuth();
  const users = useTenantUsers(tenant?.id ?? '');

  const [requests, setRequests] = useState<ApiServiceRequest[]>([]);
  const [customers, setCustomers] = useState<ApiCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ customerId: '', category: 'other', description: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isApiEnabled()) { setLoading(false); return; }
    let cancelled = false;
    Promise.all([
      apiGetServiceRequests().catch(() => [] as ApiServiceRequest[]),
      apiGetCustomers().catch(() => [] as ApiCustomer[]),
    ]).then(([r, c]) => {
      if (cancelled) return;
      setRequests(Array.isArray(r) ? r : []);
      setCustomers(Array.isArray(c) ? c : []);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  // The row carries a customer id; a person reading this wants a name.
  const customerName = useMemo(() => {
    const m = new Map(customers.map(c => [c.id, c.name]));
    return (id: string) => m.get(id) ?? 'Unknown customer';
  }, [customers]);

  const userName = useMemo(() => {
    const m = new Map((users ?? []).map(u => [u.id, u.name]));
    return (id?: string | null) => (id ? m.get(id) ?? 'Someone' : null);
  }, [users]);

  const patch = async (r: ApiServiceRequest, body: { status?: string; assignedTo?: string }) => {
    setBusyId(r.id);
    try {
      await apiUpdateServiceRequest(r.id, body);
      toast.success('Request updated');
      setRefreshKey(k => k + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update that request');
    } finally {
      setBusyId(null);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiCreateServiceRequest({
        customerId: form.customerId,
        category: form.category,
        description: form.description,
      });
      toast.success('Request logged');
      setShowNew(false);
      setForm({ customerId: '', category: 'other', description: '' });
      setRefreshKey(k => k + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not log that request');
    } finally {
      setSaving(false);
    }
  };

  if (!isApiEnabled()) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200/60 py-14 text-center">
        <Inbox className="h-9 w-9 text-zinc-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-zinc-700">Service requests need the API</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-sm text-zinc-500 max-w-xl">
          What a buyer asks for after they have paid — a document, a payment query, a
          transfer. Separate from tickets, which are the internal work items raised
          against a unit.
        </p>
        {canManage && (
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" /> Log a request
          </button>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        {loading ? (
          <div className="py-14 flex justify-center"><Loader2 className="h-6 w-6 text-zinc-300 animate-spin" /></div>
        ) : requests.length === 0 ? (
          <div className="py-14 text-center">
            <Inbox className="h-9 w-9 text-zinc-200 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">No service requests yet</p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-50">
            {requests.map(r => (
              <div key={r.id} className="px-5 py-3 flex items-start gap-4 flex-wrap">
                <div className="flex-1 min-w-[220px]">
                  <p className="text-sm font-medium text-zinc-900">
                    {customerName(r.customerId)}
                    <span className="ml-2 text-[11px] font-normal text-zinc-400 capitalize">{pretty(r.category)}</span>
                  </p>
                  <p className="text-xs text-zinc-600 mt-0.5">{r.description || <span className="text-zinc-400">No description</span>}</p>
                  <p className="text-[11px] text-zinc-400 mt-0.5">
                    {new Date(r.createdAt).toLocaleDateString()}
                    {userName(r.assignedTo) ? ` · with ${userName(r.assignedTo)}` : ' · unassigned'}
                  </p>
                </div>
                <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize ${
                  STATUS_STYLE[r.status] ?? 'bg-zinc-100 text-zinc-600'}`}>
                  {pretty(r.status)}
                </span>
                {canManage && (
                  <div className="flex items-center gap-1.5">
                    <select
                      value={r.status} disabled={busyId === r.id}
                      onChange={e => patch(r, { status: e.target.value })}
                      className="px-2.5 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs capitalize disabled:opacity-50"
                      aria-label="Status"
                    >
                      {STATUSES.map(s => <option key={s} value={s}>{pretty(s)}</option>)}
                    </select>
                    <select
                      value={r.assignedTo ?? ''} disabled={busyId === r.id}
                      onChange={e => e.target.value && patch(r, { assignedTo: e.target.value })}
                      className="px-2.5 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs disabled:opacity-50"
                      aria-label="Assigned to"
                    >
                      <option value="">Unassigned</option>
                      {(users ?? []).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showNew && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 backdrop-blur-sm p-4"
          onClick={() => setShowNew(false)} role="dialog" aria-modal="true" aria-label="Log a service request"
        >
          <form
            onSubmit={create} onClick={e => e.stopPropagation()}
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4"
          >
            <div className="flex items-start justify-between">
              <h3 className="text-lg font-semibold text-zinc-900">Log a service request</h3>
              <button type="button" onClick={() => setShowNew(false)} className="p-1.5 rounded-lg hover:bg-zinc-100">
                <X className="h-4 w-4 text-zinc-500" />
              </button>
            </div>

            <label className="block">
              <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Customer</span>
              <select
                required value={form.customerId}
                onChange={e => setForm(f => ({ ...f, customerId: e.target.value }))}
                className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm"
              >
                <option value="">Select a customer…</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {customers.length === 0 && (
                // The request belongs to a buyer, so there is nothing to raise
                // one against until somebody is one.
                <span className="block text-[10px] text-amber-700 mt-0.5">
                  No customers yet — add one under Customers first.
                </span>
              )}
            </label>

            <label className="block">
              <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Category</span>
              <select
                value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm capitalize"
              >
                {CATEGORIES.map(c => <option key={c} value={c}>{pretty(c)}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">What are they asking for?</span>
              <textarea
                rows={3} maxLength={2000} value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm resize-none"
              />
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button" onClick={() => setShowNew(false)}
                className="px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-semibold text-zinc-600 hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                type="submit" disabled={saving || !form.customerId}
                className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}Log request
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
