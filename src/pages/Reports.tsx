import { useState, useMemo, useEffect } from 'react';
import { BarChart3, TrendingUp, Users, IndianRupee, Download, Printer } from 'lucide-react';
import { formatCurrencyFull } from '../utils/format';
import { downloadCsv } from '../utils/csv';
import toast from 'react-hot-toast';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area } from 'recharts';
import { useAuth } from '../context/AuthContext';
import { getByTenant } from '../services/db';
import { useTenantUsers } from '../hooks/useTenantUsers';
import { getLeadStages } from '../services/metaService';
import { formatCurrency } from '../utils/format';
import DateRangeFilter from '../components/DateRangeFilter';
import { type DateRange, ALL_RANGE, resolveRange, inRange, rangeLabel, rangeSlug } from '../utils/dateRange';
import type { Lead } from '../types';

const sourceColors: Record<string, string> = {
  Website: '#6366f1', 'Google Ads': '#8b5cf6', Referral: '#10b981',
  'Housing.com': '#f59e0b', Instagram: '#ec4899', Facebook: '#06b6d4',
  'Walk-in': '#14b8a6', Manual: '#a1a1aa',
  WhatsApp: '#22c55e', '99acres': '#ef4444', MagicBricks: '#f97316',
  Zapier: '#eab308', Pabbly: '#3b82f6', Chatbot: '#a855f7', Microsite: '#0891b2',
};

export default function Reports() {
  const { user, tenant } = useAuth();
  const tenantId = tenant?.id || '';
  const userId = user?.id || '';
  const currency = tenant?.currency || 'INR';
  const isExecutive = user?.role === 'sales_executive';
  const [reportType, setReportType] = useState<'conversion' | 'source' | 'performance' | 'roi'>('conversion');
  const [dateRange, setDateRange] = useState<DateRange>(ALL_RANGE);

  // Marketing spend per source — editable, persisted per tenant. Powers the
  // cost-per-lead / cost-per-closure / ROI analysis.
  const [spendBySource, setSpendBySource] = useState<Record<string, number>>({});
  // Re-seed whenever the tenant changes — the initializer alone would leak
  // the previous tenant's spend into the next one
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`friendly_crm_marketing_spend_${tenantId}`);
      setSpendBySource(raw ? JSON.parse(raw) : {});
    } catch { setSpendBySource({}); }
  }, [tenantId]);
  const saveSpend = (source: string, value: number) => {
    const next = { ...spendBySource, [source]: value };
    setSpendBySource(next);
    localStorage.setItem(`friendly_crm_marketing_spend_${tenantId}`, JSON.stringify(next));
  };

  const allLeadsData = useMemo(() => getByTenant<Lead>('leads', tenantId), [tenantId]);
  const scopedLeads = useMemo(() => isExecutive ? allLeadsData.filter(l => l.assignedTo === userId) : allLeadsData, [allLeadsData, isExecutive, userId]);
  // Every aggregation below runs on leads received within the selected window.
  // preset 'all' → leads === scopedLeads, so reports are unchanged by default.
  const leads = useMemo(() => {
    const r = resolveRange(dateRange);
    return scopedLeads.filter(l => inRange(l.createdAt, r));
  }, [scopedLeads, dateRange]);
  const allUsers = useTenantUsers(tenantId);

  // Dynamic conversion data from actual leads
  const conversionData = useMemo(() => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthlyData: Record<string, { leads: number; conversions: number }> = {};

    leads.forEach(lead => {
      const leadDate = new Date(lead.createdAt);
      const monthKey = `${leadDate.getFullYear()}-${String(leadDate.getMonth() + 1).padStart(2, '0')}`;
      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { leads: 0, conversions: 0 };
      }
      monthlyData[monthKey].leads++;
      if (lead.stage === 'booked') {
        monthlyData[monthKey].conversions++;
      }
    });

    // Return last 6 months of data
    return Object.entries(monthlyData)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)
      .map(([monthKey, data]) => {
        const [year, month] = monthKey.split('-');
        return {
          month: `${months[parseInt(month) - 1]} ${year.slice(2)}`,
          leads: data.leads,
          conversions: data.conversions,
          rate: data.leads > 0 ? parseFloat(((data.conversions / data.leads) * 100).toFixed(1)) : 0,
        };
      });
  }, [leads]);

  // Pipeline stages
  // Metadata-driven: the pipeline summary follows the tenant's stage definitions
  const pipelineStages = getLeadStages(tenantId)
    .filter(s => s.id !== 'lost')
    .map(s => ({
      stage: s.label,
      count: leads.filter(l => l.stage === s.id).length,
      value: leads.filter(l => l.stage === s.id).reduce((sum, l) => sum + l.budget, 0),
    }));

  // Source distribution
  const sourceMap: Record<string, number> = {};
  leads.forEach(l => { sourceMap[l.source] = (sourceMap[l.source] || 0) + 1; });
  const sourceData = Object.entries(sourceMap).map(([name, value]) => ({
    name, value, color: sourceColors[name] || '#6366f1',
  }));

  // Sales performance
  const salesMap: Record<string, { id: string; name: string; leads: number; bookings: number; revenue: number }> = {};
  leads.forEach(lead => {
    if (!salesMap[lead.assignedTo]) {
      const assignedUser = allUsers.find(u => u.id === lead.assignedTo);
      salesMap[lead.assignedTo] = { id: lead.assignedTo, name: assignedUser?.name || 'Unassigned', leads: 0, bookings: 0, revenue: 0 };
    }
    salesMap[lead.assignedTo].leads++;
    if (lead.stage === 'booked') { salesMap[lead.assignedTo].bookings++; salesMap[lead.assignedTo].revenue += lead.budget; }
  });
  const salesPerformance = Object.values(salesMap).sort((a, b) => b.revenue - a.revenue);

  const maxPipelineCount = Math.max(...pipelineStages.map(s => s.count), 1);

  /** Export whichever report is on screen as an Excel-safe CSV. */
  const handleExport = () => {
    const today = new Date().toISOString().slice(0, 10);
    const scope = dateRange.preset === 'all' ? '' : `-${rangeSlug(dateRange)}`;
    if (reportType === 'conversion') {
      if (conversionData.length === 0) { toast.error('No data to export yet'); return; }
      downloadCsv(`conversion-trend${scope}-${today}.csv`, [
        ['Month', 'Leads', 'Conversions', 'Conversion Rate %'],
        ...conversionData.map(d => [d.month, d.leads, d.conversions, d.rate]),
      ]);
    } else if (reportType === 'source') {
      if (sourceData.length === 0) { toast.error('No data to export yet'); return; }
      downloadCsv(`lead-sources${scope}-${today}.csv`, [
        ['Source', 'Leads'],
        ...sourceData.map(s => [s.name, s.value]),
      ]);
    } else if (reportType === 'performance') {
      if (salesPerformance.length === 0) { toast.error('No data to export yet'); return; }
      downloadCsv(`team-performance${scope}-${today}.csv`, [
        ['Rep', 'Leads', 'Bookings', 'Revenue'],
        ...salesPerformance.map(r => [r.name, r.leads, r.bookings, r.revenue]),
      ]);
    } else {
      const bySource = leads.reduce((acc, l) => {
        if (!acc[l.source]) acc[l.source] = { leads: 0, bookings: 0, revenue: 0 };
        acc[l.source].leads++;
        if (l.stage === 'booked') { acc[l.source].bookings++; acc[l.source].revenue += l.budget; }
        return acc;
      }, {} as Record<string, { leads: number; bookings: number; revenue: number }>);
      const rows = Object.entries(bySource);
      if (rows.length === 0) { toast.error('No data to export yet'); return; }
      downloadCsv(`marketing-roi${scope}-${today}.csv`, [
        ['Source', 'Spend', 'Leads', 'Bookings', 'Revenue', 'ROI %'],
        ...rows.map(([source, d]) => {
          const spend = spendBySource[source] || 0;
          return [source, spend, d.leads, d.bookings, d.revenue, spend > 0 ? (((d.revenue - spend) / spend) * 100).toFixed(0) : ''];
        }),
      ]);
    }
    toast.success('Exported as CSV (opens in Excel)');
  };

  return (
    <div className="space-y-6 max-w-[1400px]">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Reports & Analytics</h2>
          <p className="text-sm text-zinc-500 mt-0.5">
            Track performance across leads, sales, and inventory.
            {dateRange.preset !== 'all' && (
              <span className="text-indigo-600 font-medium"> · {rangeLabel(dateRange)}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DateRangeFilter value={dateRange} onChange={setDateRange} align="right" />
          <button onClick={handleExport} className="flex items-center gap-2 px-3 py-2 bg-white border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors">
            <Download className="h-4 w-4" /> Export CSV
          </button>
          <button onClick={() => window.print()} className="flex items-center gap-2 px-3 py-2 bg-white border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors">
            <Printer className="h-4 w-4" /> Print / PDF
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 bg-white border border-zinc-200 rounded-xl p-1 inline-flex">
        {[
          { id: 'conversion' as const, label: 'Conversion Funnel', icon: TrendingUp },
          { id: 'source' as const, label: 'Lead Sources', icon: Users },
          { id: 'performance' as const, label: 'Team Performance', icon: BarChart3 },
          { id: 'roi' as const, label: 'Marketing ROI', icon: IndianRupee },
        ].map(tab => (
          <button key={tab.id} onClick={() => setReportType(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              reportType === tab.id ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-700'
            }`}
          ><tab.icon className="h-4 w-4" /> {tab.label}</button>
        ))}
      </div>

      {/* Cost-per-closure: spend vs revenue by source */}
      {reportType === 'roi' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-6">
          <h3 className="font-semibold text-zinc-900 mb-1">Cost-Per-Closure Analysis</h3>
          <p className="text-xs text-zinc-500 mb-4">Enter your monthly marketing spend per source to see true acquisition cost and ROI. Spend is saved automatically.</p>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-zinc-50/50 border-b border-zinc-100">
                  {['Source', 'Spend', 'Leads', 'Cost / Lead', 'Bookings', 'Cost / Closure', 'Revenue', 'ROI'].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider first:pl-4">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(
                  leads.reduce((acc, l) => {
                    if (!acc[l.source]) acc[l.source] = { leads: 0, bookings: 0, revenue: 0 };
                    acc[l.source].leads++;
                    if (l.stage === 'booked') { acc[l.source].bookings++; acc[l.source].revenue += l.budget; }
                    return acc;
                  }, {} as Record<string, { leads: number; bookings: number; revenue: number }>)
                ).sort(([, a], [, b]) => b.revenue - a.revenue).map(([source, d]) => {
                  const spend = spendBySource[source] || 0;
                  const roi = spend > 0 ? ((d.revenue - spend) / spend) * 100 : null;
                  return (
                    <tr key={source} className="border-b border-zinc-50">
                      <td className="px-4 py-3 text-sm font-medium text-zinc-900">{source}</td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          value={spend || ''}
                          placeholder="0"
                          onChange={e => saveSpend(source, Number(e.target.value) || 0)}
                          className="w-28 px-2 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                        />
                      </td>
                      <td className="px-4 py-3 text-sm text-zinc-700">{d.leads}</td>
                      <td className="px-4 py-3 text-sm text-zinc-700">{spend > 0 ? formatCurrencyFull(Math.round(spend / d.leads), tenant?.currency || 'INR') : '—'}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-emerald-600">{d.bookings}</td>
                      <td className="px-4 py-3 text-sm text-zinc-700">
                        {spend > 0 && d.bookings > 0 ? formatCurrencyFull(Math.round(spend / d.bookings), tenant?.currency || 'INR') : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm font-semibold text-zinc-900">{formatCurrencyFull(d.revenue, tenant?.currency || 'INR')}</td>
                      <td className="px-4 py-3">
                        {roi === null ? <span className="text-xs text-zinc-400">enter spend</span> : (
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${roi >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                            {roi >= 0 ? '+' : ''}{roi.toFixed(0)}%
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {reportType !== 'roi' && (
        <div className="lg:col-span-2 bg-white rounded-2xl border border-zinc-200/60 p-6">
          <h3 className="font-semibold text-zinc-900 mb-4">
            {reportType === 'conversion' && 'Lead Conversion Trend'}
            {reportType === 'source' && 'Lead Source Distribution'}
            {reportType === 'performance' && 'Sales Performance'}
          </h3>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              {reportType === 'conversion' ? (
                <AreaChart data={conversionData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
                  <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#a1a1aa' }} axisLine={false} tickLine={false} />
                  <YAxis yAxisId="left" tick={{ fontSize: 12, fill: '#a1a1aa' }} axisLine={false} tickLine={false} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12, fill: '#a1a1aa' }} axisLine={false} tickLine={false} domain={[0, 100]} />
                  <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e4e4e7', boxShadow: '0 4px 16px rgba(0,0,0,0.08)' }} />
                  <Area yAxisId="left" type="monotone" dataKey="leads" stroke="#6366f1" fill="#6366f1" fillOpacity={0.1} strokeWidth={2} name="Leads" />
                  <Area yAxisId="right" type="monotone" dataKey="rate" stroke="#10b981" fill="#10b981" fillOpacity={0.1} strokeWidth={2} name="Conversion Rate %" />
                </AreaChart>
              ) : reportType === 'source' ? (
                <PieChart>
                  <Pie data={sourceData.length > 0 ? sourceData : [{ name: 'No data', value: 1, color: '#e4e4e7' }]} cx="50%" cy="50%" outerRadius={130} innerRadius={80} dataKey="value" nameKey="name">
                    {(sourceData.length > 0 ? sourceData : [{ name: 'No data', value: 1, color: '#e4e4e7' }]).map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e4e4e7' }} />
                </PieChart>
              ) : (
                <BarChart data={salesPerformance} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
                  <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#a1a1aa' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: '#a1a1aa' }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e4e4e7', boxShadow: '0 4px 16px rgba(0,0,0,0.08)' }} />
                  <Bar dataKey="leads" fill="#6366f1" radius={[6, 6, 0, 0]} name="Leads" />
                  <Bar dataKey="bookings" fill="#10b981" radius={[6, 6, 0, 0]} name="Bookings" />
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        </div>
        )}

        <div className="bg-white rounded-2xl border border-zinc-200/60 p-6">
          <h3 className="font-semibold text-zinc-900 mb-4">Pipeline Summary</h3>
          <div className="space-y-4">
            {pipelineStages.map(stage => (
              <div key={stage.stage}>
                <div className="flex justify-between text-sm mb-1.5">
                  <span className="text-zinc-600 font-medium">{stage.stage}</span>
                  <span className="text-zinc-900 font-semibold">{stage.count}</span>
                </div>
                <div className="h-2.5 bg-zinc-100 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 rounded-full" style={{ width: `${Math.max(5, (stage.count / maxPipelineCount) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-zinc-200/60 p-6">
          <h3 className="font-semibold text-zinc-900 mb-4">Sales Rep Rankings</h3>
          <div className="space-y-3">
            {salesPerformance.map((rep, i) => (
              <div key={rep.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-zinc-50 transition-colors">
                <div className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold ${
                  i === 0 ? 'bg-amber-100 text-amber-700' : i === 1 ? 'bg-zinc-100 text-zinc-500' : 'bg-orange-100 text-orange-700'
                }`}>#{i + 1}</div>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-zinc-800">{rep.name}</p>
                  <div className="flex gap-3 text-[11px] text-zinc-500 mt-0.5">
                    <span>{rep.leads} leads</span>
                    <span>{rep.bookings} bookings</span>
                  </div>
                </div>
                <p className="text-sm font-bold text-zinc-900">{formatCurrency(rep.revenue, currency)}</p>
              </div>
            ))}
            {salesPerformance.length === 0 && <p className="text-sm text-zinc-400 text-center py-8">No sales data yet</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
