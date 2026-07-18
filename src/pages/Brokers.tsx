import { useState, useMemo, useEffect } from 'react';
import {
  Handshake, Plus, X, IndianRupee, Users, CheckCircle2, Trash2, Phone, Mail,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, create, update, remove, logAudit } from '../services/db';
import { formatCurrency } from '../utils/format';
import { invitePartner, portalPath } from '../services/portalService';
import type { Broker, Commission, PortalUser } from '../types';
import toast from 'react-hot-toast';

const commissionStatusColors: Record<Commission['status'], string> = {
  pending: 'bg-amber-50 text-amber-700',
  approved: 'bg-indigo-50 text-indigo-700',
  paid: 'bg-emerald-50 text-emerald-700',
};

export default function Brokers() {
  const { user, tenant, hasPermission } = useAuth();
  const tenantId = tenant?.id || '';
  const currency = tenant?.currency || 'INR';
  const canManage = hasPermission('manage_brokers');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  const [tab, setTab] = useState<'partners' | 'commissions'>('partners');
  const [showAdd, setShowAdd] = useState(false);

  const brokers = useMemo(
    () => getByTenant<Broker>('brokers', tenantId).sort((a, b) => b.bookingsClosed - a.bookingsClosed),
    [tenantId, refreshKey]
  );
  const commissions = useMemo(
    () => getByTenant<Commission>('commissions', tenantId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [tenantId, refreshKey]
  );

  // Deep linking: listen to search query focus events
  useEffect(() => {
    const focusId = localStorage.getItem('friendly_crm_focus_partner');
    if (focusId) {
      setTab('partners');
      const target = brokers.find(b => b.id === focusId);
      if (target) {
        toast.success(`Focused partner: ${target.name}`);
      }
      localStorage.removeItem('friendly_crm_focus_partner');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const totalPayout = commissions.filter(c => c.status === 'paid').reduce((s, c) => s + c.amount, 0);
  const pendingPayout = commissions.filter(c => c.status !== 'paid').reduce((s, c) => s + c.amount, 0);
  const totalReferred = brokers.reduce((s, b) => s + b.leadsReferred, 0);

  const audit = (action: string, id: string, details: string) => {
    if (!user) return;
    logAudit({ tenantId, userId: user.id, userName: user.name, action, entity: 'broker', entityId: id, details });
  };

  const handleAdd = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = fd.get('name') as string;
    const phone = fd.get('phone') as string;
    if (!name || !phone) { toast.error('Name and phone are required'); return; }
    const created = create<Broker>('brokers', {
      id: '', tenantId, name,
      firm: (fd.get('firm') as string) || '',
      phone, email: (fd.get('email') as string) || '',
      reraId: (fd.get('reraId') as string) || '',
      commissionRate: Number(fd.get('commissionRate')) || 2,
      leadsReferred: 0, bookingsClosed: 0,
      status: 'active', createdAt: new Date().toISOString(),
    });
    audit('create', created.id, `Onboarded channel partner "${name}"`);
    setShowAdd(false);
    refresh();
    toast.success('Channel partner onboarded');
  };

  // A partner's portal login must track their broker record: deactivating
  // suspends it, deleting revokes it — otherwise removed partners keep
  // working credentials forever
  const syncPartnerPortalAccess = (brokerId: string, mode: 'activate' | 'deactivate' | 'revoke') => {
    const account = getByTenant<PortalUser>('portalUsers', tenantId).find(p => p.brokerId === brokerId);
    if (!account) return;
    if (mode === 'revoke') remove('portalUsers', account.id);
    else update<PortalUser>('portalUsers', account.id, { active: mode === 'activate' });
  };

  const handleToggleStatus = (b: Broker) => {
    if (!canManage) { toast.error('No permission'); return; }
    const next = b.status === 'active' ? 'inactive' : 'active';
    update<Broker>('brokers', b.id, { status: next });
    syncPartnerPortalAccess(b.id, next === 'active' ? 'activate' : 'deactivate');
    audit('update', b.id, `Partner "${b.name}" set to ${next} (portal access ${next === 'active' ? 'restored' : 'suspended'})`);
    refresh();
    toast.success(`Partner ${next === 'active' ? 'activated' : 'deactivated'}`);
  };

  const handleDelete = (b: Broker) => {
    if (!canManage) { toast.error('No permission'); return; }
    if (!confirm(`Remove partner "${b.name}"? Their portal login will be revoked; commission history is kept.`)) return;
    remove('brokers', b.id);
    syncPartnerPortalAccess(b.id, 'revoke');
    audit('delete', b.id, `Removed channel partner "${b.name}" and revoked portal access`);
    refresh();
    toast.success('Partner removed and portal access revoked');
  };

  const handleCommissionStatus = (c: Commission, status: Commission['status']) => {
    if (!canManage) { toast.error('No permission'); return; }
    update<Commission>('commissions', c.id, { status });
    audit(status === 'paid' ? 'pay' : 'update', c.id, `Commission for ${c.brokerName} (${c.leadName}) marked ${status}`);
    refresh();
    toast.success(`Commission marked ${status}`);
  };

  return (
    <div className="space-y-6 max-w-[1200px]">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Channel Partners</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Broker onboarding, contribution tracking, and commission payouts.</p>
        </div>
        {canManage && (
          <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm">
            <Plus className="h-4 w-4" /> Onboard Partner
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Active Partners', value: brokers.filter(b => b.status === 'active').length, icon: Handshake, color: 'text-indigo-600' },
          { label: 'Leads Referred', value: totalReferred, icon: Users, color: 'text-violet-600' },
          { label: 'Paid Out', value: formatCurrency(totalPayout, currency), icon: CheckCircle2, color: 'text-emerald-600' },
          { label: 'Pending Payout', value: formatCurrency(pendingPayout, currency), icon: IndianRupee, color: 'text-amber-600' },
        ].map((s, i) => (
          <div key={i} className="bg-white rounded-2xl border border-zinc-200/60 p-4">
            <div className="flex items-center gap-2 mb-2">
              <s.icon className={`h-5 w-5 ${s.color}`} />
              <span className="text-[11px] font-medium text-zinc-500">{s.label}</span>
            </div>
            <p className="text-xl font-bold text-zinc-900">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 bg-white border border-zinc-200 rounded-xl p-1 inline-flex">
        {([['partners', 'Partners'], ['commissions', 'Commissions']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === id ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
          >{label}</button>
        ))}
      </div>

      {tab === 'partners' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {brokers.map(b => (
            <div key={b.id} className={`bg-white rounded-2xl border border-zinc-200/60 p-4 ${b.status === 'inactive' ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-indigo-50 to-violet-50 flex items-center justify-center">
                    <span className="text-sm font-bold text-indigo-600">{b.name.split(' ').map(n => n[0]).join('')}</span>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">{b.name}</p>
                    <p className="text-xs text-zinc-500">{b.firm}{b.reraId ? ` · ${b.reraId}` : ''}</p>
                  </div>
                </div>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${b.status === 'active' ? 'bg-emerald-50 text-emerald-600' : 'bg-zinc-100 text-zinc-500'}`}>{b.status}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 mb-3">
                <div className="bg-zinc-50 rounded-lg p-2 text-center"><p className="text-sm font-bold text-zinc-900">{b.leadsReferred}</p><p className="text-[10px] text-zinc-500">Referred</p></div>
                <div className="bg-zinc-50 rounded-lg p-2 text-center"><p className="text-sm font-bold text-zinc-900">{b.bookingsClosed}</p><p className="text-[10px] text-zinc-500">Closed</p></div>
                <div className="bg-zinc-50 rounded-lg p-2 text-center"><p className="text-sm font-bold text-zinc-900">{b.commissionRate}%</p><p className="text-[10px] text-zinc-500">Rate</p></div>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-zinc-500 mb-3 flex-wrap">
                <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {b.phone}</span>
                {b.email && <span className="flex items-center gap-1"><Mail className="h-3 w-3" /> {b.email}</span>}
              </div>
              {canManage && (
                <div className="flex gap-2 pt-2 border-t border-zinc-100">
                  <button
                    onClick={() => {
                      if (!b.email) { toast.error('Add an email for this partner first'); return; }
                      if (b.status !== 'active') { toast.error('Activate this partner before granting portal access'); return; }
                      if (!user || !tenant) return;
                      const creds = invitePartner(tenantId, b, { id: user.id, name: user.name });
                      const shareText = `Your ${tenant.name} partner portal access:\n${window.location.origin}${portalPath(tenant)}\nEmail: ${creds.email}\nPassword: ${creds.password}`;
                      navigator.clipboard?.writeText(shareText).catch(() => {});
                      toast.success(
                        `Partner portal ${creds.isNew ? 'access created' : 'password reset'} for ${b.name}\n${creds.email} / ${creds.password}\n(copied to clipboard)`,
                        { duration: 10000 }
                      );
                      refresh();
                    }}
                    className="flex-1 py-1.5 rounded-lg text-xs font-semibold text-indigo-600 hover:bg-indigo-50 transition-colors"
                  >
                    🔑 Portal Login
                  </button>
                  <button onClick={() => handleToggleStatus(b)} className="flex-1 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition-colors">
                    {b.status === 'active' ? 'Deactivate' : 'Activate'}
                  </button>
                  <button onClick={() => handleDelete(b)} className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 transition-colors">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          ))}
          {brokers.length === 0 && (
            <div className="col-span-2 py-16 text-center bg-white rounded-2xl border border-zinc-200/60">
              <Handshake className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
              <h3 className="text-sm font-semibold text-zinc-700">No channel partners yet</h3>
            </div>
          )}
        </div>
      )}

      {tab === 'commissions' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          {commissions.length === 0 ? (
            <div className="py-16 text-center text-sm text-zinc-400">No commissions recorded</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-zinc-50/50 border-b border-zinc-100">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Partner</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Booking</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Value</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Rate</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Commission</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {commissions.map(c => (
                    <tr key={c.id} className="border-b border-zinc-50 hover:bg-zinc-50/30 transition-colors">
                      <td className="px-4 py-3 text-sm font-medium text-zinc-900">{c.brokerName}</td>
                      <td className="px-4 py-3 text-sm text-zinc-600">{c.leadName} · {c.project}</td>
                      <td className="px-4 py-3 text-sm text-zinc-600 text-right">{formatCurrency(c.bookingValue, currency)}</td>
                      <td className="px-4 py-3 text-sm text-zinc-600 text-center">{c.rate}%</td>
                      <td className="px-4 py-3 text-sm font-semibold text-zinc-900 text-right">{formatCurrency(c.amount, currency)}</td>
                      <td className="px-4 py-3 text-center">
                        <select
                          value={c.status}
                          disabled={!canManage}
                          onChange={e => handleCommissionStatus(c, e.target.value as Commission['status'])}
                          className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border-0 capitalize ${commissionStatusColors[c.status]} ${canManage ? 'cursor-pointer' : 'cursor-not-allowed opacity-80'}`}
                        >
                          <option value="pending">Pending</option>
                          <option value="approved">Approved</option>
                          <option value="paid">Paid</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">Onboard Channel Partner</h3>
              <button onClick={() => setShowAdd(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAdd} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Name *</label>
                  <input name="name" required placeholder="Full name" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Firm</label>
                  <input name="firm" placeholder="Agency name" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">RERA ID</label>
                  <input name="reraId" placeholder="RERA/A/0000" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Phone *</label>
                  <input name="phone" required placeholder="+91 99999..." className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Email</label>
                  <input name="email" type="email" placeholder="email@firm.com" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Commission %</label>
                  <input name="commissionRate" type="number" step="0.25" defaultValue={2} className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowAdd(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Onboard</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
