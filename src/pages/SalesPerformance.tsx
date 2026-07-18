import { useState, useMemo } from 'react';
import {
  TrendingUp, Users, Award, IndianRupee,
  Download, Filter, BarChart3, PieChart as PieChartIcon,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant } from '../services/db';
import { getLeadStages } from '../services/metaService';
import { formatCurrency } from '../utils/format';
import type { Lead, LeadStage, User as UserType } from '../types';
import { Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

export default function SalesPerformance() {
  const { tenant } = useAuth();
  const tenantId = tenant?.id || '';
  const currency = tenant?.currency || 'INR';
  const [refreshKey] = useState(0);
  const [timeRange, setTimeRange] = useState<'week' | 'month' | 'quarter' | 'year'>('month');

  const allLeads = useMemo(() => getByTenant<Lead>('leads', tenantId), [tenantId, refreshKey]);
  const allUsers = useMemo(() => getByTenant<UserType>('users', tenantId), [tenantId, refreshKey]);

  // Filter leads by time range
  const filteredLeads = useMemo(() => {
    const now = new Date();
    const ranges = {
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
      quarter: 90 * 24 * 60 * 60 * 1000,
      year: 365 * 24 * 60 * 60 * 1000,
    };
    const cutoff = new Date(now.getTime() - ranges[timeRange]);
    return allLeads.filter(l => new Date(l.createdAt) >= cutoff);
  }, [allLeads, timeRange]);

  // Calculate sales executive performance
  const salesExecs = allUsers.filter(u => u.role === 'sales_executive' && u.active);

  // Two mid-funnel stage columns, driven by the tenant's ACTUAL pipeline
  // (not hardcoded 'qualified'/'visit_scheduled', which break on rename/delete)
  const workStages = getLeadStages(tenantId).filter(s => !['new', 'booked', 'lost'].includes(s.id));
  const colA = workStages[0];
  const colB = workStages.length > 1 ? workStages[workStages.length - 1] : undefined;

  const execPerformance = salesExecs.map(exec => {
    const execLeads = filteredLeads.filter(l => l.assignedTo === exec.id);
    const bookedLeads = execLeads.filter(l => l.stage === 'booked');
    const revenue = bookedLeads.reduce((s, l) => s + l.budget, 0);
    const conversionRate = execLeads.length > 0 ? (bookedLeads.length / execLeads.length) * 100 : 0;

    return {
      id: exec.id,
      name: exec.name,
      leads: execLeads.length,
      booked: bookedLeads.length,
      conversionRate: conversionRate.toFixed(1),
      revenue,
      stageA: colA ? execLeads.filter(l => l.stage === colA.id).length : 0,
      stageB: colB ? execLeads.filter(l => l.stage === colB.id).length : 0,
    };
  }).sort((a, b) => b.revenue - a.revenue);

  // Automated coaching insights — find each agent's biggest funnel drop-off
  // versus the team average and surface it as a plain-language note
  const coachingInsights = useMemo(() => {
    // Metadata-driven: analyze whatever pipeline this tenant actually runs
    const pipelineDefs = getLeadStages(tenantId).filter(s => s.id !== 'lost');
    const stageOrder: LeadStage[] = pipelineDefs.map(s => s.id);
    const stageLabels = pipelineDefs.map(s => s.label);
    // A lead currently at stage N is assumed to have passed all earlier stages
    const reached = (pool: Lead[], idx: number) =>
      pool.filter(l => l.stage !== 'lost' && stageOrder.indexOf(l.stage) >= idx).length;
    const rates = (pool: Lead[]) =>
      stageOrder.slice(0, -1).map((_, i) => {
        const from = reached(pool, i);
        return from > 0 ? reached(pool, i + 1) / from : null;
      });
    const teamRates = rates(filteredLeads);

    const insights: { text: string; kind: 'warn' | 'praise' }[] = [];
    salesExecs.forEach(exec => {
      const pool = filteredLeads.filter(l => l.assignedTo === exec.id);
      if (pool.length < 2) return;
      const execRates = rates(pool);
      let worstGap = 0, worstIdx = -1;
      execRates.forEach((r, i) => {
        const team = teamRates[i];
        if (r === null || team === null) return;
        const gap = team - r;
        if (gap > worstGap && reached(pool, i) >= 2) { worstGap = gap; worstIdx = i; }
      });
      if (worstIdx >= 0 && worstGap >= 0.15) {
        const execPool = filteredLeads.filter(l => l.assignedTo === exec.id);
        const dropPct = Math.round((1 - (execRates[worstIdx] ?? 0)) * 100);
        insights.push({
          kind: 'warn',
          text: `${exec.name} has a ${dropPct}% drop-off between "${stageLabels[worstIdx]}" and "${stageLabels[worstIdx + 1]}" (team converts ${Math.round((teamRates[worstIdx] ?? 0) * 100)}% here, ${exec.name.split(' ')[0]} ${Math.round((execRates[worstIdx] ?? 0) * 100)}% across ${reached(execPool, worstIdx)} leads). Suggest reviewing their follow-up scripts for this stage.`,
        });
      }
    });
    // Praise the best closer so the report isn't only negative
    const best = [...execPerformance].sort((a, b) => Number(b.conversionRate) - Number(a.conversionRate))[0];
    if (best && Number(best.conversionRate) > 0) {
      insights.unshift({ kind: 'praise', text: `${best.name} leads the team at ${best.conversionRate}% overall conversion — consider having them share their site-visit playbook.` });
    }
    return insights.slice(0, 5);
    // Keyed on exec IDENTITY (ids), not count — swapping one exec for another
    // must recompute the insights
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredLeads, salesExecs.map(e => e.id).join(',')]);

  // Conversion funnel — built from the tenant's own pipeline definitions
  const FUNNEL_HEX = ['#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f59e0b', '#14b8a6', '#0ea5e9'];
  const funnelData = getLeadStages(tenantId)
    .filter(s => s.id !== 'lost')
    .map((s, i, arr) => ({
      stage: s.label,
      count: filteredLeads.filter(l => l.stage === s.id).length,
      color: i === arr.length - 1 ? '#10b981' : FUNNEL_HEX[i % FUNNEL_HEX.length],
    }));

  // Source distribution
  const sourceMap: Record<string, number> = {};
  filteredLeads.forEach(l => { sourceMap[l.source] = (sourceMap[l.source] || 0) + 1; });
  const sourceData = Object.entries(sourceMap).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);

  const COLORS = ['#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f59e0b', '#10b981', '#3b82f6'];

  // Aggregate stats
  const totalLeads = filteredLeads.length;
  const totalBooked = filteredLeads.filter(l => l.stage === 'booked').length;
  const overallConversion = totalLeads > 0 ? ((totalBooked / totalLeads) * 100).toFixed(1) : '0.0';
  const totalRevenue = filteredLeads.filter(l => l.stage === 'booked').reduce((s, l) => s + l.budget, 0);
  const avgDealSize = totalBooked > 0 ? totalRevenue / totalBooked : 0;

  // Top performer
  const topPerformer = execPerformance[0];

  return (
    <div className="space-y-6 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Sales Performance</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Track team performance, conversion rates, and revenue generation.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 bg-white border border-zinc-200 rounded-xl p-1">
            {(['week', 'month', 'quarter', 'year'] as const).map(range => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all capitalize ${timeRange === range ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
              >{range}</button>
            ))}
          </div>
          <button className="flex items-center gap-2 px-3 py-2 bg-white border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">
            <Download className="h-4 w-4" /> Export
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gradient-to-br from-indigo-500 to-violet-600 rounded-2xl p-4 text-white">
          <div className="flex items-center gap-2 mb-2">
            <Users className="h-5 w-5 text-indigo-200" />
            <span className="text-xs font-medium text-indigo-200">Total Leads</span>
          </div>
          <p className="text-3xl font-bold">{totalLeads}</p>
          <p className="text-xs text-indigo-200 mt-1">In {timeRange}</p>
        </div>
        <div className="bg-gradient-to-br from-emerald-500 to-teal-600 rounded-2xl p-4 text-white">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="h-5 w-5 text-emerald-200" />
            <span className="text-xs font-medium text-emerald-200">Conversion Rate</span>
          </div>
          <p className="text-3xl font-bold">{overallConversion}%</p>
          <p className="text-xs text-emerald-200 mt-1">Lead to booking</p>
        </div>
        <div className="bg-gradient-to-br from-amber-500 to-orange-600 rounded-2xl p-4 text-white">
          <div className="flex items-center gap-2 mb-2">
            <IndianRupee className="h-5 w-5 text-amber-200" />
            <span className="text-xs font-medium text-amber-200">Total Revenue</span>
          </div>
          <p className="text-3xl font-bold">{formatCurrency(totalRevenue, currency)}</p>
          <p className="text-xs text-amber-200 mt-1">Booked value</p>
        </div>
        <div className="bg-gradient-to-br from-violet-500 to-purple-600 rounded-2xl p-4 text-white">
          <div className="flex items-center gap-2 mb-2">
            <Award className="h-5 w-5 text-violet-200" />
            <span className="text-xs font-medium text-violet-200">Avg Deal Size</span>
          </div>
          <p className="text-3xl font-bold">{formatCurrency(avgDealSize, currency)}</p>
          <p className="text-xs text-violet-200 mt-1">Per booking</p>
        </div>
      </div>

      {/* Top Performer */}
      {topPerformer && (
        <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-5">
          <div className="flex items-center gap-4">
            <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center">
              <Award className="h-8 w-8 text-white" />
            </div>
            <div className="flex-1">
              <p className="text-xs font-semibold text-amber-900 uppercase tracking-wider mb-1">🏆 Top Performer</p>
              <p className="text-xl font-bold text-zinc-900">{topPerformer.name}</p>
              <div className="flex items-center gap-4 mt-2">
                <span className="text-xs text-zinc-600"><span className="font-bold text-zinc-900">{topPerformer.leads}</span> leads</span>
                <span className="text-xs text-zinc-600"><span className="font-bold text-emerald-600">{topPerformer.booked}</span> booked</span>
                <span className="text-xs text-zinc-600"><span className="font-bold text-zinc-900">{topPerformer.conversionRate}%</span> conversion</span>
                <span className="text-xs text-zinc-600"><span className="font-bold text-zinc-900">{formatCurrency(topPerformer.revenue, currency)}</span> revenue</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sales Leaderboard */}
      <div className="bg-white rounded-2xl border border-zinc-200/60 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-zinc-900">Sales Team Leaderboard</h3>
            <p className="text-xs text-zinc-500">Performance ranking by revenue generated</p>
          </div>
          <div className="flex items-center gap-2">
            <button className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-400">
              <Filter className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="space-y-2">
          {execPerformance.map((exec, i) => (
            <div key={exec.id} className="flex items-center gap-4 p-3 rounded-xl border border-zinc-100 hover:bg-zinc-50/50 transition-colors">
              <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${
                i === 0 ? 'bg-gradient-to-br from-amber-400 to-orange-500' :
                i === 1 ? 'bg-gradient-to-br from-zinc-300 to-zinc-400' :
                i === 2 ? 'bg-gradient-to-br from-orange-300 to-orange-400' :
                'bg-zinc-100'
              }`}>
                <span className={`text-sm font-bold ${i < 3 ? 'text-white' : 'text-zinc-600'}`}>
                  {i < 3 ? ['🥇', '🥈', '🥉'][i] : `#${i + 1}`}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-zinc-900">{exec.name}</p>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-[11px] text-zinc-500">{exec.leads} leads</span>
                  <span className="text-[11px] text-emerald-600 font-semibold">{exec.booked} booked</span>
                  <span className="text-[11px] text-zinc-500">{exec.conversionRate}% conversion</span>
                </div>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-zinc-900">{formatCurrency(exec.revenue, currency)}</p>
                <p className="text-[11px] text-zinc-500">Revenue</p>
              </div>
            </div>
          ))}
          {execPerformance.length === 0 && (
            <div className="py-8 text-center text-sm text-zinc-400">
              <Users className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p>No sales executives found</p>
            </div>
          )}
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Conversion Funnel */}
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-zinc-900">Conversion Funnel</h3>
              <p className="text-xs text-zinc-500">Lead progression through stages</p>
            </div>
            <BarChart3 className="h-5 w-5 text-zinc-400" />
          </div>
          <div className="space-y-2">
            {funnelData.map((item) => {
              const width = totalLeads > 0 ? (item.count / totalLeads) * 100 : 0;
              return (
                <div key={item.stage}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-zinc-700">{item.stage}</span>
                    <span className="text-xs font-bold text-zinc-900">{item.count}</span>
                  </div>
                  <div className="h-8 bg-zinc-100 rounded-lg overflow-hidden">
                    <div
                      className="h-full rounded-lg transition-all duration-500 flex items-center justify-end pr-2"
                      style={{ width: `${width}%`, backgroundColor: item.color }}
                    >
                      {width > 10 && (
                        <span className="text-[10px] font-bold text-white">{width.toFixed(1)}%</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Lead Source Distribution */}
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-zinc-900">Lead Source Distribution</h3>
              <p className="text-xs text-zinc-500">Where your leads come from</p>
            </div>
            <PieChartIcon className="h-5 w-5 text-zinc-400" />
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                  <Pie
                    data={sourceData}
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    dataKey="value"
                    label={(entry: any) => `${entry.name || ''} ${((entry.percent || 0) * 100).toFixed(0)}%`}
                  >
                    {sourceData.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Performance Metrics Table */}
      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100">
          <h3 className="font-semibold text-zinc-900">Detailed Performance Metrics</h3>
          <p className="text-xs text-zinc-500">Complete breakdown of sales team performance</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-zinc-50/50 border-b border-zinc-100">
                <th className="text-left px-5 py-3 text-xs font-semibold text-zinc-500 uppercase">Sales Executive</th>
                <th className="text-center px-5 py-3 text-xs font-semibold text-zinc-500 uppercase">Leads</th>
                <th className="text-center px-5 py-3 text-xs font-semibold text-zinc-500 uppercase">{colA?.label || '—'}</th>
                {colB && <th className="text-center px-5 py-3 text-xs font-semibold text-zinc-500 uppercase">{colB.label}</th>}
                <th className="text-center px-5 py-3 text-xs font-semibold text-zinc-500 uppercase">Booked</th>
                <th className="text-center px-5 py-3 text-xs font-semibold text-zinc-500 uppercase">Conversion</th>
                <th className="text-right px-5 py-3 text-xs font-semibold text-zinc-500 uppercase">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {execPerformance.map(exec => (
                <tr key={exec.id} className="border-b border-zinc-50 hover:bg-zinc-50/50 transition-colors">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-indigo-100 to-violet-100 flex items-center justify-center">
                        <span className="text-xs font-bold text-indigo-600">{exec.name.split(' ').map(n => n[0]).join('')}</span>
                      </div>
                      <span className="text-sm font-semibold text-zinc-900">{exec.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-center text-sm font-semibold text-zinc-900">{exec.leads}</td>
                  <td className="px-5 py-3.5 text-center text-sm font-semibold text-zinc-900">{exec.stageA}</td>
                  {colB && <td className="px-5 py-3.5 text-center text-sm font-semibold text-zinc-900">{exec.stageB}</td>}
                  <td className="px-5 py-3.5 text-center text-sm font-semibold text-emerald-600">{exec.booked}</td>
                  <td className="px-5 py-3.5 text-center text-sm font-semibold text-zinc-900">{exec.conversionRate}%</td>
                  <td className="px-5 py-3.5 text-right text-sm font-bold text-zinc-900">{formatCurrency(exec.revenue, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Automated coaching report */}
      <div className="bg-white rounded-2xl border border-zinc-200/60 p-5">
        <div className="flex items-center gap-2 mb-1">
          <Award className="h-4 w-4 text-indigo-500" />
          <h3 className="font-semibold text-zinc-900">Coaching Insights</h3>
          <span className="text-[10px] font-semibold bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full">AUTO-GENERATED</span>
        </div>
        <p className="text-xs text-zinc-500 mb-4">Conversion bottlenecks detected from your pipeline data — where each agent loses deals versus the team average.</p>
        {coachingInsights.length === 0 ? (
          <p className="text-sm text-zinc-400 text-center py-4">Not enough pipeline history in this period to generate insights.</p>
        ) : (
          <div className="space-y-2">
            {coachingInsights.map((ins, i) => (
              <div key={i} className={`flex items-start gap-3 p-3 rounded-xl text-sm ${ins.kind === 'praise' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>
                <span className="shrink-0">{ins.kind === 'praise' ? '🏆' : '📉'}</span>
                <p>{ins.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
