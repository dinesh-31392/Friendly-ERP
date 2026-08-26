import { useState, useEffect, useMemo } from 'react';
import {
  KeyRound, Plus, X, FileText, Loader2, AlertTriangle, CheckCircle2,
  Search, Wrench, ShieldAlert,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  isApiEnabled, apiGetPossessions, apiGetPossession, apiOfferPossession,
  apiUpdatePossession, apiRaiseSnag, apiUpdateSnag, apiPossessionPdf, apiGetBookings,
} from '../services/apiClient';
import type { ApiPossession, SnagSeverity, SnagCategory } from '../services/apiClient';
import { formatCurrency } from '../utils/format';
import toast from 'react-hot-toast';

/**
 * Possession — the handover desk.
 *
 * Two numbers do all the work here, and both come from the server: how many
 * MAJOR or CRITICAL snags are open, and how much is still owed. They are shown
 * before the button is pressed rather than surfaced as a rejection afterwards,
 * because this screen is used at a site office with a family standing in front
 * of it waiting for their keys.
 */

const STATUS_STYLES: Record<string, string> = {
  offered: 'bg-blue-50 text-blue-700',
  inspected: 'bg-amber-50 text-amber-700',
  accepted: 'bg-emerald-50 text-emerald-700',
  withdrawn: 'bg-zinc-100 text-zinc-500',
};

const SEVERITY_STYLES: Record<SnagSeverity, string> = {
  minor: 'bg-zinc-100 text-zinc-600',
  major: 'bg-amber-50 text-amber-700',
  critical: 'bg-red-50 text-red-600',
};

const CATEGORIES: SnagCategory[] = [
  'civil', 'plumbing', 'electrical', 'carpentry', 'painting', 'flooring', 'fittings', 'other',
];

export default function Possession() {
  const { tenant, hasPermission } = useAuth();
  const currency = tenant?.currency || 'INR';
  const canManage = hasPermission('manage_bookings');

  const [rows, setRows] = useState<ApiPossession[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ApiPossession | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [showOffer, setShowOffer] = useState(false);
  const [bookings, setBookings] = useState<Array<{ id: string; leadId?: string; unitId?: string }>>([]);
  const [bookingId, setBookingId] = useState('');
  const [ocReference, setOcReference] = useState('');
  const [ocDatedOn, setOcDatedOn] = useState('');
  const [offering, setOffering] = useState(false);

  const [snagText, setSnagText] = useState('');
  const [snagLocation, setSnagLocation] = useState('');
  const [snagCategory, setSnagCategory] = useState<SnagCategory>('civil');
  const [snagSeverity, setSnagSeverity] = useState<SnagSeverity>('minor');

  useEffect(() => {
    if (!isApiEnabled()) { setLoading(false); return; }
    let cancelled = false;
    apiGetPossessions()
      .then(r => { if (!cancelled) setRows(r); })
      .catch(() => { if (!cancelled) toast.error('Could not load possessions', { id: 'ps-load' }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  useEffect(() => {
    if (!showOffer || !isApiEnabled()) return;
    let cancelled = false;
    apiGetBookings().then(b => { if (!cancelled) setBookings((b as typeof bookings) ?? []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [showOffer]);

  const filtered = useMemo(() => rows.filter(p => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (p.customerName ?? '').toLowerCase().includes(q)
      || (p.unitCode ?? '').toLowerCase().includes(q)
      || (p.projectName ?? '').toLowerCase().includes(q)
      || p.ocReference.toLowerCase().includes(q);
  }), [rows, search]);

  const open = async (id: string) => {
    try { setSelected(await apiGetPossession(id)); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not open'); }
  };

  const offer = async () => {
    if (!bookingId || !ocReference.trim()) {
      toast.error('A booking and an occupancy certificate reference are both required');
      return;
    }
    setOffering(true);
    try {
      const p = await apiOfferPossession({
        bookingId, ocReference: ocReference.trim(), ocDatedOn: ocDatedOn || undefined,
      });
      toast.success('Possession offered');
      setShowOffer(false); setBookingId(''); setOcReference(''); setOcDatedOn('');
      refresh();
      setSelected(await apiGetPossession(p.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not offer possession');
    } finally {
      setOffering(false);
    }
  };

  /**
   * Hand over the keys.
   *
   * The gates are enforced server-side; this asks first when they are going to
   * fire, so the override is a decision someone makes rather than a retry they
   * discover. What is overridden ends up frozen on the record either way.
   */
  const accept = async (p: ApiPossession) => {
    const who = prompt('Who is taking possession? (full name, as signed)')?.trim();
    if (!who) return;

    let force = false;
    const dues = Number(p.duesNow ?? 0);
    if (p.blockingSnags > 0 || dues > 0.009) {
      const reasons = [
        p.blockingSnags > 0 && `${p.blockingSnags} major or critical snag(s) still open`,
        dues > 0.009 && `${formatCurrency(dues, currency)} still outstanding`,
      ].filter(Boolean).join(' and ');
      force = confirm(
        `Hand over anyway?\n\n${reasons}.\n\n`
        + 'The outstanding balance will be recorded on the handover acknowledgement '
        + 'and the developer\'s right to recover it reserved.');
      if (!force) return;
    }

    setBusyId(p.id);
    try {
      await apiUpdatePossession(p.id, { status: 'accepted', receivedBy: who, force });
      toast.success('Possession handed over');
      if (selected?.id === p.id) setSelected(await apiGetPossession(p.id));
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record the handover');
    } finally {
      setBusyId(null);
    }
  };

  const addSnag = async () => {
    if (!selected || !snagText.trim()) return;
    try {
      await apiRaiseSnag(selected.id, {
        description: snagText.trim(), location: snagLocation.trim() || undefined,
        category: snagCategory, severity: snagSeverity,
      });
      setSnagText(''); setSnagLocation('');
      setSelected(await apiGetPossession(selected.id));
      refresh();
      toast.success('Snag recorded');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record the snag');
    }
  };

  const resolveSnag = async (snagId: string) => {
    // The server refuses a resolution with no account of it — a snag list of
    // unexplained "resolved" is a list of claims nobody can check.
    const how = prompt('How was it resolved?')?.trim();
    if (!how) return;
    try {
      await apiUpdateSnag(snagId, { status: 'resolved', resolution: how });
      if (selected) setSelected(await apiGetPossession(selected.id));
      refresh();
      toast.success('Snag resolved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not resolve the snag');
    }
  };

  const openPdf = async (id: string) => {
    setBusyId(id);
    try {
      const { url } = await apiPossessionPdf(id);
      window.open(url, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not render the letter');
    } finally {
      setBusyId(null);
    }
  };

  if (!isApiEnabled()) {
    return (
      <div className="max-w-[1200px]">
        <div className="bg-white rounded-2xl border border-zinc-200/60 py-16 flex flex-col items-center text-center">
          <AlertTriangle className="h-10 w-10 text-amber-400 mb-3" />
          <h3 className="text-sm font-semibold text-zinc-700">Possession needs the API</h3>
          <p className="text-xs text-zinc-500 mt-1 max-w-sm">
            The handover gates read live receipts and the open snag list, so there is
            deliberately no local-only version of this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-[1200px]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Possession &amp; Handover</h2>
          <p className="text-sm text-zinc-500 mt-0.5">
            Offer, inspect, snag, hand over — with the dues and the open defects in view.
          </p>
        </div>
        {canManage && (
          <button onClick={() => setShowOffer(true)} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">
            <Plus className="h-4 w-4" /> Offer Possession
          </button>
        )}
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by customer, unit or OC..."
          className="w-full pl-9 pr-4 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        />
      </div>

      {loading ? (
        <div className="bg-white rounded-2xl border border-zinc-200/60 py-16 flex justify-center">
          <Loader2 className="h-6 w-6 text-zinc-300 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-zinc-200/60 py-16 flex flex-col items-center">
          <KeyRound className="h-12 w-12 text-zinc-300 mb-3" />
          <h3 className="text-sm font-semibold text-zinc-700">No possessions yet</h3>
          <p className="text-xs text-zinc-500 mt-1">Offer possession once the occupancy certificate is in hand.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-zinc-200/60 divide-y divide-zinc-50">
          {filtered.map(p => {
            const dues = Number(p.duesNow ?? 0);
            const blocked = p.status !== 'accepted' && (p.blockingSnags > 0 || dues > 0.009);
            return (
              <div key={p.id} className="px-5 py-3 flex items-center gap-4 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <button onClick={() => open(p.id)} className="text-sm font-semibold text-zinc-900 hover:text-indigo-600 hover:underline text-left">
                    {p.customerName ?? 'Allottee'}
                  </button>
                  <p className="text-[11px] text-zinc-400">
                    {[p.projectName, p.unitCode].filter(Boolean).join(' — ') || '—'} · OC {p.ocReference}
                  </p>
                </div>

                {/* Both gates, before the button rather than after the refusal. */}
                <div className="flex items-center gap-3 text-[11px]">
                  {p.blockingSnags > 0 ? (
                    <span className="flex items-center gap-1 text-red-600 font-medium">
                      <ShieldAlert className="h-3.5 w-3.5" />{p.blockingSnags} blocking
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-emerald-600">
                      <CheckCircle2 className="h-3.5 w-3.5" />snags clear
                    </span>
                  )}
                  {p.status === 'accepted'
                    ? Number(p.duesOutstanding) > 0.009 && (
                        <span className="text-red-600 font-medium tabular-nums">
                          {formatCurrency(p.duesOutstanding, currency)} owing at handover
                        </span>
                      )
                    : dues > 0.009 && (
                        <span className="text-amber-600 font-medium tabular-nums">
                          {formatCurrency(dues, currency)} outstanding
                        </span>
                      )}
                </div>

                <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize ${STATUS_STYLES[p.status] ?? 'bg-zinc-100'}`}>
                  {p.status}
                </span>

                <div className="flex items-center gap-1.5">
                  <button onClick={() => openPdf(p.id)} disabled={busyId === p.id}
                    className="flex items-center gap-1 px-2.5 py-1.5 border border-zinc-200 rounded-lg text-[11px] font-semibold text-zinc-600 hover:bg-zinc-50 disabled:opacity-50">
                    {busyId === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
                    {p.status === 'accepted' ? 'Acknowledgement' : 'Offer letter'}
                  </button>
                  {canManage && p.status !== 'accepted' && p.status !== 'withdrawn' && (
                    <button onClick={() => accept(p)} disabled={busyId === p.id}
                      className={`px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-white disabled:opacity-50 ${blocked ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
                      {blocked ? 'Hand over anyway' : 'Hand over'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Detail drawer ─────────────────────────────────────────────────── */}
      {selected && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex justify-end" onClick={() => setSelected(null)}>
          <div className="bg-white w-full max-w-2xl h-full overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-1">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900">{selected.customerName ?? 'Allottee'}</h3>
                <p className="text-sm text-zinc-500">
                  {[selected.projectName, selected.unitCode].filter(Boolean).join(' — ') || '—'} · OC {selected.ocReference}
                </p>
              </div>
              <button onClick={() => setSelected(null)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <p className="text-[11px] text-zinc-400 mb-4">
              Offered {selected.offeredOn?.slice(0, 10)}
              {selected.inspectedOn && ` · inspected ${selected.inspectedOn.slice(0, 10)}`}
              {selected.acceptedOn && ` · handed over ${selected.acceptedOn.slice(0, 10)} to ${selected.receivedBy}`}
            </p>

            {canManage && selected.status !== 'accepted' && (
              <div className="rounded-xl border border-zinc-200 p-3 mb-4 space-y-2">
                <p className="text-[11px] font-semibold text-zinc-500 uppercase">Raise a snag</p>
                <input value={snagText} onChange={e => setSnagText(e.target.value)}
                  placeholder="What is wrong?"
                  className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm" />
                <div className="grid grid-cols-4 gap-2">
                  <input value={snagLocation} onChange={e => setSnagLocation(e.target.value)}
                    placeholder="Where?" className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm" />
                  <select value={snagCategory} onChange={e => setSnagCategory(e.target.value as SnagCategory)}
                    className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm capitalize">
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <select value={snagSeverity} onChange={e => setSnagSeverity(e.target.value as SnagSeverity)}
                    className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm capitalize">
                    <option value="minor">minor</option>
                    <option value="major">major</option>
                    <option value="critical">critical</option>
                  </select>
                  <button onClick={addSnag} disabled={!snagText.trim()}
                    className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50">Add</button>
                </div>
                <p className="text-[10px] text-zinc-400">
                  Minor snags do not block handover. Major and critical ones do.
                </p>
              </div>
            )}

            {selected.snags.length === 0 ? (
              <p className="text-sm text-zinc-400 py-6 text-center">No snags recorded.</p>
            ) : (
              <div className="space-y-2">
                {selected.snags.map(s => (
                  <div key={s.id} className="rounded-xl border border-zinc-200 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-zinc-900">{s.description}</p>
                        <p className="text-[11px] text-zinc-400 capitalize">
                          {[s.location, s.category].filter(Boolean).join(' · ')}
                          {s.resolvedOn && ` · resolved ${s.resolvedOn.slice(0, 10)}`}
                        </p>
                        {s.resolution && <p className="text-[11px] text-zinc-500 mt-1">{s.resolution}</p>}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase ${SEVERITY_STYLES[s.severity]}`}>
                          {s.severity}
                        </span>
                        {canManage && (s.status === 'open' || s.status === 'in_progress') && (
                          <button onClick={() => resolveSnag(s.id)}
                            className="flex items-center gap-1 px-2 py-1 border border-zinc-200 rounded-lg text-[11px] font-semibold text-zinc-600 hover:bg-zinc-50">
                            <Wrench className="h-3 w-3" /> Resolve
                          </button>
                        )}
                        {s.status === 'resolved' && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <button onClick={() => openPdf(selected.id)}
              className="w-full mt-5 flex items-center justify-center gap-2 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-semibold text-zinc-700 hover:bg-zinc-50">
              <FileText className="h-4 w-4" />
              {selected.status === 'accepted' ? 'Open the handover acknowledgement' : 'Open the offer letter'}
            </button>
          </div>
        </div>
      )}

      {/* ── Offer possession ──────────────────────────────────────────────── */}
      {showOffer && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowOffer(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">Offer possession</h3>
              <button onClick={() => setShowOffer(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Booking</label>
                <select value={bookingId} onChange={e => setBookingId(e.target.value)}
                  className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm">
                  <option value="">Select a booking…</option>
                  {bookings.map(b => <option key={b.id} value={b.id}>{b.id.slice(0, 8)}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Occupancy certificate *</label>
                <input value={ocReference} onChange={e => setOcReference(e.target.value)}
                  placeholder="e.g. OC/MUM/2026/8814"
                  className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm" />
                {/* Not a formality: offering possession of a building nobody may
                    lawfully occupy is the complaint that gets filed. */}
                <p className="text-[10px] text-zinc-400 mt-1">
                  Required. Possession cannot be offered before the OC is in hand.
                </p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Certificate dated</label>
                <input type="date" value={ocDatedOn} onChange={e => setOcDatedOn(e.target.value)}
                  className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm" />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowOffer(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button onClick={offer} disabled={offering}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60">
                  {offering && <Loader2 className="h-4 w-4 animate-spin" />}{offering ? 'Offering…' : 'Offer possession'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
