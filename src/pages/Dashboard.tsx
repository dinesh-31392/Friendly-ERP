import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Users, TrendingUp, IndianRupee, Building2, CheckCircle, BarChart3,
  ArrowUpRight, ArrowDownRight, Clock, Phone, MessageCircle, Calendar,
  AlertTriangle, Eye, MoreHorizontal, HardHat, Flag, FileQuestion, Package,
  ShoppingCart, CalendarClock, Landmark, ClipboardCheck,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, update, logAudit } from '../services/db';
import { useTenantUsers } from '../hooks/useTenantUsers';
import { getLeadStages } from '../services/metaService';
import { isModuleEnabled } from '../services/planService';
import { projectProgress, projectHealth, nextMilestone, HEALTH_META } from '../services/executionService';
import { lowStockMaterials, machinesDueForService, isBillOverdue } from '../services/procurementService';
import { formatCurrency } from '../utils/format';
import type { Lead, Task, Unit, Activity, User as UserType, Project, SiteTask, Rfi, Inspection, PurchaseOrder, VendorBill, Invoice } from '../types';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const iconMap: Record<string, React.ElementType> = {
  'users': Users, 'trending-up': TrendingUp, 'indian-rupee': IndianRupee,
  'building': Building2, 'check-circle': CheckCircle, 'bar-chart': BarChart3,
  'hard-hat': HardHat, 'alert': AlertTriangle,
};

export default function Dashboard() {
  const { user, tenant, hasPermission } = useAuth();
  const [timeRange, setTimeRange] = useState<'today' | 'week' | 'month'>('week');
  const [refreshKey, setRefreshKey] = useState(0);

  const tenantId = tenant?.id || '';
  const userId = user?.id || '';
  const currency = tenant?.currency || 'INR';
  const isExecutive = user?.role === 'sales_executive';

  const allLeads = useMemo(() => getByTenant<Lead>('leads', tenantId), [tenantId, refreshKey]);
  const allTasks = useMemo(() => getByTenant<Task>('tasks', tenantId), [tenantId, refreshKey]);
  const units = useMemo(() => getByTenant<Unit>('units', tenantId), [tenantId, refreshKey]);
  const activities = useMemo(() => getByTenant<Activity>('activities', tenantId), [tenantId, refreshKey]);
  const users = useTenantUsers(tenantId, refreshKey);

  // ERP visibility — each block needs both the permission AND the module on
  const moduleOn = (key: string) => isModuleEnabled(tenant, key);
  const showExecution = hasPermission('view_execution') && moduleOn('execution');
  const showProcurement = hasPermission('view_procurement') && moduleOn('procurement');
  const showFinance = hasPermission('view_finance') && moduleOn('billing');

  const projects = useMemo(() => getByTenant<Project>('projects', tenantId), [tenantId, refreshKey]);
  const siteTasks = useMemo(
    () => showExecution ? getByTenant<SiteTask>('siteTasks', tenantId) : [],
    [tenantId, refreshKey, showExecution]
  );
  const projectBoard = useMemo(
    () => showExecution
      ? projects.map(p => ({
          project: p,
          progress: projectProgress(tenantId, p.id),
          health: projectHealth(tenantId, p.id),
          milestone: nextMilestone(tenantId, p.id),
        }))
      : [],
    [projects, tenantId, refreshKey, showExecution]
  );
  const overdueSiteTasks = siteTasks.filter(t => t.status !== 'done' && new Date(t.dueDate).getTime() < Date.now());
  const openRfis = useMemo(
    () => showExecution ? getByTenant<Rfi>('rfis', tenantId).filter(r => r.status === 'open') : [],
    [tenantId, refreshKey, showExecution]
  );
  const failedInspections = useMemo(
    () => showExecution ? getByTenant<Inspection>('inspections', tenantId).filter(i => i.status === 'failed') : [],
    [tenantId, refreshKey, showExecution]
  );
  const lowStock = useMemo(
    () => showProcurement ? lowStockMaterials(tenantId) : [],
    [tenantId, refreshKey, showProcurement]
  );
  const pendingPos = useMemo(
    () => showProcurement && hasPermission('approve_purchase_orders')
      ? getByTenant<PurchaseOrder>('purchaseOrders', tenantId).filter(p => p.status === 'pending_approval')
      : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tenantId, refreshKey, showProcurement]
  );
  const serviceDue = useMemo(
    () => showProcurement ? machinesDueForService(tenantId) : [],
    [tenantId, refreshKey, showProcurement]
  );
  const overdueBills = useMemo(
    () => showFinance ? getByTenant<VendorBill>('vendorBills', tenantId).filter(isBillOverdue) : [],
    [tenantId, refreshKey, showFinance]
  );
  // Collections this month + overdue receivables — the CFO half of the KPI spec
  const invoices = useMemo(
    () => showFinance ? getByTenant<Invoice>('invoices', tenantId) : [],
    [tenantId, refreshKey, showFinance]
  );
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const collectionsThisMonth = invoices
    .filter(i => i.status === 'Paid' && new Date(i.date) >= monthStart)
    .reduce((s, i) => s + i.amount, 0);
  const overdueReceivables = invoices
    .filter(i => i.status === 'Overdue' || (i.status === 'Pending' && new Date(i.dueDate) < new Date()))
    .reduce((s, i) => s + i.amount, 0);

  const opsAlerts: { icon: React.ElementType; color: string; label: string; link: string }[] = [
    ...(overdueSiteTasks.length ? [{ icon: Clock, color: 'text-red-500', label: `${overdueSiteTasks.length} site task${overdueSiteTasks.length === 1 ? '' : 's'} overdue`, link: '/execution' }] : []),
    ...(failedInspections.length ? [{ icon: ClipboardCheck, color: 'text-red-500', label: `${failedInspections.length} failed inspection${failedInspections.length === 1 ? ' needs' : 's need'} corrective action`, link: '/execution' }] : []),
    ...(openRfis.length ? [{ icon: FileQuestion, color: 'text-amber-500', label: `${openRfis.length} RFI${openRfis.length === 1 ? '' : 's'} awaiting an answer`, link: '/execution' }] : []),
    ...(lowStock.length ? [{ icon: Package, color: 'text-red-500', label: `Reorder: ${lowStock.map(l => l.material.name).slice(0, 3).join(', ')}${lowStock.length > 3 ? '…' : ''}`, link: '/procurement' }] : []),
    ...(pendingPos.length ? [{ icon: ShoppingCart, color: 'text-amber-500', label: `${pendingPos.length} purchase order${pendingPos.length === 1 ? '' : 's'} awaiting your approval`, link: '/procurement' }] : []),
    ...(serviceDue.length ? [{ icon: CalendarClock, color: 'text-amber-500', label: `${serviceDue.length} machine${serviceDue.length === 1 ? '' : 's'} due for service`, link: '/procurement' }] : []),
    ...(overdueBills.length ? [{ icon: Landmark, color: 'text-red-500', label: `${overdueBills.length} vendor bill${overdueBills.length === 1 ? '' : 's'} overdue`, link: '/billing' }] : []),
  ];

  // Performance: Create lookup maps for O(1) access
  const userMap = useMemo(() => {
    const map = new Map<string, UserType>();
    users.forEach(u => map.set(u.id, u));
    return map;
  }, [users]);

  const leadMap = useMemo(() => {
    const map = new Map<string, Lead>();
    allLeads.forEach(l => map.set(l.id, l));
    return map;
  }, [allLeads]);

  // Sales executives only see their own leads/tasks
  const leads = isExecutive ? allLeads.filter(l => l.assignedTo === userId) : allLeads;
  const tasks = isExecutive ? allTasks.filter(t => t.userId === userId) : allTasks;

  const totalLeads = leads.length;
  const bookedLeads = leads.filter(l => l.stage === 'booked').length;
  const conversionRate = totalLeads > 0 ? ((bookedLeads / totalLeads) * 100).toFixed(1) : '0.0';
  const availableUnits = units.filter(u => u.status === 'available').length;
  const totalRevenue = leads.filter(l => l.stage === 'booked').reduce((s, l) => s + l.budget, 0);
  const avgDealSize = bookedLeads > 0 ? (totalRevenue / bookedLeads) : 0;

  // Real 30-day deltas computed from lead createdAt; null = not enough
  // history to compare, so no trend badge is shown (no fabricated numbers)
  const THIRTY_DAYS = 30 * 86400000;
  const nowMs = Date.now();
  const inLast30 = (iso: string) => nowMs - new Date(iso).getTime() <= THIRTY_DAYS;
  const inPrev30 = (iso: string) => {
    const age = nowMs - new Date(iso).getTime();
    return age > THIRTY_DAYS && age <= 2 * THIRTY_DAYS;
  };
  const pctChange = (curr: number, prev: number): number | null =>
    prev > 0 ? Number((((curr - prev) / prev) * 100).toFixed(1)) : null;

  const leadsChange = pctChange(leads.filter(l => inLast30(l.createdAt)).length, leads.filter(l => inPrev30(l.createdAt)).length);
  const bookedCurr = leads.filter(l => l.stage === 'booked' && inLast30(l.createdAt));
  const bookedPrev = leads.filter(l => l.stage === 'booked' && inPrev30(l.createdAt));
  const bookingsChange = pctChange(bookedCurr.length, bookedPrev.length);
  const revenueChange = pctChange(bookedCurr.reduce((s, l) => s + l.budget, 0), bookedPrev.reduce((s, l) => s + l.budget, 0));

  const kpiData: { label: string; value: string | number; change: number | null; icon: string }[] = [
    { label: isExecutive ? 'My Leads' : 'Total Leads', value: totalLeads, change: leadsChange, icon: 'users' },
    { label: 'Conversion Rate', value: `${conversionRate}%`, change: null, icon: 'trending-up' },
    { label: isExecutive ? 'My Revenue' : 'Revenue', value: formatCurrency(totalRevenue, currency), change: revenueChange, icon: 'indian-rupee' },
    { label: 'Available Units', value: availableUnits, change: null, icon: 'building' },
    { label: 'Bookings', value: bookedLeads, change: bookingsChange, icon: 'check-circle' },
    { label: 'Avg Deal', value: formatCurrency(avgDealSize, currency), change: null, icon: 'bar-chart' },
    // Role-tailored ERP KPIs (spec §5): projects for execution roles, cash
    // position for finance roles — appended so sales KPIs keep their spots
    ...(showExecution ? [
      { label: 'Active Projects', value: projects.filter(p => p.status !== 'completed').length, change: null, icon: 'hard-hat' },
    ] : []),
    ...(showFinance ? [
      { label: 'Collections (Month)', value: formatCurrency(collectionsThisMonth, currency), change: null, icon: 'indian-rupee' },
      { label: 'Overdue Receivables', value: formatCurrency(overdueReceivables, currency), change: null, icon: 'alert' },
    ] : []),
  ];

  // Metadata-driven: the pipeline reflects the tenant's own stage definitions
  const pipelineStages = getLeadStages(tenantId)
    .filter(s => s.id !== 'lost')
    .map(s => ({
      stage: s.label,
      stageId: s.id,
      count: leads.filter(l => l.stage === s.id).length,
      value: leads.filter(l => l.stage === s.id).reduce((a, l) => a + l.budget, 0),
    }));

  // Build weekly data from actual activity dates
  // Fixed: Show 0 instead of random data when no actual data exists
  const weeklyData = useMemo(() => {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const now = new Date();
    return Array.from({ length: 7 }, (_, i) => {
      const day = new Date(now.getTime() - (6 - i) * 86400000);
      const dayLeads = leads.filter(l => {
        const d = new Date(l.createdAt);
        return d.toDateString() === day.toDateString();
      }).length;
      const dayConv = leads.filter(l => {
        const d = new Date(l.lastContact);
        return d.toDateString() === day.toDateString() && l.stage === 'booked';
      }).length;
      // Show actual data (0 if none) instead of random fake data
      return { day: days[day.getDay()], leads: dayLeads, conversions: dayConv };
    });
  }, [leads]);

  const maxPipelineCount = Math.max(...pipelineStages.map(s => s.count), 1);
  const urgentTasks = tasks.filter(t => t.priority === 'hot' && t.status !== 'completed');
  const hotLeads = leads.filter(l => l.priority === 'hot' && l.stage !== 'lost' && l.stage !== 'booked');

  // At-Risk panel (managers): open leads not contacted in 24h+, with a
  // one-click override that hands them to the current top performer
  const isManager = hasPermission('assign_leads');
  const atRiskLeads = useMemo(() => {
    if (!isManager) return [];
    const cutoff = Date.now() - 24 * 3600000;
    return allLeads
      .filter(l => l.stage !== 'booked' && l.stage !== 'lost' && new Date(l.lastContact).getTime() < cutoff)
      .sort((a, b) => new Date(a.lastContact).getTime() - new Date(b.lastContact).getTime());
  }, [allLeads, isManager]);

  const topPerformer = useMemo(() => {
    const sales = users.filter(u => u.active && (u.role === 'sales_executive' || u.role === 'sales_manager'));
    let best: UserType | undefined, bestCount = -1;
    sales.forEach(u => {
      const booked = allLeads.filter(l => l.assignedTo === u.id && l.stage === 'booked').length;
      if (booked > bestCount) { best = u; bestCount = booked; }
    });
    return best;
  }, [users, allLeads]);

  const staleHours = (l: Lead) => Math.floor((Date.now() - new Date(l.lastContact).getTime()) / 3600000);

  const handleReassignAtRisk = (lead: Lead) => {
    if (!topPerformer || !user) return;
    update<Lead>('leads', lead.id, { assignedTo: topPerformer.id, lastContact: new Date().toISOString() });
    logAudit({
      tenantId, userId: user.id, userName: user.name, action: 'reassign',
      entity: 'lead', entityId: lead.id,
      details: `Manager override: at-risk lead "${lead.name}" reassigned to top performer ${topPerformer.name}`,
    });
    setRefreshKey(k => k + 1);
  };

  // Recent activities (dynamic from DB)
  // Performance: Use lookup maps for O(1) access instead of O(n) find()
  const recentActivities = useMemo(() => {
    return activities
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 6)
      .map(act => {
        const u = userMap.get(act.userId);
        const lead = leadMap.get(act.leadId);
        const actionMap: Record<string, string> = {
          call: 'called', whatsapp: 'sent WhatsApp to', email: 'emailed',
          visit: 'visited', note: 'added note for', status_change: 'updated stage for',
        };
        const timeAgo = getTimeAgo(new Date(act.createdAt));
        return {
          user: u?.name || 'System',
          action: actionMap[act.type] || 'updated',
          target: lead?.name || 'Lead',
          time: timeAgo,
          type: act.type,
        };
      });
  }, [activities, userMap, leadMap]);

  // Field-staff home: a site engineer has no pipeline, so the sales dashboard
  // would render as a wall of empty charts. They get a construction-first view.
  if (user?.role === 'site_engineer') {
    const myTasks = siteTasks
      .filter(t => t.assignedTo === userId && t.status !== 'done')
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
    const engineerKpis = [
      { label: 'Active Projects', value: projects.filter(p => p.status !== 'completed').length, icon: Building2 },
      { label: 'My Open Tasks', value: myTasks.length, icon: HardHat },
      { label: 'Open RFIs', value: openRfis.length, icon: FileQuestion },
      { label: 'Reorder Alerts', value: lowStock.length, icon: Package },
    ];
    return (
      <div className="space-y-6 max-w-[1400px]">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Welcome back, {user?.name?.split(' ')[0] || 'User'}</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Here's what's happening on your sites today.</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {engineerKpis.map((kpi, i) => (
            <div key={i} className="bg-white rounded-2xl border border-zinc-200/60 p-4">
              <div className="flex items-center gap-2 mb-2">
                <kpi.icon className="h-5 w-5 text-zinc-400" />
                <span className="text-xs font-medium text-zinc-500">{kpi.label}</span>
              </div>
              <p className="text-2xl font-bold text-zinc-900">{kpi.value}</p>
            </div>
          ))}
        </div>

        {opsAlerts.length > 0 && <OpsAlertsCard alerts={opsAlerts} />}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ProjectBoardCard board={projectBoard} />
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-zinc-900 flex items-center gap-2"><HardHat className="h-4 w-4 text-indigo-500" /> My Site Tasks</h3>
              <Link to="/execution" className="text-xs text-indigo-600 font-medium hover:underline">Open Execution</Link>
            </div>
            <div className="space-y-2">
              {myTasks.slice(0, 6).map(t => {
                const overdueTask = new Date(t.dueDate).getTime() < Date.now();
                return (
                  <Link to={`/execution?project=${t.projectId}`} key={t.id} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-zinc-50 transition-colors">
                    {t.isMilestone && <Flag className="h-3.5 w-3.5 text-indigo-500 shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-800 truncate">{t.title}</p>
                      <p className={`text-xs mt-0.5 ${overdueTask ? 'text-red-500 font-medium' : 'text-zinc-500'}`}>
                        Due {new Date(t.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}{overdueTask ? ' — overdue' : ''}
                      </p>
                    </div>
                    <span className="text-xs font-semibold text-zinc-600 shrink-0">{t.status === 'done' ? 100 : t.progress}%</span>
                  </Link>
                );
              })}
              {myTasks.length === 0 && <p className="text-sm text-zinc-400 text-center py-4">Nothing assigned to you — enjoy the quiet.</p>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-[1400px]">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Welcome back, {user?.name?.split(' ')[0] || 'User'}</h2>
          <p className="text-sm text-zinc-500 mt-0.5">
            {isExecutive ? "Here's your personal pipeline overview." : `Here's what's happening at ${tenant?.name || 'Friendly ERP'} today.`}
          </p>
        </div>
        <div className="flex items-center gap-2 bg-white rounded-xl border border-zinc-200 p-1">
          {(['today', 'week', 'month'] as const).map(r => (
            <button
              key={r}
              onClick={() => setTimeRange(r)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all capitalize ${timeRange === r ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
            >
              {r}
            </button>
          ))}
          <button
            onClick={() => setRefreshKey(k => k + 1)}
            className="p-2 rounded-lg text-zinc-500 hover:bg-zinc-100 transition-all ml-1"
            title="Refresh dashboard"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {kpiData.map((kpi, i) => {
          const Icon = iconMap[kpi.icon] || BarChart3;
          return (
            <div key={i} className="bg-white rounded-2xl border border-zinc-200/60 p-4 hover:shadow-lg hover:shadow-zinc-200/50 transition-all duration-200 group">
              <div className="flex items-start justify-between mb-3">
                <div className="h-9 w-9 rounded-xl bg-zinc-100 flex items-center justify-center group-hover:bg-indigo-50 transition-colors">
                  <Icon className="h-5 w-5 text-zinc-500 group-hover:text-indigo-600 transition-colors" />
                </div>
                {kpi.change !== null && (
                  <div className={`flex items-center gap-0.5 text-xs font-semibold ${kpi.change >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                    {kpi.change >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                    {Math.abs(kpi.change)}%
                  </div>
                )}
              </div>
              <p className="text-2xl font-bold text-zinc-900 tracking-tight">{kpi.value}</p>
              <p className="text-xs text-zinc-500 mt-0.5 font-medium">{kpi.label}</p>
            </div>
          );
        })}
      </div>

      {/* ERP: cross-module alerts + construction status board */}
      {opsAlerts.length > 0 && <OpsAlertsCard alerts={opsAlerts} />}
      {showExecution && projectBoard.length > 0 && <ProjectBoardCard board={projectBoard} />}

      {/* At-Risk leads — manager accountability panel */}
      {isManager && atRiskLeads.length > 0 && (
        <div className="bg-white rounded-2xl border-2 border-amber-200 p-5">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <h3 className="font-semibold text-zinc-900">At-Risk Leads</h3>
              <span className="text-[11px] font-semibold bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">
                {atRiskLeads.length} not contacted in 24h+
              </span>
            </div>
            {topPerformer && (
              <span className="text-[11px] text-zinc-400">Override reassigns to top performer: <strong className="text-zinc-600">{topPerformer.name}</strong></span>
            )}
          </div>
          <div className="divide-y divide-zinc-50">
            {atRiskLeads.slice(0, 5).map(lead => (
              <div key={lead.id} className="flex items-center gap-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-800">{lead.name} <span className="text-zinc-400 font-normal">· {lead.project}</span></p>
                  <p className="text-xs text-red-500 font-medium">Silent for {staleHours(lead)}h · assigned to {userMap.get(lead.assignedTo)?.name || 'Unassigned'}</p>
                </div>
                <Link to="/leads" className="text-xs font-medium text-indigo-600 hover:underline shrink-0">Open</Link>
                {topPerformer && lead.assignedTo !== topPerformer.id && (
                  <button
                    onClick={() => handleReassignAtRisk(lead)}
                    className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg bg-amber-500 text-white hover:bg-amber-600 shrink-0"
                  >
                    Manager Override
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Charts & Pipeline Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white rounded-2xl border border-zinc-200/60 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-zinc-900">Lead Flow</h3>
              <p className="text-xs text-zinc-500">Daily lead intake vs conversions</p>
            </div>
            <Eye className="h-4 w-4 text-zinc-400" />
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weeklyData} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
                <XAxis dataKey="day" tick={{ fontSize: 12, fill: '#a1a1aa' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: '#a1a1aa' }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e4e4e7', boxShadow: '0 4px 16px rgba(0,0,0,0.08)' }} />
                <Bar dataKey="leads" fill="#6366f1" radius={[6, 6, 0, 0]} name="Leads" />
                <Bar dataKey="conversions" fill="#10b981" radius={[6, 6, 0, 0]} name="Conversions" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-zinc-200/60 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-zinc-900">Pipeline</h3>
              <p className="text-xs text-zinc-500">Stage-wise summary</p>
            </div>
            <span className="text-xs font-medium text-indigo-600 bg-indigo-50 px-2 py-1 rounded-lg">{leads.filter(l => l.stage !== 'lost').length} open</span>
          </div>
          <div className="space-y-3">
            {pipelineStages.map(stage => (
              <div key={stage.stage} className="group">
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-zinc-600 font-medium">{stage.stage}</span>
                  <span className="text-zinc-900 font-semibold">{stage.count}</span>
                </div>
                <div className="h-2 bg-zinc-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 rounded-full transition-all group-hover:from-indigo-600 group-hover:to-violet-600"
                    style={{ width: `${Math.max(stage.count > 0 ? 8 : 2, (stage.count / maxPipelineCount) * 100)}%` }}
                  />
                </div>
                {stage.value > 0 && (
                  <p className="text-[11px] text-zinc-400 mt-0.5">{formatCurrency(stage.value, currency)} pipeline</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-zinc-900 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Urgent Tasks
            </h3>
            {hasPermission('view_calendar') && (
              <Link to="/calendar" className="text-xs text-indigo-600 font-medium hover:underline">View all</Link>
            )}
          </div>
          <div className="space-y-3">
            {urgentTasks.slice(0, 4).map(task => (
              <div key={task.id} className="flex items-start gap-3 p-2.5 rounded-xl hover:bg-zinc-50 transition-colors">
                <div className={`h-2.5 w-2.5 rounded-full mt-1.5 shrink-0 ${task.priority === 'hot' ? 'bg-red-400' : 'bg-amber-400'}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-800 truncate">{task.title}</p>
                  <p className="text-xs text-zinc-500 flex items-center gap-1 mt-0.5">
                    <Clock className="h-3 w-3" />
                    {new Date(task.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full capitalize ${task.status === 'in_progress' ? 'bg-blue-50 text-blue-600' : 'bg-amber-50 text-amber-600'}`}>
                  {task.status.replace('_', ' ')}
                </span>
              </div>
            ))}
            {urgentTasks.length === 0 && <p className="text-sm text-zinc-400 text-center py-4">No urgent tasks</p>}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-zinc-200/60 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-zinc-900">Hot Leads</h3>
            <Link to="/leads" className="text-xs text-indigo-600 font-medium hover:underline">View all</Link>
          </div>
          <div className="space-y-3">
            {hotLeads.slice(0, 4).map(lead => (
              <Link to="/leads" key={lead.id} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-zinc-50 transition-colors">
                <div className="h-9 w-9 rounded-full bg-gradient-to-br from-red-100 to-orange-100 flex items-center justify-center shrink-0">
                  <span className="text-xs font-bold text-orange-600">{lead.name.split(' ').map(n => n[0]).join('')}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-800">{lead.name}</p>
                  <p className="text-xs text-zinc-500 truncate">{lead.project} · {lead.configuration}</p>
                </div>
                <span className="text-xs font-semibold text-zinc-900 shrink-0">{formatCurrency(lead.budget, currency)}</span>
              </Link>
            ))}
            {hotLeads.length === 0 && <p className="text-sm text-zinc-400 text-center py-4">No hot leads</p>}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-zinc-200/60 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-zinc-900">Recent Activity</h3>
            <MoreHorizontal className="h-4 w-4 text-zinc-400 cursor-pointer" />
          </div>
          <div className="space-y-1">
            {recentActivities.length === 0 ? (
              <p className="text-sm text-zinc-400 text-center py-4">No recent activity</p>
            ) : recentActivities.map((act, i) => {
              const icons: Record<string, React.ElementType> = {
                'call': Phone, 'whatsapp': MessageCircle, 'visit': Calendar, 'note': Eye, 'status_change': TrendingUp, 'email': MessageCircle,
              };
              const Icon = icons[act.type] || Eye;
              return (
                <div key={i} className="flex items-center gap-3 py-2.5 border-b border-zinc-50 last:border-0">
                  <div className="h-8 w-8 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0">
                    <Icon className="h-4 w-4 text-zinc-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-700 truncate">
                      <span className="font-medium text-zinc-900">{act.user}</span>{' '}
                      {act.action}{' '}
                      <span className="font-medium text-zinc-900">{act.target}</span>
                    </p>
                    <p className="text-xs text-zinc-400">{act.time}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Cross-module "needs attention" strip — every row deep-links to its module. */
function OpsAlertsCard({ alerts }: { alerts: { icon: React.ElementType; color: string; label: string; link: string }[] }) {
  return (
    <div className="bg-white rounded-2xl border border-zinc-200/60 p-5">
      <h3 className="font-semibold text-zinc-900 flex items-center gap-2 mb-3">
        <AlertTriangle className="h-4 w-4 text-amber-500" /> Needs Attention
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
        {alerts.map((a, i) => (
          <Link key={i} to={a.link} className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-zinc-50 transition-colors">
            <a.icon className={`h-4 w-4 shrink-0 ${a.color}`} />
            <span className="text-sm text-zinc-700">{a.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/** Per-project construction status: % complete, health flag, next milestone —
 *  the project board the spec asks for, derived live from site tasks. */
function ProjectBoardCard({ board }: {
  board: { project: Project; progress: number | null; health: keyof typeof HEALTH_META; milestone: SiteTask | null }[];
}) {
  return (
    <div className="bg-white rounded-2xl border border-zinc-200/60 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-zinc-900 flex items-center gap-2">
          <HardHat className="h-4 w-4 text-indigo-500" /> Site Progress
        </h3>
        <Link to="/execution" className="text-xs text-indigo-600 font-medium hover:underline">Open Execution</Link>
      </div>
      <div className="space-y-3">
        {board.length === 0 && <p className="text-sm text-zinc-400 text-center py-4">No projects yet</p>}
        {board.map(({ project, progress, health, milestone }) => (
          <Link
            key={project.id}
            to={`/execution?project=${project.id}`}
            className="block p-3 rounded-xl border border-zinc-100 hover:border-indigo-200 hover:bg-indigo-50/30 transition-colors"
          >
            <div className="flex items-center justify-between gap-3 mb-1.5 flex-wrap">
              <p className="text-sm font-semibold text-zinc-900">{project.name}</p>
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${HEALTH_META[health].badge}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${HEALTH_META[health].dot}`} />
                  {HEALTH_META[health].label}
                </span>
                <span className="text-xs font-bold text-zinc-700">{progress === null ? '—' : `${progress}%`}</span>
              </div>
            </div>
            <div className="h-1.5 bg-zinc-100 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 rounded-full" style={{ width: `${progress ?? 0}%` }} />
            </div>
            <p className="text-[11px] text-zinc-500 mt-1.5 flex items-center gap-1">
              <Flag className="h-3 w-3 text-zinc-400" />
              {milestone
                ? <>Next: {milestone.title} · {new Date(milestone.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</>
                : 'No open milestones'}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}

function getTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
