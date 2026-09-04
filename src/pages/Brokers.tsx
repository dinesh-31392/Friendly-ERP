import { useState, useMemo, useEffect } from 'react';
import {
  Handshake, Plus, X, IndianRupee, Users, CheckCircle2, Trash2, Phone, Mail,
  Banknote, FileText, Loader2,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, update, remove, logAudit } from '../services/db';
import {
  isApiEnabled, apiGetBrokers,
  apiGetPayoutRuns, apiGetPayoutRun, apiBuildPayoutRun, apiSetPayoutRunStatus, apiPayoutRunPdf,
  type ApiPayoutRun,
} from '../services/apiClient';
import { createBroker, patchBroker, deleteBroker } from '../services/brokerWrites';
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

  const [tab, setTab] = useState<'partners' | 'commissions' | 'payouts'>('partners');

  // Payout runs. Every figure on screen comes from the server — the TDS rules
  // are not something to reimplement in a browser.
  const [runs, setRuns] = useState<ApiPayoutRun[]>([]);
  const [openRun, setOpenRun] = useState<ApiPayoutRun | null>(null);
  const [runBusy, setRunBusy] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  // Defaults to the month just gone, which is when a payout run is actually done.
  const [periodStart, setPeriodStart] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 1, 1);
    return d.toISOString().slice(0, 10);
  });
  const [periodEnd, setPeriodEnd] = useState(() => {
    const d = new Date(); d.setDate(0);
    return d.toISOString().slice(0, 10);
  });
  const [defaultGstPct, setDefaultGstPct] = useState(18);

  useEffect(() => {
    if (!isApiEnabled()) return;
    let cancelled = false;
    apiGetPayoutRuns()
      .then(r => { if (!cancelled) setRuns(r); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [tenantId, refreshKey]);

  const buildRun = async () => {
    setBuilding(true);
    try {
      const run = await apiBuildPayoutRun({ periodStart, periodEnd, defaultGstPct });
      // An empty run is the normal result of re-running a period, not a
      // failure — say so, rather than leaving someone wondering.
      toast.success(run.lines.length
        ? `Run #${run.runNo} built — ${run.lines.length} partner(s)`
        : `Run #${run.runNo} is empty — every commission in that period is already on a run`);
      refresh();
      setOpenRun(await apiGetPayoutRun(run.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not build the run');
    } finally {
      setBuilding(false);
    }
  };

  const openRunDetail = async (id: string) => {
    try { setOpenRun(await apiGetPayoutRun(id)); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not open the run'); }
  };

  const setRunStatus = async (id: string, status: 'approved' | 'cancelled') => {
    try {
      await apiSetPayoutRunStatus(id, status);
      toast.success(`Run ${status}`);
      if (openRun?.id === id) setOpenRun(await apiGetPayoutRun(id));
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the run');
    }
  };

  const payRun = async (id: string) => {
    // The server refuses a payout without one, because a payment nobody can
    // find in a bank statement is not evidence of anything.
    const ref = prompt('Payment reference (UTR, cheque number, or transaction id):')?.trim();
    if (!ref) return;
    try {
      await apiSetPayoutRunStatus(id, 'paid', ref);
      toast.success('Run marked paid — the commissions are settled');
      if (openRun?.id === id) setOpenRun(await apiGetPayoutRun(id));
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record the payment');
    }
  };

  const openAdvice = async (id: string) => {
    setRunBusy(id);
    try {
      const { url } = await apiPayoutRunPdf(id);
      window.open(url, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not render the advice');
    } finally {
      setRunBusy(null);
    }
  };
  const [showAdd, setShowAdd] = useState(false);

  // Feature flag: with an API URL configured, brokers are read from the Fastify
  // backend (RLS-scoped; leadsReferred/bookingsClosed derived server-side).
  // Falls back to localStorage on any API failure. Flag off → unchanged.
  const [apiBrokers, setApiBrokers] = useState<Broker[] | null>(null);
  useEffect(() => {
    if (!isApiEnabled()) { setApiBrokers(null); return; }
    let cancelled = false;
    apiGetBrokers()
      .then(rows => { if (!cancelled) setApiBrokers(rows); })
      .catch(() => {
        if (!cancelled) {
          setApiBrokers(null);
          toast.error('API unreachable — showing local data', { id: 'api-fallback' });
        }
      });
    return () => { cancelled = true; };
  }, [tenantId, refreshKey]);

  const brokers = useMemo(
    () => (apiBrokers ?? getByTenant<Broker>('brokers', tenantId))
      .slice().sort((a, b) => b.bookingsClosed - a.bookingsClosed),
    [apiBrokers, tenantId, refreshKey]
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

  const handleAdd = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = fd.get('name') as string;
    const phone = fd.get('phone') as string;
    if (!name || !phone) { toast.error('Name and phone are required'); return; }
    let created: Broker;
    try {
      created = await createBroker({
        tenantId, name,
        firm: (fd.get('firm') as string) || '',
        phone, email: (fd.get('email') as string) || '',
        reraId: (fd.get('reraId') as string) || '',
        commissionRate: Number(fd.get('commissionRate')) || 2,
        // Counters are derived server-side; the demo store ignores these too.
        leadsReferred: 0, bookingsClosed: 0,
        status: 'active', createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not onboard partner');
      return;
    }
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

  const handleToggleStatus = async (b: Broker) => {
    if (!canManage) { toast.error('No permission'); return; }
    const next = b.status === 'active' ? 'inactive' : 'active';
    try {
      await patchBroker(b.id, { status: next });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update partner');
      return;
    }
    syncPartnerPortalAccess(b.id, next === 'active' ? 'activate' : 'deactivate');
    audit('update', b.id, `Partner "${b.name}" set to ${next} (portal access ${next === 'active' ? 'restored' : 'suspended'})`);
    refresh();
    toast.success(`Partner ${next === 'active' ? 'activated' : 'deactivated'}`);
  };

  const handleDelete = async (b: Broker) => {
    if (!canManage) { toast.error('No permission'); return; }
    if (!confirm(`Remove partner "${b.name}"? Their portal login will be revoked; commission history is kept.`)) return;
    try {
      await deleteBroker(b.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove partner');
      return;
    }
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
        {([['partners', 'Partners'], ['commissions', 'Commissions'], ['payouts', 'Payout Runs']] as const).map(([id, label]) => (
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
                    <span className="text-sm font-bold text-indigo-600">{(b.name ?? '').split(' ').filter(Boolean).map(n => n[0]).join('').slice(0, 2) || '?'}</span>
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
                    onClick={async () => {
                      if (!b.email) { toast.error('Add an email for this partner first'); return; }
                      if (b.status !== 'active') { toast.error('Activate this partner before granting portal access'); return; }
                      if (!user || !tenant) return;
                      let creds;
                      try {
                        creds = await invitePartner(tenantId, b, { id: user.id, name: user.name });
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : 'Could not grant portal access');
                        return;
                      }
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

      {tab === 'payouts' && (
        <div className="space-y-4">
          {!isApiEnabled() ? (
            <div className="bg-white rounded-2xl border border-zinc-200/60 py-14 text-center">
              <Banknote className="h-10 w-10 text-zinc-200 mx-auto mb-2" />
              <p className="text-sm font-medium text-zinc-600">Payout runs need the API</p>
              <p className="text-xs text-zinc-400 mt-1 max-w-sm mx-auto">
                The 194-H deduction depends on the financial-year aggregate across every earlier
                run, so it is computed on the server and has no local-only version.
              </p>
            </div>
          ) : (
            <>
              {canManage && (
                <div className="bg-white rounded-2xl border border-zinc-200/60 p-4 flex items-end gap-3 flex-wrap">
                  <div>
                    <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">From</label>
                    <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)}
                      className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">To</label>
                    <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)}
                      className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">GST %</label>
                    <input type="number" min={0} max={100} value={defaultGstPct}
                      onChange={e => setDefaultGstPct(Number(e.target.value))}
                      className="w-20 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm tabular-nums" />
                    <p className="text-[10px] text-zinc-400 mt-0.5">18 if registered</p>
                  </div>
                  <button onClick={buildRun} disabled={building}
                    className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60">
                    {building && <Loader2 className="h-4 w-4 animate-spin" />}{building ? 'Building…' : 'Build run'}
                  </button>
                  <p className="text-[11px] text-zinc-400 basis-full">
                    Commissions already on a run are never picked up twice, so re-running a period is safe.
                  </p>
                </div>
              )}

              <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
                {runs.length === 0 ? (
                  <div className="py-14 text-center">
                    <Banknote className="h-10 w-10 text-zinc-200 mx-auto mb-2" />
                    <p className="text-sm font-medium text-zinc-600">No payout runs yet</p>
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-50">
                    {runs.map(r => (
                      <div key={r.id} className="px-5 py-3 flex items-center gap-4 flex-wrap">
                        <button onClick={() => openRunDetail(r.id)} className="text-sm font-semibold text-indigo-600 hover:underline">
                          Run #{r.runNo}
                        </button>
                        <div className="flex-1 min-w-[160px]">
                          <p className="text-[11px] text-zinc-400">
                            {r.periodStart?.slice(0, 10)} → {r.periodEnd?.slice(0, 10)} · {r.lines?.length ?? 0} partner(s)
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold text-zinc-900 tabular-nums">{formatCurrency(r.netTotal, currency)}</p>
                          <p className="text-[11px] text-zinc-400 tabular-nums">
                            {formatCurrency(r.grossTotal, currency)} brokerage
                            {r.gstTotal > 0 && ` + ${formatCurrency(r.gstTotal, currency)} GST`}
                            {r.tdsTotal > 0 && ` − ${formatCurrency(r.tdsTotal, currency)} TDS`}
                          </p>
                        </div>
                        <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize ${
                          r.status === 'paid' ? 'bg-emerald-50 text-emerald-700'
                          : r.status === 'approved' ? 'bg-blue-50 text-blue-700'
                          : r.status === 'cancelled' ? 'bg-red-50 text-red-600'
                          : 'bg-zinc-100 text-zinc-600'}`}>{r.status}</span>
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => openAdvice(r.id)} disabled={runBusy === r.id}
                            className="flex items-center gap-1 px-2.5 py-1.5 border border-zinc-200 rounded-lg text-[11px] font-semibold text-zinc-600 hover:bg-zinc-50 disabled:opacity-50">
                            {runBusy === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />} Advice
                          </button>
                          {canManage && r.status === 'draft' && (
                            <button onClick={() => setRunStatus(r.id, 'approved')}
                              className="px-2.5 py-1.5 bg-indigo-600 text-white rounded-lg text-[11px] font-semibold hover:bg-indigo-700">Approve</button>
                          )}
                          {canManage && r.status === 'approved' && (
                            <button onClick={() => payRun(r.id)}
                              className="px-2.5 py-1.5 bg-emerald-600 text-white rounded-lg text-[11px] font-semibold hover:bg-emerald-700">Mark paid</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {openRun && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex justify-end" onClick={() => setOpenRun(null)}>
          <div className="bg-white w-full max-w-2xl h-full overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900">Payout run #{openRun.runNo}</h3>
                <p className="text-sm text-zinc-500">
                  {openRun.periodStart?.slice(0, 10)} → {openRun.periodEnd?.slice(0, 10)} · TDS {openRun.tdsPct}% over {formatCurrency(openRun.tdsThreshold, currency)} per financial year
                </p>
              </div>
              <button onClick={() => setOpenRun(null)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>

            {openRun.lines.length === 0 ? (
              <p className="text-sm text-zinc-500 py-8 text-center">
                Nothing to pay for this period — every commission in it is already on a run.
              </p>
            ) : (
              <div className="space-y-3">
                {openRun.lines.map(l => (
                  <div key={l.id} className="rounded-xl border border-zinc-200 p-3">
                    <div className="flex items-baseline justify-between mb-1.5">
                      <p className="text-sm font-medium text-zinc-900">
                        {l.brokerName}{l.agencyName && <span className="text-zinc-400 font-normal"> · {l.agencyName}</span>}
                      </p>
                      <p className="text-sm font-semibold tabular-nums">{formatCurrency(l.netAmount, currency)}</p>
                    </div>
                    <div className="space-y-0.5 text-[12px] text-zinc-500">
                      <div className="flex justify-between"><span>Brokerage</span><span className="tabular-nums">{formatCurrency(l.grossAmount, currency)}</span></div>
                      {l.gstAmount > 0 && (
                        <div className="flex justify-between"><span>GST @ {l.gstPct}%</span><span className="tabular-nums">{formatCurrency(l.gstAmount, currency)}</span></div>
                      )}
                      {l.tdsAmount > 0 && (
                        <div className="flex justify-between"><span>Less: TDS u/s 194-H @ {l.tdsPct}%</span><span className="tabular-nums">({formatCurrency(l.tdsAmount, currency)})</span></div>
                      )}
                      {/* The catch-up is the figure a broker will query. Show
                          the basis rather than making them work it out. */}
                      {l.fyPriorGross > 0 && l.tdsAmount > 0 && (
                        <p className="text-[11px] text-zinc-400 pt-0.5">
                          Computed on the year-to-date aggregate of {formatCurrency(l.fyPriorGross + l.grossAmount, currency)}
                          {l.fyPriorTds > 0 && `, less ${formatCurrency(l.fyPriorTds, currency)} already deducted`}.
                        </p>
                      )}
                      {l.tdsAmount === 0 && l.grossAmount > 0 && (
                        <p className="text-[11px] text-zinc-400 pt-0.5">
                          Below the {formatCurrency(openRun.tdsThreshold, currency)} threshold for the year — no deduction.
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <button onClick={() => openAdvice(openRun.id)}
              className="w-full mt-5 flex items-center justify-center gap-2 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-semibold text-zinc-700 hover:bg-zinc-50">
              <FileText className="h-4 w-4" /> Open the payment advice
            </button>
          </div>
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
