import { useState, useEffect, useMemo } from 'react';
import { UserCheck, Search, Plus, ShieldCheck, ShieldAlert, ShieldQuestion, Loader2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  isApiEnabled, apiGetCustomers, apiCreateCustomer, apiUpdateCustomerKyc, apiGetLeads,
  type ApiCustomer,
} from '../services/apiClient';

/**
 * Customers — the people who actually bought, and the state of their KYC.
 *
 * A lead and a customer are not the same record and never were: `customers` is
 * its own table, with its own KYC state, and a lead may become one. The API for
 * it has been live and gated on the lead permissions throughout, with no screen
 * anywhere in the product — so KYC could be stored but never seen or changed,
 * and the only way to know a buyer was unverified was to query the database.
 *
 * KYC is the point of this page rather than a column on it. Possession is
 * gated on it, registration is gated on it, and "who is still unverified" is
 * the question someone asks the week before a handover — so it leads.
 */

const KYC_STYLE: Record<string, string> = {
  verified: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  pending:  'bg-amber-50 text-amber-700 border-amber-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
};

const KYC_ICON: Record<string, typeof ShieldCheck> = {
  verified: ShieldCheck,
  pending: ShieldQuestion,
  rejected: ShieldAlert,
};

/** The states the server accepts. Kept closed for the same reason the GST rate
 *  list is: a free-text status is how "verifed" ends up in a compliance report. */
const KYC_STATES = ['pending', 'verified', 'rejected'] as const;

export default function Customers() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('manage_leads');

  const [customers, setCustomers] = useState<ApiCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  const [search, setSearch] = useState('');
  const [kycFilter, setKycFilter] = useState<string>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  const [showNew, setShowNew] = useState(false);
  const [leads, setLeads] = useState<Array<{ id: string; name: string }>>([]);
  const [form, setForm] = useState({ name: '', email: '', phone: '', leadId: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isApiEnabled()) { setLoading(false); return; }
    let cancelled = false;
    apiGetCustomers()
      .then(rows => { if (!cancelled) setCustomers(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) toast.error('Could not load customers', { id: 'cust-load' }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  // Only when the modal opens — the list of customers does not need leads.
  useEffect(() => {
    if (!showNew || !isApiEnabled()) return;
    let cancelled = false;
    apiGetLeads()
      .then(l => { if (!cancelled) setLeads((l as Array<{ id: string; name: string }>).slice(0, 500)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [showNew]);

  const counts = useMemo(() => {
    const c = { verified: 0, pending: 0, rejected: 0 };
    for (const x of customers) {
      const k = (x.kycStatus ?? 'pending') as keyof typeof c;
      if (k in c) c[k] += 1;
    }
    return c;
  }, [customers]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customers.filter(c => {
      if (kycFilter !== 'all' && (c.kycStatus ?? 'pending') !== kycFilter) return false;
      if (!q) return true;
      return (c.name ?? '').toLowerCase().includes(q)
        || (c.phone ?? '').includes(q)
        || (c.email ?? '').toLowerCase().includes(q);
    });
  }, [customers, search, kycFilter]);

  const setKyc = async (c: ApiCustomer, kycStatus: string) => {
    setBusyId(c.id);
    try {
      await apiUpdateCustomerKyc(c.id, kycStatus);
      toast.success(`${c.name} marked ${kycStatus}`);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update KYC');
    } finally {
      setBusyId(null);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiCreateCustomer({
        name: form.name,
        // Sent only when filled: an empty string is not a missing value, and
        // storing one makes "has no email" indistinguishable from "has ''".
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
        ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
        ...(form.leadId ? { leadId: form.leadId } : {}),
      });
      toast.success('Customer added');
      setShowNew(false);
      setForm({ name: '', email: '', phone: '', leadId: '' });
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add that customer');
    } finally {
      setSaving(false);
    }
  };

  if (!isApiEnabled()) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200/60 py-16 text-center max-w-[1200px]">
        <UserCheck className="h-9 w-9 text-zinc-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-zinc-700">Customers need the API</p>
        <p className="text-xs text-zinc-500 mt-1">The demo store has leads and bookings, but no customer record.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-[1200px]">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Customers</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            Buyers and their KYC. Possession and registration both wait on this.
          </p>
        </div>
        {canManage && (
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors"
          >
            <Plus className="h-4 w-4" /> Add customer
          </button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {([['verified', 'Verified'], ['pending', 'Awaiting KYC'], ['rejected', 'Rejected']] as const).map(([k, lbl]) => {
          const Icon = KYC_ICON[k];
          return (
            <button
              key={k}
              onClick={() => setKycFilter(f => f === k ? 'all' : k)}
              className={`bg-white rounded-2xl border p-4 text-left transition-colors ${
                kycFilter === k ? 'border-indigo-300 ring-2 ring-indigo-500/10' : 'border-zinc-200/60 hover:border-zinc-300'}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <Icon className="h-4 w-4 text-zinc-400" />
                <span className="text-[11px] font-semibold text-zinc-500 uppercase">{lbl}</span>
              </div>
              <p className="text-2xl font-bold text-zinc-900 tabular-nums">{counts[k]}</p>
            </button>
          );
        })}
      </div>

      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        <div className="px-5 py-3 border-b border-zinc-100 flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="h-4 w-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Name, phone or email…"
              className="w-full pl-9 pr-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm"
            />
          </div>
          {kycFilter !== 'all' && (
            <button onClick={() => setKycFilter('all')} className="text-xs font-semibold text-indigo-600 hover:underline">
              Clear filter
            </button>
          )}
        </div>

        {loading ? (
          <div className="py-16 flex justify-center"><Loader2 className="h-6 w-6 text-zinc-300 animate-spin" /></div>
        ) : shown.length === 0 ? (
          <div className="py-16 text-center">
            <UserCheck className="h-9 w-9 text-zinc-200 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">
              {customers.length === 0 ? 'No customers yet' : 'Nothing matches that'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-50">
            {shown.map(c => {
              const kyc = c.kycStatus ?? 'pending';
              const Icon = KYC_ICON[kyc] ?? ShieldQuestion;
              return (
                <div key={c.id} className="px-5 py-3 flex items-center gap-4 flex-wrap">
                  <div className="flex-1 min-w-[180px]">
                    <p className="text-sm font-medium text-zinc-900">{c.name}</p>
                    <p className="text-[11px] text-zinc-400">
                      {[c.phone, c.email].filter(Boolean).join(' · ') || 'No contact details'}
                    </p>
                  </div>
                  <span className={`flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full border capitalize ${
                    KYC_STYLE[kyc] ?? 'bg-zinc-100 text-zinc-600 border-zinc-200'}`}>
                    <Icon className="h-3 w-3" /> {kyc}
                  </span>
                  {canManage && (
                    <select
                      value={kyc} disabled={busyId === c.id}
                      onChange={e => setKyc(c, e.target.value)}
                      className="px-2.5 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs capitalize disabled:opacity-50"
                      aria-label={`KYC status for ${c.name}`}
                    >
                      {KYC_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showNew && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 backdrop-blur-sm p-4"
          onClick={() => setShowNew(false)} role="dialog" aria-modal="true" aria-label="Add customer"
        >
          <form
            onSubmit={create} onClick={e => e.stopPropagation()}
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4"
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900">Add a customer</h3>
                <p className="text-sm text-zinc-500 mt-0.5">KYC starts as pending.</p>
              </div>
              <button type="button" onClick={() => setShowNew(false)} className="p-1.5 rounded-lg hover:bg-zinc-100">
                <X className="h-4 w-4 text-zinc-500" />
              </button>
            </div>

            <label className="block">
              <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Name</span>
              <input
                required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Phone</span>
                <input
                  value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                  className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Email</span>
                <input
                  type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm"
                />
              </label>
            </div>

            <label className="block">
              <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">
                From a lead <span className="normal-case font-normal text-zinc-400">(optional)</span>
              </span>
              <select
                value={form.leadId} onChange={e => setForm(f => ({ ...f, leadId: e.target.value }))}
                className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm"
              >
                <option value="">Not from a lead</option>
                {leads.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <span className="block text-[10px] text-zinc-400 mt-0.5">
                Links the buyer back to the enquiry they came from.
              </span>
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button" onClick={() => setShowNew(false)}
                className="px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-semibold text-zinc-600 hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                type="submit" disabled={saving}
                className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}Add customer
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
