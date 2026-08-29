import { useState, useEffect, useMemo } from 'react';
import {
  FileSpreadsheet, Plus, X, FileText, Loader2, Trash2, Send, CheckCircle,
  Search, AlertTriangle,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  isApiEnabled, apiGetCostSheets, apiGetCostSheet, apiCreateCostSheet,
  apiSetCostSheetStatus, apiDeleteCostSheet, apiCostSheetPdf, apiSetCostSheetLines,
  apiGetUnits, apiGetLeads,
} from '../services/apiClient';
import type { ApiCostSheet, ApiCostSheetLine, CostSheetSection } from '../services/apiClient';
import { formatCurrency } from '../utils/format';
import toast from 'react-hot-toast';

/**
 * Cost sheets — the itemised statement a buyer decides on.
 *
 * NOTHING here computes a total. GST is per line and never applies to a
 * statutory levy; TDS under 194-IA is deducted from what the builder receives
 * rather than added to what the buyer pays. Those rules live in one place on
 * the server, and a second implementation in the browser would be a second
 * chance to get them wrong — with the browser's answer the one the buyer sees.
 */

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-zinc-100 text-zinc-600',
  issued: 'bg-blue-50 text-blue-700',
  accepted: 'bg-emerald-50 text-emerald-700',
  superseded: 'bg-amber-50 text-amber-700',
  cancelled: 'bg-red-50 text-red-600',
};

const SECTION_LABELS: Record<CostSheetSection, string> = {
  consideration: 'Consideration',
  statutory: 'Statutory charges',
  deposit: 'Deposits',
  other: 'Other',
};

/**
 * The lines a residential cost sheet almost always has.
 *
 * Offered as a starting point rather than imposed: a builder edits the rates,
 * deletes what does not apply, and adds what does. Stamp duty and registration
 * are percentages OF the consideration and carry no GST — that is not a
 * default, it is the law, and the server enforces it regardless of what is
 * sent here.
 */
const TEMPLATE: Array<Omit<ApiCostSheetLine, 'id' | 'sequence' | 'amount' | 'gstAmount'>> = [
  { section: 'consideration', label: 'Basic Sale Price',              basis: 'per_sqft',             rate: 0, gstPct: 5 },
  { section: 'consideration', label: 'Floor Rise',                    basis: 'per_sqft',             rate: 0, gstPct: 5 },
  { section: 'consideration', label: 'Preferential Location Charges', basis: 'lump_sum',             rate: 0, gstPct: 5 },
  { section: 'consideration', label: 'Covered Car Parking',           basis: 'lump_sum',             rate: 0, gstPct: 5 },
  { section: 'consideration', label: 'Club Membership',               basis: 'lump_sum',             rate: 0, gstPct: 5 },
  { section: 'deposit',       label: 'Maintenance Advance',           basis: 'lump_sum',             rate: 0, gstPct: 18 },
  { section: 'statutory',     label: 'Stamp Duty',                    basis: 'pct_of_consideration', rate: 6, gstPct: 0 },
  { section: 'statutory',     label: 'Registration Charges',          basis: 'pct_of_consideration', rate: 1, gstPct: 0 },
];

type DraftLine = Omit<ApiCostSheetLine, 'id' | 'sequence' | 'amount' | 'gstAmount'>;

export default function CostSheets() {
  const { tenant, hasPermission } = useAuth();
  const currency = tenant?.currency || 'INR';
  const canManage = hasPermission('manage_bookings');

  const [sheets, setSheets] = useState<ApiCostSheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  // Set while the modal is correcting an existing draft rather than making one.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ApiCostSheet | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // The units API speaks its own names: `number` is the unit code, `area` is
  // the saleable area, and `price` is the per-square-foot rate rather than a
  // total. Naming these after the cost-sheet columns produced a dropdown of
  // uuid fragments and a Basic Sale Price that never pre-filled.
  const [units, setUnits] = useState<Array<{ id: string; number?: string; configuration?: string; area?: number; price?: number }>>([]);
  const [leads, setLeads] = useState<Array<{ id: string; name: string }>>([]);

  const [unitId, setUnitId] = useState('');
  const [leadId, setLeadId] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [lines, setLines] = useState<DraftLine[]>(TEMPLATE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isApiEnabled()) { setLoading(false); return; }
    let cancelled = false;
    apiGetCostSheets()
      .then(rows => { if (!cancelled) setSheets(rows); })
      .catch(() => { if (!cancelled) toast.error('Could not load cost sheets', { id: 'cs-load' }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  // Only when the drawer opens: a workspace can have thousands of units, and
  // there is no reason to fetch them to render a list of sheets.
  useEffect(() => {
    if (!showNew || !isApiEnabled()) return;
    let cancelled = false;
    Promise.all([apiGetUnits().catch(() => []), apiGetLeads().catch(() => [])])
      .then(([u, l]) => {
        if (cancelled) return;
        setUnits((u as typeof units) ?? []);
        setLeads(((l as Array<{ id: string; name: string }>) ?? []).slice(0, 500));
      });
    return () => { cancelled = true; };
  }, [showNew]);

  const filtered = useMemo(() => sheets.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return `${s.sheetNo}`.includes(q)
      || (s.customerName ?? '').toLowerCase().includes(q)
      || (s.unitCode ?? '').toLowerCase().includes(q)
      || (s.projectName ?? '').toLowerCase().includes(q);
  }), [sheets, search]);

  // Picking a unit fills the per-sqft rate from the unit's own price, so the
  // common case is a sheet that is already right rather than a form of zeros.
  const onPickUnit = (id: string) => {
    setUnitId(id);
    const u = units.find(x => x.id === id);
    if (!u) return;
    setLines(prev => prev.map(l =>
      l.label === 'Basic Sale Price' && u.price ? { ...l, rate: Number(u.price) } : l));
  };

  const create = async () => {
    if (!canManage) { toast.error('You do not have permission to create cost sheets'); return; }
    setSaving(true);
    try {
      const sheet = await apiCreateCostSheet({
        unitId: unitId || undefined,
        leadId: leadId || undefined,
        validUntil: validUntil || undefined,
        // A zero-rate line is a line the builder left blank; sending it would
        // put "Floor Rise — 0" on a document a buyer reads.
        lines: lines.filter(l => Number(l.rate) > 0),
      });
      toast.success(`Cost sheet ${sheet.sheetNo} drafted`);
      setShowNew(false);
      setUnitId(''); setLeadId(''); setValidUntil(''); setLines(TEMPLATE);
      refresh();
      setSelected(await apiGetCostSheet(sheet.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the cost sheet');
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (id: string, status: 'issued' | 'accepted' | 'cancelled' | 'superseded') => {
    setBusyId(id);
    try {
      const updated = await apiSetCostSheetStatus(id, status);
      toast.success(`Cost sheet ${updated.sheetNo} is now ${status}`);
      if (selected?.id === id) setSelected(await apiGetCostSheet(id));
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the cost sheet');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this draft cost sheet?')) return;
    setBusyId(id);
    try {
      await apiDeleteCostSheet(id);
      if (selected?.id === id) setSelected(null);
      toast.success('Draft deleted');
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete');
    } finally {
      setBusyId(null);
    }
  };

  const openPdf = async (id: string) => {
    setBusyId(id);
    try {
      const { url } = await apiCostSheetPdf(id);
      window.open(url, '_blank', 'noopener,noreferrer');
      // Revoking immediately closes the tab that was just opened.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not render the cost sheet');
    } finally {
      setBusyId(null);
    }
  };

  const open = async (id: string) => {
    try { setSelected(await apiGetCostSheet(id)); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not open the cost sheet'); }
  };

  const updateLine = (i: number, patch: Partial<DraftLine>) =>
    setLines(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l));

  /**
   * Correct the lines on a draft.
   *
   * Lines could only ever be set at creation: `PUT /api/cost-sheets/:id/lines`
   * existed and passed its suite, and nothing called it. A typo in a rate meant
   * deleting the sheet and starting again.
   *
   * Drafts only, which is the server's rule and the right one — an issued sheet
   * is a document a buyer has seen, so it is superseded rather than rewritten.
   */
  const editLines = (sheet: ApiCostSheet) => {
    setEditingId(sheet.id);
    setLines((sheet.lines ?? []).map(l => ({
      section: l.section, label: l.label, basis: l.basis,
      rate: l.rate, gstPct: l.gstPct, quantity: l.quantity,
    })));
    setSelected(null);
    setShowNew(true);
  };

  const saveLines = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      const updated = await apiSetCostSheetLines(editingId, lines.filter(l => Number(l.rate) > 0));
      toast.success('Cost sheet updated');
      closeModal();
      refresh();
      setSelected(updated);
    } catch (e) {
      // 409 when it is no longer a draft — someone issued it in another tab.
      toast.error(e instanceof Error ? e.message : 'Could not save those lines');
    } finally {
      setSaving(false);
    }
  };

  const closeModal = () => {
    setShowNew(false);
    setEditingId(null);
    setUnitId(''); setLeadId(''); setValidUntil(''); setLines(TEMPLATE);
  };

  if (!isApiEnabled()) {
    return (
      <div className="max-w-[1200px]">
        <div className="bg-white rounded-2xl border border-zinc-200/60 py-16 flex flex-col items-center text-center">
          <AlertTriangle className="h-10 w-10 text-amber-400 mb-3" />
          <h3 className="text-sm font-semibold text-zinc-700">Cost sheets need the API</h3>
          <p className="text-xs text-zinc-500 mt-1 max-w-sm">
            The tax arithmetic — per-line GST and the 194-IA deduction — runs on the server,
            so there is deliberately no local-only version of this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-[1200px]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Cost Sheets</h2>
          <p className="text-sm text-zinc-500 mt-0.5">
            The itemised statement a buyer takes to their bank — with GST and TDS worked out.
          </p>
        </div>
        {canManage && (
          <button onClick={() => setShowNew(true)} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm">
            <Plus className="h-4 w-4" /> New Cost Sheet
          </button>
        )}
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by number, customer or unit..."
          className="w-full pl-9 pr-4 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        />
      </div>

      {loading ? (
        <div className="bg-white rounded-2xl border border-zinc-200/60 py-16 flex justify-center">
          <Loader2 className="h-6 w-6 text-zinc-300 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-zinc-200/60 py-16 flex flex-col items-center">
          <FileSpreadsheet className="h-12 w-12 text-zinc-300 mb-3" />
          <h3 className="text-sm font-semibold text-zinc-700">No cost sheets yet</h3>
          <p className="text-xs text-zinc-500 mt-1">Draft one against a unit to price it for a buyer.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-zinc-50/50 border-b border-zinc-100">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Sheet</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Customer</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Unit</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Consideration</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Payable</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Status</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(s => (
                  <tr key={s.id} className="border-b border-zinc-50 hover:bg-zinc-50/30 transition-colors">
                    <td className="px-4 py-3">
                      <button onClick={() => open(s.id)} className="text-sm font-semibold text-indigo-600 hover:underline">
                        #{s.sheetNo}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-700">{s.customerName ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-zinc-600">
                      {[s.projectName, s.unitCode].filter(Boolean).join(' — ') || '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-600 text-right tabular-nums">
                      {formatCurrency(s.totals?.consideration ?? 0, currency)}
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-zinc-900 text-right tabular-nums">
                      {formatCurrency(s.totals?.payableByBuyer ?? 0, currency)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize ${STATUS_STYLES[s.status] ?? 'bg-zinc-100 text-zinc-500'}`}>
                        {s.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openPdf(s.id)} disabled={busyId === s.id}
                          className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-400 hover:text-indigo-600 disabled:opacity-50"
                          title="Open as PDF"
                        >
                          {busyId === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                        </button>
                        {canManage && s.status === 'draft' && (
                          <>
                            <button onClick={() => setStatus(s.id, 'issued')} disabled={busyId === s.id}
                              className="p-1.5 rounded-lg hover:bg-blue-50 text-zinc-400 hover:text-blue-600 disabled:opacity-50" title="Issue">
                              <Send className="h-4 w-4" />
                            </button>
                            <button onClick={() => remove(s.id)} disabled={busyId === s.id}
                              className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 disabled:opacity-50" title="Delete draft">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </>
                        )}
                        {canManage && s.status === 'issued' && (
                          <button onClick={() => setStatus(s.id, 'accepted')} disabled={busyId === s.id}
                            className="p-1.5 rounded-lg hover:bg-emerald-50 text-zinc-400 hover:text-emerald-600 disabled:opacity-50" title="Mark accepted">
                            <CheckCircle className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Detail drawer ─────────────────────────────────────────────────── */}
      {selected && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex justify-end" onClick={() => setSelected(null)}>
          <div className="bg-white w-full max-w-2xl h-full overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900">Cost Sheet #{selected.sheetNo}</h3>
                <p className="text-sm text-zinc-500">
                  {selected.customerName ?? 'No customer'} · {[selected.projectName, selected.unitCode].filter(Boolean).join(' — ') || 'No unit'}
                </p>
              </div>
              <button onClick={() => setSelected(null)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>

            {(['consideration', 'statutory', 'deposit', 'other'] as CostSheetSection[]).map(section => {
              const group = selected.lines.filter(l => l.section === section);
              if (!group.length) return null;
              return (
                <div key={section} className="mb-4">
                  <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">{SECTION_LABELS[section]}</p>
                  <div className="space-y-1">
                    {group.map(l => (
                      <div key={l.id} className="flex items-baseline justify-between text-sm">
                        <span className="text-zinc-600">
                          {l.label}
                          {l.basis === 'per_sqft' && <span className="text-zinc-400 text-xs"> · {l.quantity} sq ft @ {formatCurrency(l.rate, currency)}</span>}
                          {l.basis === 'pct_of_consideration' && <span className="text-zinc-400 text-xs"> · {l.rate}% of consideration</span>}
                          {/* Zero GST on a statutory line is the law, not an
                              omission — say so rather than showing nothing. */}
                          {Number(l.gstPct) > 0
                            ? <span className="text-zinc-400 text-xs"> · GST {l.gstPct}% = {formatCurrency(l.gstAmount ?? 0, currency)}</span>
                            : section === 'statutory' && <span className="text-zinc-400 text-xs"> · no GST</span>}
                        </span>
                        <span className="tabular-nums text-zinc-900 font-medium">{formatCurrency(l.amount ?? 0, currency)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {selected.totals && (
              <div className="border-t border-zinc-200 pt-3 mt-4 space-y-1.5 text-sm">
                <div className="flex justify-between text-zinc-500"><span>GST</span><span className="tabular-nums">{formatCurrency(selected.totals.gst, currency)}</span></div>
                <div className="flex justify-between font-semibold text-zinc-900 text-base border-t border-zinc-100 pt-2">
                  <span>Payable by buyer</span>
                  <span className="tabular-nums">{formatCurrency(selected.totals.payableByBuyer, currency)}</span>
                </div>
                {selected.totals.tds > 0 && (
                  <>
                    <div className="flex justify-between text-zinc-500">
                      <span>Less: TDS u/s 194-IA @ {selected.tdsPct}%</span>
                      <span className="tabular-nums">({formatCurrency(selected.totals.tds, currency)})</span>
                    </div>
                    <div className="flex justify-between font-semibold text-zinc-900">
                      <span>Net remittance to the developer</span>
                      <span className="tabular-nums">{formatCurrency(selected.totals.netToBuilder, currency)}</span>
                    </div>
                    <p className="text-[11px] text-zinc-400 pt-1">
                      Deducted by the buyer and remitted to the Income Tax Department. It is not an
                      additional cost to the buyer.
                    </p>
                  </>
                )}
              </div>
            )}

            <div className="flex gap-2 mt-6">
              <button onClick={() => openPdf(selected.id)} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-semibold text-zinc-700 hover:bg-zinc-50">
                <FileText className="h-4 w-4" /> Open as PDF
              </button>
              {canManage && selected.status === 'draft' && (
                <button onClick={() => editLines(selected)} className="px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-semibold text-zinc-600 hover:bg-zinc-50">
                  Edit lines
                </button>
              )}
              {canManage && selected.status === 'draft' && (
                <button onClick={() => setStatus(selected.id, 'issued')} className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700">
                  Issue to buyer
                </button>
              )}
              {canManage && selected.status === 'issued' && (
                <button onClick={() => setStatus(selected.id, 'accepted')} className="flex-1 px-4 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700">
                  Mark accepted
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── New sheet ─────────────────────────────────────────────────────── */}
      {showNew && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={closeModal}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">{editingId ? 'Edit cost sheet lines' : 'New Cost Sheet'}</h3>
              <button onClick={closeModal} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>

            {/* Unit, customer and validity are fixed at creation — the lines
                endpoint replaces lines and nothing else. */}
            {!editingId && (
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Unit</label>
                <select value={unitId} onChange={e => onPickUnit(e.target.value)} className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm">
                  <option value="">Select a unit…</option>
                  {units.map(u => (
                    <option key={u.id} value={u.id}>
                      {[u.number, u.configuration, u.area ? `${u.area} sq ft` : null].filter(Boolean).join(' · ') || u.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Customer</label>
                <select value={leadId} onChange={e => setLeadId(e.target.value)} className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm">
                  <option value="">Select a lead…</option>
                  {leads.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Valid until</label>
                <input type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm" />
              </div>
            </div>

            )}

            <p className="text-[11px] text-zinc-400 mb-2">
              Leave a rate at zero to omit the line. Statutory charges are a percentage of the
              consideration and never attract GST — the server enforces that regardless of what is sent.
            </p>

            <div className="border border-zinc-200 rounded-xl overflow-hidden mb-4">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50/60">
                  <tr>
                    <th className="text-left px-3 py-2 text-[11px] font-semibold text-zinc-500 uppercase">Line</th>
                    <th className="text-left px-3 py-2 text-[11px] font-semibold text-zinc-500 uppercase w-32">Section</th>
                    <th className="text-right px-3 py-2 text-[11px] font-semibold text-zinc-500 uppercase w-32">Rate</th>
                    <th className="text-right px-3 py-2 text-[11px] font-semibold text-zinc-500 uppercase w-24">GST %</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i} className="border-t border-zinc-100">
                      <td className="px-3 py-1.5">
                        <input
                          value={l.label} onChange={e => updateLine(i, { label: e.target.value })}
                          className="w-full px-2 py-1.5 bg-transparent rounded-lg text-sm focus:bg-zinc-50 focus:outline-none"
                        />
                        <span className="text-[10px] text-zinc-400 px-2">
                          {l.basis === 'per_sqft' ? 'per sq ft' : l.basis === 'pct_of_consideration' ? '% of consideration' : 'lump sum'}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-xs text-zinc-500">{SECTION_LABELS[l.section]}</td>
                      <td className="px-3 py-1.5">
                        <input
                          type="number" min={0} step="any" value={l.rate}
                          onChange={e => updateLine(i, { rate: Number(e.target.value) })}
                          className="w-full px-2 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-sm text-right tabular-nums"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          type="number" min={0} max={100} step="any"
                          value={l.gstPct}
                          disabled={l.section === 'statutory'}
                          onChange={e => updateLine(i, { gstPct: Number(e.target.value) })}
                          className="w-full px-2 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-sm text-right tabular-nums disabled:opacity-40"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex gap-3">
              <button type="button" onClick={closeModal} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
              <button
                onClick={editingId ? saveLines : create} disabled={saving}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}{editingId ? (saving ? 'Saving…' : 'Save lines') : (saving ? 'Drafting…' : 'Create draft')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
