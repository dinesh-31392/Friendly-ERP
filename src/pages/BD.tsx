import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Handshake, Plus, X, MapPin, ArrowRight, TrendingUp, Map, LineChart,
  Building2, IndianRupee,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, logAudit } from '../services/db';
import { isApiEnabled } from '../services/apiClient';
import { hydrateLandBd, persistBdLead, persistMarketReport } from '../services/landBdWrites';
import { handOffToLand, advanceStage, closeLost } from '../services/bdService';
import { formatCurrency } from '../utils/format';
import type {
  BdLead, BdStage, BdOpportunityType, BdSource, JvStructure, MarketReport,
} from '../types';
import { BD_STAGES, BD_OPPORTUNITY_TYPES, MARKET_REPORT_TYPES } from '../types';
import toast from 'react-hot-toast';

type Tab = 'pipeline' | 'market';

export default function BD() {
  const { user, tenant, hasPermission } = useAuth();
  const navigate = useNavigate();
  const tenantId = tenant?.id || '';
  const currency = tenant?.currency || 'INR';
  const canManage = hasPermission('manage_bd');
  const canHandOff = hasPermission('approve_bd_handoff');
  const actor = user ? { id: user.id, name: user.name } : { id: '', name: 'System' };

  const [refreshKey, setRefreshKey] = useState(0);
  // API mode: mirror the server Land/BD slice into the read-cache on mount.
  useEffect(() => {
    if (!isApiEnabled() || !tenantId) return;
    let cancelled = false;
    hydrateLandBd(tenantId)
      .then(() => { if (!cancelled) setRefreshKey(k => k + 1); })
      .catch(() => toast.error('Could not reach the server — showing locally cached data'));
    return () => { cancelled = true; };
  }, [tenantId]);
  const refresh = () => setRefreshKey(k => k + 1);
  const [tab, setTab] = useState<Tab>('pipeline');
  const [showAdd, setShowAdd] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [selected, setSelected] = useState<BdLead | null>(null);
  const [lostMode, setLostMode] = useState(false);

  const deals = useMemo(
    () => getByTenant<BdLead>('bdLeads', tenantId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [tenantId, refreshKey]
  );
  const reports = useMemo(
    () => getByTenant<MarketReport>('marketReports', tenantId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [tenantId, refreshKey]
  );
  const sel = selected ? deals.find(d => d.id === selected.id) ?? null : null;

  const open = deals.filter(d => d.stage !== 'closed_lost' && d.stage !== 'handed_to_land');
  const pipelineValue = open.reduce((s, d) => s + d.estimatedDealValue, 0);
  const handedOff = deals.filter(d => d.stage === 'handed_to_land').length;
  const negotiating = deals.filter(d => d.stage === 'terms_negotiation').length;

  const handleAdd = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const counterpartyName = (fd.get('counterpartyName') as string)?.trim();
    const city = (fd.get('city') as string)?.trim();
    if (!counterpartyName || !city) { toast.error('Counterparty and city are required'); return; }
    const opportunityType = (fd.get('opportunityType') as BdOpportunityType) || 'land_acquisition';
    let created: BdLead;
    try {
      created = await persistBdLead({
      tenantId, opportunityType,
      source: (fd.get('source') as BdSource) || 'broker',
      counterpartyName, counterpartyContact: (fd.get('counterpartyContact') as string) || '',
      city, stage: 'identified',
      estimatedDealValue: Number(fd.get('estimatedDealValue')) || 0,
      ownedBy: user?.id,
      jvStructure: opportunityType === 'jv' ? (fd.get('jvStructure') as JvStructure) || 'revenue_share' : undefined,
      revenueSharePercent: Number(fd.get('revenueSharePercent')) || undefined,
      areaSharePercent: Number(fd.get('areaSharePercent')) || undefined,
      jvNotes: (fd.get('jvNotes') as string) || '',
      createdBy: user?.id, createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not log the opportunity');
      return;
    }
    logAudit({ tenantId, userId: actor.id, userName: actor.name, action: 'create', entity: 'bd_lead', entityId: created.id, details: `Logged BD opportunity "${counterpartyName}" in ${city}` });
    setShowAdd(false);
    refresh();
    toast.success('Opportunity logged');
  };

  const handleAddReport = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const areaName = (fd.get('areaName') as string)?.trim();
    const findings = (fd.get('findings') as string)?.trim();
    if (!areaName || !findings) { toast.error('Area and findings are required'); return; }
    try {
      await persistMarketReport({
      tenantId, areaName,
      reportType: (fd.get('reportType') as MarketReport['reportType']) || 'pricing_benchmark',
      findings, dataSources: (fd.get('dataSources') as string) || '',
      createdBy: actor.id, createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the analysis');
      return;
    }
    setShowReport(false);
    refresh();
    toast.success('Market analysis saved');
  };

  const doHandOff = async () => {
    if (!sel) return;
    if (!confirm('Hand this deal off to Land Acquisition? A land parcel will be created for the team to run feasibility on.')) return;
    const r = await handOffToLand(sel, actor);
    if (!r.ok) { toast.error(r.error || 'Could not hand off'); return; }
    refresh();
    toast.success('Handed to Land Acquisition');
    setSelected(null);
    navigate('/land');
  };

  // Falls back rather than asserting — see the same guard in Land.tsx.
  const stageMeta = (s: BdStage) =>
    BD_STAGES.find(x => x.id === s) ?? { id: s, label: String(s).replace(/_/g, ' '), color: 'bg-zinc-300' };
  const inputCls = 'w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20';
  const labelCls = 'block text-xs font-semibold text-zinc-500 uppercase mb-1';
  const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div className="space-y-6 max-w-[1400px]">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Business Development</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Source land and JV deals, benchmark the market, and hand qualified deals to the land team.</p>
        </div>
        {canManage && (
          <button onClick={() => tab === 'market' ? setShowReport(true) : setShowAdd(true)} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm">
            <Plus className="h-4 w-4" /> {tab === 'market' ? 'Log Analysis' : 'Log Deal'}
          </button>
        )}
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gradient-to-br from-indigo-500 to-violet-600 rounded-2xl p-4 text-white">
          <div className="flex items-center gap-2 mb-2"><IndianRupee className="h-5 w-5 text-indigo-200" /><span className="text-xs font-medium text-indigo-200">Open Pipeline</span></div>
          <p className="text-3xl font-bold">{formatCurrency(pipelineValue, currency)}</p>
          <p className="text-xs text-indigo-200 mt-1">{open.length} live deal{open.length === 1 ? '' : 's'}</p>
        </div>
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-2"><TrendingUp className="h-5 w-5 text-zinc-400" /><span className="text-xs font-medium text-zinc-500">In Negotiation</span></div>
          <p className="text-2xl font-bold text-zinc-900">{negotiating}</p>
          <p className="text-xs text-zinc-500 mt-1">terms being worked</p>
        </div>
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-2"><Map className="h-5 w-5 text-zinc-400" /><span className="text-xs font-medium text-zinc-500">Handed to Land</span></div>
          <p className="text-2xl font-bold text-zinc-900">{handedOff}</p>
          <p className="text-xs text-zinc-500 mt-1">now in feasibility</p>
        </div>
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-2"><LineChart className="h-5 w-5 text-zinc-400" /><span className="text-xs font-medium text-zinc-500">Market Reports</span></div>
          <p className="text-2xl font-bold text-zinc-900">{reports.length}</p>
          <p className="text-xs text-zinc-500 mt-1">benchmarks saved</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-white border border-zinc-200 rounded-xl p-1">
        <button onClick={() => setTab('pipeline')} className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium ${tab === 'pipeline' ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}><Handshake className="h-4 w-4" /> Deal Pipeline</button>
        <button onClick={() => setTab('market')} className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium ${tab === 'market' ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}><LineChart className="h-4 w-4" /> Market Analysis</button>
      </div>

      {/* Pipeline */}
      {tab === 'pipeline' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          {deals.length === 0 ? (
            <div className="py-16 text-center"><Handshake className="h-12 w-12 text-zinc-300 mx-auto mb-3" /><p className="text-sm text-zinc-500">No deals yet. Log your first land or JV opportunity.</p></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-zinc-50/30 border-b border-zinc-100">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Counterparty</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase hidden md:table-cell">Type</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase hidden sm:table-cell">Deal Value</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Stage</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {deals.map(d => (
                    <tr key={d.id} onClick={() => { setSelected(d); setLostMode(false); }} className="border-b border-zinc-50 hover:bg-zinc-50/40 transition-colors cursor-pointer">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-zinc-900">{d.counterpartyName}</p>
                        <p className="text-[11px] text-zinc-500 flex items-center gap-1"><MapPin className="h-3 w-3" /> {d.city} · {d.source.replace('_', ' ')}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-zinc-600 hidden md:table-cell">{BD_OPPORTUNITY_TYPES.find(t => t.id === d.opportunityType)?.label}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-zinc-900 text-right hidden sm:table-cell">{formatCurrency(d.estimatedDealValue, currency)}</td>
                      <td className="px-4 py-3 text-center">
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600">
                          <span className={`h-1.5 w-1.5 rounded-full ${stageMeta(d.stage).color}`} />{stageMeta(d.stage).label}
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
      )}

      {/* Market analysis */}
      {tab === 'market' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          {reports.length === 0 ? (
            <div className="py-16 text-center"><LineChart className="h-12 w-12 text-zinc-300 mx-auto mb-3" /><p className="text-sm text-zinc-500">No market analysis yet. Benchmark pricing and competitor launches before making an offer.</p></div>
          ) : (
            <div className="divide-y divide-zinc-50">
              {reports.map(r => (
                <div key={r.id} className="px-5 py-3.5">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600">{MARKET_REPORT_TYPES.find(t => t.id === r.reportType)?.label}</span>
                    <p className="text-sm font-semibold text-zinc-900">{r.areaName}</p>
                    <span className="text-[11px] text-zinc-400 ml-auto">{fmtDate(r.createdAt)}</span>
                  </div>
                  <p className="text-sm text-zinc-700">{r.findings}</p>
                  {r.dataSources && <p className="text-[11px] text-zinc-400 mt-1">Sources: {r.dataSources}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Deal detail drawer */}
      {sel && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[88vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-bold text-zinc-900">{sel.counterpartyName}</h3>
                <p className="text-xs text-zinc-500 flex items-center gap-1.5 mt-0.5"><MapPin className="h-3 w-3" /> {sel.city} · {BD_OPPORTUNITY_TYPES.find(t => t.id === sel.opportunityType)?.label} · {formatCurrency(sel.estimatedDealValue, currency)}</p>
              </div>
              <button onClick={() => setSelected(null)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>

            {sel.opportunityType === 'jv' && (
              <div className="bg-zinc-50 rounded-xl p-3 mb-4 text-sm">
                <p className="text-[10px] text-zinc-500 uppercase mb-1">JV Terms</p>
                <p className="text-zinc-700">{sel.jvStructure?.replace('_', ' ')}{sel.revenueSharePercent ? ` · ${sel.revenueSharePercent}% revenue` : ''}{sel.areaSharePercent ? ` · ${sel.areaSharePercent}% area` : ''}</p>
                {sel.jvNotes && <p className="text-[11px] text-zinc-500 mt-1">{sel.jvNotes}</p>}
              </div>
            )}

            {/* Stage stepper */}
            <div className="flex items-center gap-1 mb-5">
              {BD_STAGES.filter(s => s.id !== 'closed_lost').map((s, i) => {
                const idx = BD_STAGES.filter(x => x.id !== 'closed_lost').findIndex(x => x.id === sel.stage);
                return (
                  <div key={s.id} className="flex-1 flex flex-col items-center gap-1.5">
                    <div className={`h-7 w-7 rounded-full flex items-center justify-center text-[10px] font-bold ${i < idx ? 'bg-emerald-500 text-white' : i === idx ? 'bg-indigo-600 text-white ring-4 ring-indigo-100' : 'bg-zinc-100 text-zinc-400'}`}>{i < idx ? '✓' : i + 1}</div>
                    <span className={`text-[9px] font-medium text-center leading-tight ${i <= idx ? 'text-zinc-800' : 'text-zinc-400'}`}>{s.label}</span>
                  </div>
                );
              })}
            </div>

            {sel.stage === 'handed_to_land' ? (
              <button onClick={() => navigate('/land')} className="w-full py-2.5 bg-emerald-50 text-emerald-700 rounded-xl text-sm font-semibold flex items-center justify-center gap-2"><Building2 className="h-4 w-4" /> View the land parcel</button>
            ) : sel.stage === 'closed_lost' ? (
              <div className="text-center text-sm text-red-500 bg-red-50 rounded-xl py-2.5">Closed lost{sel.closedLostReason ? ` — ${sel.closedLostReason}` : ''}</div>
            ) : lostMode ? (
              <form onSubmit={async e => { e.preventDefault(); const r = new FormData(e.currentTarget).get('reason') as string; if (!r?.trim()) return; await closeLost(sel, r.trim(), actor); setLostMode(false); refresh(); toast.success('Marked closed-lost'); }} className="flex gap-2">
                <input name="reason" autoFocus placeholder="Why did this deal fall through?" className={inputCls} />
                <button type="submit" className="px-3.5 py-2 bg-red-600 text-white rounded-xl text-xs font-semibold hover:bg-red-700 whitespace-nowrap">Confirm</button>
                <button type="button" onClick={() => setLostMode(false)} className="px-3 py-2 border border-zinc-200 rounded-xl text-xs font-medium text-zinc-600">Cancel</button>
              </form>
            ) : (
              <div className="space-y-2">
                {canManage && sel.stage !== 'terms_negotiation' && (
                  <div className="flex gap-2">
                    {sel.stage === 'identified' && <button onClick={async () => { await advanceStage(sel, 'initial_discussion', actor); refresh(); }} className="flex-1 py-2.5 bg-zinc-100 text-zinc-700 rounded-xl text-sm font-semibold hover:bg-zinc-200">Move to Initial Discussion</button>}
                    {sel.stage === 'initial_discussion' && <button onClick={async () => { await advanceStage(sel, 'terms_negotiation', actor); refresh(); }} className="flex-1 py-2.5 bg-zinc-100 text-zinc-700 rounded-xl text-sm font-semibold hover:bg-zinc-200">Move to Terms Negotiation</button>}
                  </div>
                )}
                <div className="flex gap-2">
                  {/* Hand-off is the approver's gate — the moment commitment starts */}
                  {canHandOff && sel.stage === 'terms_negotiation' && (
                    <button onClick={doHandOff} className="flex-1 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700 flex items-center justify-center gap-2"><Map className="h-4 w-4" /> Hand off to Land</button>
                  )}
                  {sel.stage === 'terms_negotiation' && !canHandOff && (
                    <div className="flex-1 py-2.5 bg-indigo-50 text-indigo-700 rounded-xl text-sm font-semibold text-center">Awaiting hand-off approval</div>
                  )}
                  {canManage && (
                    <button onClick={() => setLostMode(true)} className="px-4 py-2.5 border border-red-200 text-red-500 rounded-xl text-sm font-semibold hover:bg-red-50">Closed Lost</button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add deal modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[88vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4"><h3 className="text-lg font-bold text-zinc-900">Log Opportunity</h3><button onClick={() => setShowAdd(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button></div>
            <form onSubmit={handleAdd} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Counterparty *</label><input name="counterpartyName" required placeholder="Sunrise Society / Mr. Shah" className={inputCls} /></div>
                <div><label className={labelCls}>Contact</label><input name="counterpartyContact" placeholder="+91 98xxxxxxxx" className={inputCls} /></div>
                <div><label className={labelCls}>Opportunity Type</label>
                  <select name="opportunityType" className={inputCls}>{BD_OPPORTUNITY_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
                </div>
                <div><label className={labelCls}>Source</label>
                  <select name="source" className={inputCls}><option value="broker">Broker</option><option value="direct_approach">Direct approach</option><option value="referral">Referral</option><option value="rfp">RFP</option></select>
                </div>
                <div><label className={labelCls}>City *</label><input name="city" required placeholder="Pune" className={inputCls} /></div>
                <div><label className={labelCls}>Est. Deal Value ({currency})</label><input name="estimatedDealValue" type="number" placeholder="150000000" className={inputCls} /></div>
                <div><label className={labelCls}>JV Structure <span className="normal-case font-normal text-zinc-400">(if JV)</span></label>
                  <select name="jvStructure" className={inputCls}><option value="revenue_share">Revenue share</option><option value="area_share">Area share</option><option value="outright_purchase">Outright purchase</option></select>
                </div>
                <div><label className={labelCls}>Revenue Share %</label><input name="revenueSharePercent" type="number" placeholder="40" className={inputCls} /></div>
                <div><label className={labelCls}>Area Share %</label><input name="areaSharePercent" type="number" placeholder="35" className={inputCls} /></div>
                <div className="col-span-2"><label className={labelCls}>JV Notes</label><input name="jvNotes" placeholder="Draft terms, key conditions…" className={inputCls} /></div>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowAdd(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Log Deal</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Market report modal */}
      {showReport && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowReport(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4"><h3 className="text-lg font-bold text-zinc-900">Log Market Analysis</h3><button onClick={() => setShowReport(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button></div>
            <form onSubmit={handleAddReport} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Area *</label><input name="areaName" required placeholder="Hinjewadi Phase 2" className={inputCls} /></div>
                <div><label className={labelCls}>Report Type</label>
                  <select name="reportType" className={inputCls}>{MARKET_REPORT_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
                </div>
              </div>
              <div><label className={labelCls}>Findings *</label><textarea name="findings" required rows={3} placeholder="Avg ₹8,200/sqft, 3 competitor launches this quarter…" className={`${inputCls} resize-none`} /></div>
              <div><label className={labelCls}>Data Sources</label><input name="dataSources" placeholder="99acres, on-ground survey" className={inputCls} /></div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowReport(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Save Analysis</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
