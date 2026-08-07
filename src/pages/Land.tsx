import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Map, Plus, X, MapPin, Gauge, ArrowRight, AlertTriangle, ShieldCheck,
  FileText, CheckCircle2, Ban, Building2, Calculator, ScrollText,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, logAudit } from '../services/db';
import { isApiEnabled } from '../services/apiClient';
import { hydrateLandBd, persistLandLead } from '../services/landBdWrites';
import {
  computeFeasibility, feasibilityHistory, findDuplicateParcel, qualifyLead,
  rejectLead, convertToProject, addLandDocument, landDocuments, verifyDocument,
} from '../services/landService';
import { explainLandFeasibility } from '../types';
import { formatCurrency } from '../utils/format';
import type {
  LandLead, LandLeadStatus, LandReferenceSource, OwnershipType, LitigationStatus,
  LandDocType, FeasibilityRecord,
} from '../types';
import { LAND_STATUSES, LAND_DOC_TYPES } from '../types';
import toast from 'react-hot-toast';

export default function Land() {
  const { user, tenant, hasPermission } = useAuth();
  const navigate = useNavigate();
  const tenantId = tenant?.id || '';
  const currency = tenant?.currency || 'INR';
  const canManage = hasPermission('manage_land');       // land_manager — the maker
  const canQualify = hasPermission('approve_land_qualify'); // bd_manager / admin — checker
  const canConvert = hasPermission('approve_land_convert'); // admin — second checker
  const canVerifyDocs = hasPermission('approve_land_qualify');
  const actor = user ? { id: user.id, name: user.name } : { id: '', name: 'System' };

  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  // API mode: mirror the server Land/BD slice into the read-cache on mount so
  // the synchronous folds below render server truth. No-op in demo mode.
  useEffect(() => {
    if (!isApiEnabled() || !tenantId) return;
    let cancelled = false;
    hydrateLandBd(tenantId)
      .then(() => { if (!cancelled) refresh(); })
      .catch(() => toast.error('Could not reach the server — showing locally cached data'));
    return () => { cancelled = true; };
  }, [tenantId]);
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState<LandLead | null>(null);
  const [statusFilter, setStatusFilter] = useState<LandLeadStatus | 'all'>('all');
  const [feasInputs, setFeasInputs] = useState({ costPerSqft: '', saleableArea: '' });
  const [rejectMode, setRejectMode] = useState(false);

  const leads = useMemo(
    () => getByTenant<LandLead>('landLeads', tenantId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [tenantId, refreshKey]
  );
  const active = leads.filter(l => l.status !== 'rejected' && l.status !== 'converted_to_project');
  const qualifiedCount = leads.filter(l => l.status === 'qualified').length;
  const dupes = active.filter(l => l.duplicateOf).length;
  const converted = leads.filter(l => l.status === 'converted_to_project').length;

  const filtered = statusFilter === 'all' ? leads : leads.filter(l => l.status === statusFilter);

  // keep the open drawer in step with the store
  const sel = selected ? leads.find(l => l.id === selected.id) ?? null : null;

  const handleAdd = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const surveyNumber = (fd.get('surveyNumber') as string)?.trim();
    const city = (fd.get('city') as string)?.trim();
    const ownerName = (fd.get('ownerName') as string)?.trim();
    if (!surveyNumber || !city || !ownerName) { toast.error('Owner, survey number and city are required'); return; }

    // Duplicate-parcel guard at insert (two brokers submitting the same land)
    const dup = findDuplicateParcel(tenantId, surveyNumber, city);
    if (dup && !confirm(`A live parcel on survey ${surveyNumber} in ${city} already exists ("${dup.ownerName}"). Log this as a possible duplicate anyway?`)) return;

    let created: LandLead;
    try {
      created = await persistLandLead({
      tenantId,
      referenceSource: (fd.get('referenceSource') as LandReferenceSource) || 'broker',
      ownerName, ownerContact: (fd.get('ownerContact') as string) || '',
      location: (fd.get('location') as string) || '',
      city, state: (fd.get('state') as string) || '',
      pincode: (fd.get('pincode') as string) || '',
      surveyNumber, areaAcres: Number(fd.get('areaAcres')) || 0,
      askingPrice: Number(fd.get('askingPrice')) || 0,
      status: 'lead_reference',
      assignedTo: user?.id,
      ownershipType: (fd.get('ownershipType') as OwnershipType) || undefined,
      zoning: (fd.get('zoning') as string) || '',
      fsiPermissible: Number(fd.get('fsiPermissible')) || undefined,
      fsiConsumed: Number(fd.get('fsiConsumed')) || undefined,
      roadWidthFt: Number(fd.get('roadWidthFt')) || undefined,
      isEncumbered: fd.get('isEncumbered') === 'on',
      encumbranceNotes: (fd.get('encumbranceNotes') as string) || '',
      litigationStatus: (fd.get('litigationStatus') as LitigationStatus) || 'none',
      duplicateOf: dup?.id,
      createdBy: user?.id, createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not log the parcel');
      return;
    }
    logAudit({ tenantId, userId: actor.id, userName: actor.name, action: 'create', entity: 'land_lead', entityId: created.id, details: `Logged land parcel ${surveyNumber} in ${city}` });
    setShowAdd(false);
    refresh();
    toast.success('Land parcel logged');
  };

  const runFeasibility = async () => {
    if (!sel) return;
    const cost = Number(feasInputs.costPerSqft);
    const area = Number(feasInputs.saleableArea);
    if (!(cost > 0) || !(area > 0)) { toast.error('Enter a sale rate and saleable area'); return; }
    try {
      await computeFeasibility(sel, { costPerSqft: cost, saleableArea: area }, actor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the feasibility run');
      return;
    }
    setFeasInputs({ costPerSqft: '', saleableArea: '' });
    refresh();
    toast.success('Feasibility computed');
  };

  const doQualify = async () => {
    if (!sel) return;
    const r = await qualifyLead(sel, actor);
    if (!r.ok) { toast.error(r.error || 'Could not qualify'); return; }
    refresh();
    toast.success('Parcel qualified');
  };

  const doConvert = async () => {
    if (!sel) return;
    if (!confirm('Convert this parcel into a live project? This commits the company to building here.')) return;
    const r = await convertToProject(sel, actor);
    if (!r.ok) { toast.error(r.error || 'Could not convert'); return; }
    refresh();
    toast.success('Converted to a project');
    if (r.projectId) navigate('/projects');
  };

  const uploadDoc = async (docType: LandDocType) => {
    if (!sel) return;
    const name = prompt(`File name for the ${docType.replace('_', ' ')} (demo — records the upload, no file store):`);
    if (!name?.trim()) return;
    try {
      await addLandDocument(tenantId, sel.id, docType, name.trim(), actor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not record the document');
      return;
    }
    refresh();
    toast.success('Document version recorded');
  };

  const inputCls = 'w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20';
  const labelCls = 'block text-xs font-semibold text-zinc-500 uppercase mb-1';
  // Falls back rather than asserting: an unrecognised status (an older row, or
  // one written by another client) should render a neutral chip, not crash the page.
  const statusMeta = (s: LandLeadStatus) =>
    LAND_STATUSES.find(x => x.id === s) ?? { id: s, label: String(s).replace(/_/g, ' '), color: 'bg-zinc-300' };
  const scoreBadge = (n?: number) => n === undefined ? 'bg-zinc-100 text-zinc-400' : n >= 70 ? 'bg-emerald-50 text-emerald-700' : n >= 45 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-600';

  return (
    <div className="space-y-6 max-w-[1400px]">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Land Acquisition</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Source parcels, score feasibility, and convert qualified land into projects.</p>
        </div>
        {canManage && (
          <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm">
            <Plus className="h-4 w-4" /> Log Parcel
          </button>
        )}
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gradient-to-br from-indigo-500 to-violet-600 rounded-2xl p-4 text-white">
          <div className="flex items-center gap-2 mb-2"><Map className="h-5 w-5 text-indigo-200" /><span className="text-xs font-medium text-indigo-200">Active Parcels</span></div>
          <p className="text-3xl font-bold">{active.length}</p>
          <p className="text-xs text-indigo-200 mt-1">{leads.length} logged in total</p>
        </div>
        <div className={`rounded-2xl border p-4 ${qualifiedCount > 0 ? 'bg-white border-zinc-200/60' : 'bg-white border-zinc-200/60'}`}>
          <div className="flex items-center gap-2 mb-2"><ShieldCheck className="h-5 w-5 text-zinc-400" /><span className="text-xs font-medium text-zinc-500">Qualified</span></div>
          <p className="text-2xl font-bold text-zinc-900">{qualifiedCount}</p>
          <p className="text-xs text-zinc-500 mt-1">ready to convert</p>
        </div>
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-2"><Building2 className="h-5 w-5 text-zinc-400" /><span className="text-xs font-medium text-zinc-500">Converted</span></div>
          <p className="text-2xl font-bold text-zinc-900">{converted}</p>
          <p className="text-xs text-zinc-500 mt-1">now live projects</p>
        </div>
        <div className={`rounded-2xl border p-4 ${dupes > 0 ? 'bg-amber-50/60 border-amber-200' : 'bg-white border-zinc-200/60'}`}>
          <div className="flex items-center gap-2 mb-2"><AlertTriangle className={`h-5 w-5 ${dupes > 0 ? 'text-amber-500' : 'text-zinc-400'}`} /><span className={`text-xs font-medium ${dupes > 0 ? 'text-amber-600' : 'text-zinc-500'}`}>Duplicate Flags</span></div>
          <p className={`text-2xl font-bold ${dupes > 0 ? 'text-amber-600' : 'text-zinc-900'}`}>{dupes}</p>
          <p className={`text-xs mt-1 ${dupes > 0 ? 'text-amber-500' : 'text-zinc-500'}`}>same survey no.</p>
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-1 bg-white border border-zinc-200 rounded-xl p-1 overflow-x-auto">
        <button onClick={() => setStatusFilter('all')} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${statusFilter === 'all' ? 'bg-indigo-600 text-white' : 'text-zinc-500 hover:text-zinc-700'}`}>All</button>
        {LAND_STATUSES.map(s => (
          <button key={s.id} onClick={() => setStatusFilter(s.id)} className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${statusFilter === s.id ? 'bg-indigo-600 text-white' : 'text-zinc-500 hover:text-zinc-700'}`}>{s.label}</button>
        ))}
      </div>

      {/* List */}
      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-16 text-center">
            <Map className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
            <p className="text-sm text-zinc-500">No parcels here yet. Log your first land deal to start the feasibility funnel.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-zinc-50/30 border-b border-zinc-100">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Parcel</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase hidden md:table-cell">Owner</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase hidden sm:table-cell">Ask</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Feasibility</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {filtered.map(l => (
                  <tr key={l.id} onClick={() => { setSelected(l); setRejectMode(false); }} className="border-b border-zinc-50 hover:bg-zinc-50/40 transition-colors cursor-pointer">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-zinc-900 flex items-center gap-1.5">
                        Survey {l.surveyNumber}
                        {l.duplicateOf && <span title="Possible duplicate parcel" className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">DUP</span>}
                        {(l.isEncumbered || l.litigationStatus === 'pending') && <span title="Legal risk" className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">RISK</span>}
                      </p>
                      <p className="text-[11px] text-zinc-500 flex items-center gap-1"><MapPin className="h-3 w-3" /> {l.city}{l.state ? `, ${l.state}` : ''} · {l.areaAcres} ac</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-600 hidden md:table-cell">{l.ownerName}<p className="text-[11px] text-zinc-400">{l.referenceSource}</p></td>
                    <td className="px-4 py-3 text-sm font-semibold text-zinc-900 text-right hidden sm:table-cell">{formatCurrency(l.askingPrice, currency)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full ${scoreBadge(l.latestScore)}`}>
                        <Gauge className="h-3 w-3" /> {l.latestScore ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600">
                        <span className={`h-1.5 w-1.5 rounded-full ${statusMeta(l.status).color}`} />{statusMeta(l.status).label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right"><ArrowRight className="h-4 w-4 text-zinc-300" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detail drawer */}
      {sel && (() => {
        const feas = feasibilityHistory(tenantId, sel.id);
        const latest = feas[0] as FeasibilityRecord | undefined;
        const docs = landDocuments(tenantId, sel.id);
        const explain = latest ? explainLandFeasibility({
          fsiPermissible: sel.fsiPermissible, fsiConsumed: sel.fsiConsumed,
          marginPercent: latest.marginPercent, roadWidthFt: sel.roadWidthFt,
          ownershipType: sel.ownershipType, isEncumbered: sel.isEncumbered, litigationStatus: sel.litigationStatus,
        }) : null;
        return (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setSelected(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[88vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-lg font-bold text-zinc-900">Survey {sel.surveyNumber} · {sel.city}</h3>
                  <p className="text-xs text-zinc-500 flex items-center gap-1.5 mt-0.5"><MapPin className="h-3 w-3" /> {sel.location || `${sel.city}, ${sel.state}`} · {sel.areaAcres} acres · {sel.ownerName}</p>
                </div>
                <button onClick={() => setSelected(null)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
              </div>

              {/* Risk banner */}
              {(sel.isEncumbered || sel.litigationStatus === 'pending') && (
                <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3">
                  <AlertTriangle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                  <div className="text-xs text-red-700">
                    <p className="font-semibold">Legal risk — qualification is blocked.</p>
                    <p className="mt-0.5">{sel.litigationStatus === 'pending' ? 'Live litigation on this parcel. ' : ''}{sel.isEncumbered ? `Encumbered${sel.encumbranceNotes ? `: ${sel.encumbranceNotes}` : ''}.` : ''}</p>
                  </div>
                </div>
              )}

              {/* Property facts */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
                {[
                  ['Ownership', sel.ownershipType?.replace('_', ' ') || '—'],
                  ['Zoning', sel.zoning || '—'],
                  ['FSI', sel.fsiPermissible ? `${sel.fsiConsumed ?? 0}/${sel.fsiPermissible}` : '—'],
                  ['Road', sel.roadWidthFt ? `${sel.roadWidthFt} ft` : '—'],
                ].map(([k, v]) => (
                  <div key={k} className="bg-zinc-50 rounded-xl p-3"><p className="text-[10px] text-zinc-500 uppercase">{k}</p><p className="text-sm font-semibold text-zinc-900 mt-0.5 capitalize">{v}</p></div>
                ))}
              </div>

              {/* Feasibility */}
              <div className="border border-zinc-200 rounded-xl p-4 mb-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-semibold text-zinc-900 flex items-center gap-1.5"><Calculator className="h-4 w-4 text-indigo-500" /> Feasibility</p>
                  {latest && <span className={`inline-flex items-center gap-1 text-sm font-bold px-2.5 py-1 rounded-full ${scoreBadge(latest.score)}`}><Gauge className="h-3.5 w-3.5" /> {latest.score}/100</span>}
                </div>
                {latest ? (
                  <>
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      <div className="text-center bg-zinc-50 rounded-lg py-2"><p className="text-[10px] text-zinc-500 uppercase">Revenue</p><p className="text-sm font-bold text-zinc-900">{formatCurrency(latest.estimatedRevenue, currency)}</p></div>
                      <div className="text-center bg-zinc-50 rounded-lg py-2"><p className="text-[10px] text-zinc-500 uppercase">Margin</p><p className="text-sm font-bold text-zinc-900">{latest.marginPercent}%</p></div>
                      <div className="text-center bg-zinc-50 rounded-lg py-2"><p className="text-[10px] text-zinc-500 uppercase">Saleable</p><p className="text-sm font-bold text-zinc-900">{latest.saleableArea.toLocaleString('en-IN')} sqft</p></div>
                    </div>
                    {explain && (
                      <div className="space-y-1 mb-1">
                        {explain.factors.map(f => (
                          <div key={f.label} className="flex items-center justify-between text-[11px]">
                            <span className="text-zinc-500">{f.label} <span className="text-zinc-400">· {f.detail}</span></span>
                            <span className="font-semibold text-zinc-700">+{f.points}</span>
                          </div>
                        ))}
                        <p className={`text-[11px] mt-2 font-medium ${explain.cappedByRisk ? 'text-red-600' : 'text-zinc-600'}`}>{explain.verdict}</p>
                      </div>
                    )}
                  </>
                ) : <p className="text-xs text-zinc-400 mb-3">No feasibility run yet.</p>}

                {canManage && sel.status !== 'converted_to_project' && sel.status !== 'rejected' && (
                  <div className="flex gap-2 mt-3 pt-3 border-t border-zinc-100">
                    <input value={feasInputs.saleableArea} onChange={e => setFeasInputs(s => ({ ...s, saleableArea: e.target.value }))} type="number" placeholder="Saleable sqft" className={inputCls} />
                    <input value={feasInputs.costPerSqft} onChange={e => setFeasInputs(s => ({ ...s, costPerSqft: e.target.value }))} type="number" placeholder="Sale ₹/sqft" className={inputCls} />
                    <button onClick={runFeasibility} className="px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 whitespace-nowrap">Run</button>
                  </div>
                )}
              </div>

              {/* Documents */}
              <div className="border border-zinc-200 rounded-xl p-4 mb-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold text-zinc-900 flex items-center gap-1.5"><ScrollText className="h-4 w-4 text-zinc-500" /> Documents <span className="text-[11px] font-normal text-zinc-400">(versioned)</span></p>
                </div>
                {docs.length === 0 ? <p className="text-xs text-zinc-400">No documents uploaded.</p> : (
                  <div className="space-y-1.5 mb-2">
                    {docs.map(d => (
                      <div key={d.id} className="flex items-center gap-2 text-xs">
                        <FileText className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                        <span className="flex-1 text-zinc-700 truncate">{LAND_DOC_TYPES.find(t => t.id === d.docType)?.label} <span className="text-zinc-400">v{d.version} · {d.fileName}</span></span>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${d.verificationStatus === 'verified' ? 'bg-emerald-50 text-emerald-700' : d.verificationStatus === 'rejected' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'}`}>{d.verificationStatus}</span>
                        {canVerifyDocs && d.verificationStatus === 'pending' && (
                          <>
                            <button onClick={() => { verifyDocument(d, 'verified', actor); refresh(); }} className="text-emerald-600 hover:text-emerald-700" title="Verify"><CheckCircle2 className="h-3.5 w-3.5" /></button>
                            <button onClick={() => { verifyDocument(d, 'rejected', actor); refresh(); }} className="text-red-500 hover:text-red-600" title="Reject"><Ban className="h-3.5 w-3.5" /></button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {canManage && sel.status !== 'converted_to_project' && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {LAND_DOC_TYPES.map(t => (
                      <button key={t.id} onClick={() => uploadDoc(t.id)} className="text-[11px] font-medium px-2 py-1 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200">+ {t.label}</button>
                    ))}
                  </div>
                )}
              </div>

              {/* Actions */}
              {sel.status === 'converted_to_project' ? (
                <button onClick={() => navigate('/projects')} className="w-full py-2.5 bg-emerald-50 text-emerald-700 rounded-xl text-sm font-semibold flex items-center justify-center gap-2"><Building2 className="h-4 w-4" /> View the project</button>
              ) : sel.status === 'rejected' ? (
                <div className="text-center text-sm text-red-500 bg-red-50 rounded-xl py-2.5">Rejected{sel.rejectionReason ? ` — ${sel.rejectionReason}` : ''}</div>
              ) : rejectMode ? (
                <form onSubmit={e => { e.preventDefault(); const r = new FormData(e.currentTarget).get('reason') as string; if (!r?.trim()) return; rejectLead(sel, r.trim(), actor); setRejectMode(false); refresh(); toast.success('Parcel rejected'); }} className="flex gap-2">
                  <input name="reason" autoFocus placeholder="Reason for rejection" className={inputCls} />
                  <button type="submit" className="px-3.5 py-2 bg-red-600 text-white rounded-xl text-xs font-semibold hover:bg-red-700 whitespace-nowrap">Confirm</button>
                  <button type="button" onClick={() => setRejectMode(false)} className="px-3 py-2 border border-zinc-200 rounded-xl text-xs font-medium text-zinc-600">Cancel</button>
                </form>
              ) : (
                <div className="flex gap-2 flex-wrap">
                  {/* Maker cannot qualify their own — only a checker sees this */}
                  {canQualify && sel.status !== 'qualified' && (
                    <button onClick={doQualify} className="flex-1 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 flex items-center justify-center gap-2"><ShieldCheck className="h-4 w-4" /> Qualify</button>
                  )}
                  {canConvert && sel.status === 'qualified' && (
                    <button onClick={doConvert} className="flex-1 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700 flex items-center justify-center gap-2"><Building2 className="h-4 w-4" /> Convert to Project</button>
                  )}
                  {sel.status === 'qualified' && !canConvert && (
                    <div className="flex-1 py-2.5 bg-indigo-50 text-indigo-700 rounded-xl text-sm font-semibold text-center">Qualified — awaiting admin conversion</div>
                  )}
                  {!canQualify && !canConvert && sel.status !== 'qualified' && (
                    <div className="flex-1 py-2.5 bg-zinc-50 text-zinc-500 rounded-xl text-sm font-medium text-center">Awaiting BD qualification</div>
                  )}
                  {(canQualify || canManage) && (
                    <button onClick={() => setRejectMode(true)} className="px-4 py-2.5 border border-red-200 text-red-500 rounded-xl text-sm font-semibold hover:bg-red-50">Reject</button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Add modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[88vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Log Land Parcel</h3>
              <button onClick={() => setShowAdd(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAdd} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Owner Name *</label><input name="ownerName" required placeholder="Ramesh Patil" className={inputCls} /></div>
                <div><label className={labelCls}>Owner Contact</label><input name="ownerContact" placeholder="+91 98xxxxxxxx" className={inputCls} /></div>
                <div><label className={labelCls}>Survey Number *</label><input name="surveyNumber" required placeholder="127/2B" className={inputCls} /></div>
                <div><label className={labelCls}>Reference Source</label>
                  <select name="referenceSource" className={inputCls}><option value="broker">Broker</option><option value="direct">Direct</option><option value="auction">Auction</option><option value="government">Government</option></select>
                </div>
                <div><label className={labelCls}>City *</label><input name="city" required placeholder="Pune" className={inputCls} /></div>
                <div><label className={labelCls}>State</label><input name="state" placeholder="Maharashtra" className={inputCls} /></div>
                <div className="col-span-2"><label className={labelCls}>Location / Landmark</label><input name="location" placeholder="Near Hinjewadi Phase 2" className={inputCls} /></div>
                <div><label className={labelCls}>Pincode</label><input name="pincode" placeholder="411057" className={inputCls} /></div>
                <div><label className={labelCls}>Area (acres)</label><input name="areaAcres" type="number" step="any" placeholder="2.5" className={inputCls} /></div>
                <div><label className={labelCls}>Asking Price ({currency})</label><input name="askingPrice" type="number" placeholder="120000000" className={inputCls} /></div>
                <div><label className={labelCls}>Ownership Type</label>
                  <select name="ownershipType" className={inputCls}><option value="">—</option><option value="freehold">Freehold</option><option value="leasehold">Leasehold</option><option value="government_allotted">Government allotted</option></select>
                </div>
                <div><label className={labelCls}>Zoning</label><input name="zoning" placeholder="Residential R1" className={inputCls} /></div>
                <div><label className={labelCls}>Road Width (ft)</label><input name="roadWidthFt" type="number" placeholder="40" className={inputCls} /></div>
                <div><label className={labelCls}>FSI Permissible</label><input name="fsiPermissible" type="number" step="any" placeholder="1.1" className={inputCls} /></div>
                <div><label className={labelCls}>FSI Consumed</label><input name="fsiConsumed" type="number" step="any" placeholder="0" className={inputCls} /></div>
                <div><label className={labelCls}>Litigation</label>
                  <select name="litigationStatus" className={inputCls}><option value="none">None</option><option value="pending">Pending (blocks qualify)</option><option value="resolved">Resolved</option></select>
                </div>
                <label className="flex items-center gap-2 text-sm text-zinc-700 col-span-2 py-1"><input type="checkbox" name="isEncumbered" className="rounded" /> Parcel is encumbered</label>
                <div className="col-span-2"><label className={labelCls}>Encumbrance Notes</label><input name="encumbranceNotes" placeholder="Mortgage with XYZ Bank" className={inputCls} /></div>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowAdd(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Log Parcel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
