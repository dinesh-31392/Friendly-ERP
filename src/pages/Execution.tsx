import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  HardHat, ListChecks, Camera, FileQuestion, ClipboardCheck, Flag, Plus, X,
  Trash2, Clock, CheckCircle2, AlertTriangle, CalendarDays, ShieldCheck,
  ArrowUpRight, ArrowDownRight, Link2, Ban, Image as ImageIcon,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, logAudit } from '../services/db';
import {
  projectProgress, nextMilestone, projectHealth, HEALTH_META, unmetDependencies,
  nextRfiNumber, nextChangeOrderNumber, changeOrderImpact,
  buildChecklistItems, inspectionOutcome,
} from '../services/executionService';
import { compressImage } from '../utils/image';
import { formatCurrency } from '../utils/format';
import { raiseConstructionDemands } from '../services/demandService';
import { isApiEnabled } from '../services/apiClient';
import * as execWrites from '../services/executionWrites';
import type {
  Project, User, SiteTask, SiteTaskStatus, ProgressUpdate, Rfi, ChangeOrder,
  Inspection, InspectionType, InspectionItem, InspectionItemResult,
} from '../types';
import { SITE_TASK_STATUSES, INSPECTION_TEMPLATES } from '../types';
import toast from 'react-hot-toast';

type Tab = 'tasks' | 'progress' | 'rfis' | 'changes' | 'inspections';

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'tasks', label: 'Tasks & Milestones', icon: ListChecks },
  { id: 'progress', label: 'Progress Log', icon: Camera },
  { id: 'rfis', label: 'RFIs', icon: FileQuestion },
  { id: 'changes', label: 'Change Orders', icon: ArrowUpRight },
  { id: 'inspections', label: 'Inspections', icon: ClipboardCheck },
];

const MAX_PHOTOS_PER_UPDATE = 4;

export default function Execution() {
  const { user, tenant, hasPermission } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tenantId = tenant?.id || '';
  const currency = tenant?.currency || 'INR';
  const canManage = hasPermission('manage_execution');
  // A site engineer raises change orders but cannot approve their own —
  // approval authority is a separate grant (builder admin by default).
  const canApproveCo = hasPermission('approve_change_orders');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  const [tab, setTab] = useState<Tab>('tasks');
  const [showAddTask, setShowAddTask] = useState(false);
  const [showAddUpdate, setShowAddUpdate] = useState(false);
  const [showAddRfi, setShowAddRfi] = useState(false);
  const [showAddCo, setShowAddCo] = useState(false);
  const [showAddInspection, setShowAddInspection] = useState(false);
  const [openRfi, setOpenRfi] = useState<Rfi | null>(null);
  const [runInspection, setRunInspection] = useState<Inspection | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [milestonesOnly, setMilestonesOnly] = useState(false);

  const projects = useMemo(
    () => getByTenant<Project>('projects', tenantId).sort((a, b) => a.name.localeCompare(b.name)),
    [tenantId, refreshKey]
  );
  const users = useMemo(
    () => getByTenant<User>('users', tenantId).filter(u => u.active && u.role !== 'super_admin'),
    [tenantId, refreshKey]
  );

  // Selected project rides in the URL so Projects can deep-link here
  const projectId = searchParams.get('project') || projects[0]?.id || '';
  const project = projects.find(p => p.id === projectId);
  const selectProject = (id: string) => setSearchParams(id ? { project: id } : {});

  // API mode: the server owns all five execution datasets; localStorage stays
  // the demo path and the fallback when the API is unreachable.
  const [apiData, setApiData] = useState<Awaited<ReturnType<typeof execWrites.fetchExecutionData>>>(null);
  useEffect(() => {
    if (!isApiEnabled()) { setApiData(null); return; }
    let cancelled = false;
    execWrites.fetchExecutionData(tenantId)
      .then(d => { if (!cancelled) setApiData(d); })
      .catch(() => {
        if (!cancelled) { setApiData(null); toast.error('API unreachable — showing local data', { id: 'api-fallback' }); }
      });
    return () => { cancelled = true; };
  }, [tenantId, refreshKey]);

  const allTasks = useMemo(
    () => apiData?.tasks ?? getByTenant<SiteTask>('siteTasks', tenantId),
    [apiData, tenantId, refreshKey]
  );
  const tasks = useMemo(
    () => allTasks.filter(t => t.projectId === projectId)
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()),
    [allTasks, projectId]
  );
  const updates = useMemo(
    () => (apiData?.updates ?? getByTenant<ProgressUpdate>('progressUpdates', tenantId))
      .filter(u => u.projectId === projectId)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    [apiData, tenantId, projectId, refreshKey]
  );
  const rfis = useMemo(
    () => (apiData?.rfis ?? getByTenant<Rfi>('rfis', tenantId)).filter(r => r.projectId === projectId)
      .sort((a, b) => b.number - a.number),
    [apiData, tenantId, projectId, refreshKey]
  );
  const changeOrders = useMemo(
    () => (apiData?.changeOrders ?? getByTenant<ChangeOrder>('changeOrders', tenantId)).filter(c => c.projectId === projectId)
      .sort((a, b) => b.number - a.number),
    [apiData, tenantId, projectId, refreshKey]
  );
  const inspections = useMemo(
    () => (apiData?.inspections ?? getByTenant<Inspection>('inspections', tenantId)).filter(i => i.projectId === projectId)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    [apiData, tenantId, projectId, refreshKey]
  );

  // Keep the open "run inspection" modal in step with the store after a save
  useEffect(() => {
    if (runInspection) {
      const fresh = inspections.find(i => i.id === runInspection.id);
      if (fresh && fresh !== runInspection) setRunInspection(fresh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspections]);

  const userName = (id?: string) => users.find(u => u.id === id)?.name || '—';
  const audit = (action: string, entity: string, entityId: string, details: string) => {
    if (user) logAudit({ tenantId, userId: user.id, userName: user.name, action, entity, entityId, details });
  };

  // KPI strip
  const progress = project ? projectProgress(tenantId, project.id) : null;
  const health = project ? projectHealth(tenantId, project.id) : 'on_track';
  const milestone = project ? nextMilestone(tenantId, project.id) : null;
  const openRfiCount = rfis.filter(r => r.status === 'open').length;
  const failedInspections = inspections.filter(i => i.status === 'failed').length;
  const coImpact = project ? changeOrderImpact(tenantId, project.id) : { cost: 0, days: 0 };

  // ── Site tasks ─────────────────────────────────────────────────────────────
  const handleAddTask = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!project) return;
    const fd = new FormData(e.currentTarget);
    const title = (fd.get('title') as string)?.trim();
    const dueDate = fd.get('dueDate') as string;
    if (!title || !dueDate) { toast.error('Title and due date are required'); return; }
    const dependsOn = fd.getAll('dependsOn') as string[];
    let created: SiteTask;
    try {
      created = await execWrites.createSiteTask({
        id: '', tenantId, projectId: project.id, title,
        description: (fd.get('description') as string) || '',
        isMilestone: fd.get('isMilestone') === 'on',
        startDate: (fd.get('startDate') as string) || '',
        dueDate,
        status: 'not_started', progress: 0,
        assignedTo: (fd.get('assignedTo') as string) || undefined,
        dependsOn,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add the task');
      return;
    }
    audit('create', 'site_task', created.id, `Added site task "${title}" on ${project.name}`);
    setShowAddTask(false);
    refresh();
    toast.success(created.isMilestone ? 'Milestone added' : 'Task added');
  };

  const setTaskStatus = async (task: SiteTask, status: SiteTaskStatus) => {
    if (status !== 'not_started' && status !== 'blocked') {
      const unmet = unmetDependencies(task, tasks);
      if (unmet.length > 0) {
        toast.error(`Blocked by: ${unmet.map(t => t.title).join(', ')}`);
        return;
      }
    }
    try { await execWrites.setTaskStatus(task, status); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not update the task'); return; }
    audit('update', 'site_task', task.id, `"${task.title}" → ${status.replace('_', ' ')}`);
    // Construction-linked demand automation: completing a milestone auto-raises
    // the matching payment demand on every buyer in this project.
    if (status === 'done' && task.isMilestone) {
      const res = raiseConstructionDemands(tenantId, task.projectId, task.title, user ? { id: user.id, name: user.name } : undefined);
      if (res.count > 0) toast.success(`Milestone reached — raised ${res.count} demand${res.count === 1 ? '' : 's'} (${formatCurrency(res.total, tenant?.currency || 'INR')})`);
    }
    refresh();
  };

  const setTaskProgress = async (task: SiteTask, progress: number) => {
    try { await execWrites.setTaskProgress(task, progress); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not update progress'); return; }
    refresh();
  };

  const deleteTask = async (task: SiteTask) => {
    if (!confirm(`Delete "${task.title}"? Tasks depending on it will lose the link.`)) return;
    try { await execWrites.deleteSiteTask(task, tasks); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not delete the task'); return; }
    audit('delete', 'site_task', task.id, `Deleted site task "${task.title}"`);
    refresh();
    toast.success('Task deleted');
  };

  // ── Progress updates ───────────────────────────────────────────────────────
  const [pendingPhotos, setPendingPhotos] = useState<string[]>([]);
  const [compressing, setCompressing] = useState(false);

  const handlePhotoFiles = async (files: FileList | null) => {
    if (!files) return;
    const room = MAX_PHOTOS_PER_UPDATE - pendingPhotos.length;
    const batch = Array.from(files).slice(0, room);
    if (batch.length < files.length) toast(`Up to ${MAX_PHOTOS_PER_UPDATE} photos per update`);
    setCompressing(true);
    try {
      const results: string[] = [];
      for (const f of batch) {
        try { results.push(await compressImage(f)); }
        catch { toast.error(`Couldn't read ${f.name}`); }
      }
      setPendingPhotos(p => [...p, ...results]);
    } finally { setCompressing(false); }
  };

  const handleAddUpdate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!project || !user) return;
    const fd = new FormData(e.currentTarget);
    const summary = (fd.get('summary') as string)?.trim();
    if (!summary) { toast.error('Write a short summary of the work done'); return; }
    const workforce = Number(fd.get('workforce'));
    let created: ProgressUpdate;
    try {
      created = await execWrites.createUpdate({
        id: '', tenantId, projectId: project.id, userId: user.id,
        date: (fd.get('date') as string) || new Date().toISOString().slice(0, 10),
        summary,
        workforce: workforce > 0 ? workforce : undefined,
        photos: pendingPhotos,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not log the update');
      return;
    }
    audit('create', 'progress_update', created.id, `Site update on ${project.name}: ${summary.slice(0, 60)}`);
    setShowAddUpdate(false);
    setPendingPhotos([]);
    refresh();
    toast.success('Progress update logged');
  };

  const deleteUpdate = async (u: ProgressUpdate) => {
    if (!confirm('Delete this progress update?')) return;
    try { await execWrites.deleteUpdate(u); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not delete the update'); return; }
    audit('delete', 'progress_update', u.id, 'Deleted site progress update');
    refresh();
    toast.success('Update deleted');
  };

  // ── RFIs ───────────────────────────────────────────────────────────────────
  const handleAddRfi = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!project || !user) return;
    const fd = new FormData(e.currentTarget);
    const subject = (fd.get('subject') as string)?.trim();
    const question = (fd.get('question') as string)?.trim();
    if (!subject || !question) { toast.error('Subject and question are required'); return; }
    let created: Rfi;
    try {
      created = await execWrites.createRfi({
        id: '', tenantId, projectId: project.id,
        number: nextRfiNumber(tenantId, project.id),
        subject, question, raisedBy: user.id,
        assignedTo: (fd.get('assignedTo') as string) || undefined,
        status: 'open',
        dueDate: (fd.get('dueDate') as string) || undefined,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not raise the RFI');
      return;
    }
    audit('create', 'rfi', created.id, `Raised RFI-${String(created.number).padStart(3, '0')}: ${subject}`);
    setShowAddRfi(false);
    refresh();
    toast.success('RFI raised');
  };

  const answerRfi = async (rfi: Rfi, answer: string) => {
    if (!answer.trim()) { toast.error('Write an answer first'); return; }
    try { await execWrites.answerRfi(rfi, answer.trim()); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not save the answer'); return; }
    audit('update', 'rfi', rfi.id, `Answered RFI-${String(rfi.number).padStart(3, '0')}`);
    setOpenRfi(null);
    refresh();
    toast.success('RFI answered');
  };

  const closeRfi = async (rfi: Rfi) => {
    try { await execWrites.closeRfi(rfi); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not close the RFI'); return; }
    audit('update', 'rfi', rfi.id, `Closed RFI-${String(rfi.number).padStart(3, '0')}`);
    setOpenRfi(null);
    refresh();
    toast.success('RFI closed');
  };

  // ── Change orders ──────────────────────────────────────────────────────────
  const handleAddCo = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!project || !user) return;
    const fd = new FormData(e.currentTarget);
    const title = (fd.get('title') as string)?.trim();
    if (!title) { toast.error('Title is required'); return; }
    let created: ChangeOrder;
    try {
      created = await execWrites.createChangeOrder({
        id: '', tenantId, projectId: project.id,
        number: nextChangeOrderNumber(tenantId, project.id),
        title, reason: (fd.get('reason') as string) || '',
        costImpact: Number(fd.get('costImpact')) || 0,
        timeImpactDays: Number(fd.get('timeImpactDays')) || 0,
        status: 'pending_approval', requestedBy: user.id,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not submit the change order');
      return;
    }
    audit('create', 'change_order', created.id, `Change order CO-${String(created.number).padStart(3, '0')}: ${title}`);
    setShowAddCo(false);
    refresh();
    toast.success('Change order submitted for approval');
  };

  const decideCo = async (co: ChangeOrder, approved: boolean) => {
    if (!user) return;
    try { await execWrites.decideChangeOrder(co, approved, user.id); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not record the decision'); return; }
    audit('update', 'change_order', co.id, `${approved ? 'Approved' : 'Rejected'} CO-${String(co.number).padStart(3, '0')} "${co.title}"`);
    refresh();
    toast.success(approved ? 'Change order approved' : 'Change order rejected');
  };

  // ── Inspections ────────────────────────────────────────────────────────────
  const [inspectionType, setInspectionType] = useState<InspectionType>('quality');
  const [templateIdx, setTemplateIdx] = useState(0);
  const [draftItems, setDraftItems] = useState<string[]>(INSPECTION_TEMPLATES.quality[0].items);
  const [draftTitle, setDraftTitle] = useState(INSPECTION_TEMPLATES.quality[0].title);

  const pickTemplate = (type: InspectionType, idx: number) => {
    setInspectionType(type);
    setTemplateIdx(idx);
    const tpl = INSPECTION_TEMPLATES[type][idx];
    setDraftItems([...tpl.items]);
    setDraftTitle(tpl.title);
  };

  const handleAddInspection = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!project || !user) return;
    const fd = new FormData(e.currentTarget);
    const items = draftItems.map(s => s.trim()).filter(Boolean);
    if (!draftTitle.trim() || items.length === 0) { toast.error('A title and at least one checklist item are required'); return; }
    let created: Inspection;
    try {
      created = await execWrites.createInspection({
        id: '', tenantId, projectId: project.id, type: inspectionType,
        title: draftTitle.trim(),
        date: (fd.get('date') as string) || new Date().toISOString().slice(0, 10),
        inspectorId: (fd.get('inspectorId') as string) || user.id,
        status: 'scheduled',
        items: buildChecklistItems(items),
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not schedule the inspection');
      return;
    }
    audit('create', 'inspection', created.id, `Scheduled ${inspectionType} inspection "${created.title}" on ${project.name}`);
    setShowAddInspection(false);
    refresh();
    toast.success('Inspection scheduled');
  };

  const setItemResult = async (insp: Inspection, itemId: string, result: InspectionItemResult) => {
    const items = insp.items.map(i => i.id === itemId ? { ...i, result } : i);
    try { await execWrites.setInspectionItems(insp, items); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not save the result'); return; }
    refresh();
  };

  const completeInspection = async (insp: Inspection) => {
    const outcome = inspectionOutcome(insp.items);
    if (!outcome) { toast.error('Mark every item pass / fail / N.A. first'); return; }
    try { await execWrites.completeInspection(insp, outcome); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not complete the inspection'); return; }
    audit('update', 'inspection', insp.id, `Completed "${insp.title}" — ${outcome.toUpperCase()}`);
    setRunInspection(null);
    refresh();
    toast[outcome === 'passed' ? 'success' : 'error'](`Inspection ${outcome}`);
  };

  const deleteInspection = async (insp: Inspection) => {
    if (!confirm(`Delete inspection "${insp.title}"?`)) return;
    try { await execWrites.deleteInspection(insp); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not delete the inspection'); return; }
    audit('delete', 'inspection', insp.id, `Deleted inspection "${insp.title}"`);
    refresh();
    toast.success('Inspection deleted');
  };

  // ── Shared bits ────────────────────────────────────────────────────────────
  const inputCls = 'w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20';
  const labelCls = 'block text-xs font-semibold text-zinc-500 uppercase mb-1';
  const fmtDate = (d?: string) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const rfiNo = (n: number) => `RFI-${String(n).padStart(3, '0')}`;
  const coNo = (n: number) => `CO-${String(n).padStart(3, '0')}`;

  if (projects.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200/60 py-20 text-center max-w-[1200px]">
        <HardHat className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
        <p className="text-sm font-medium text-zinc-700">No projects yet</p>
        <p className="text-sm text-zinc-500 mt-1">Create a project first — execution tracking lives inside a project.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Site Execution</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Track construction tasks, daily progress, RFIs, change orders and inspections.</p>
        </div>
        <select
          value={projectId}
          onChange={e => selectProject(e.target.value)}
          className="px-4 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm font-medium text-zinc-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        >
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gradient-to-br from-indigo-500 to-violet-600 rounded-2xl p-4 text-white">
          <div className="flex items-center gap-2 mb-2">
            <HardHat className="h-5 w-5 text-indigo-200" />
            <span className="text-xs font-medium text-indigo-200">Overall Progress</span>
          </div>
          <p className="text-3xl font-bold">{progress === null ? '—' : `${progress}%`}</p>
          <div className="h-1.5 bg-white/20 rounded-full mt-2 overflow-hidden">
            <div className="h-full bg-white rounded-full transition-all" style={{ width: `${progress ?? 0}%` }} />
          </div>
        </div>
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Flag className="h-5 w-5 text-zinc-400" />
            <span className="text-xs font-medium text-zinc-500">Schedule Health</span>
          </div>
          <span className={`inline-flex items-center gap-1.5 text-sm font-semibold px-2.5 py-1 rounded-full border ${HEALTH_META[health].badge}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${HEALTH_META[health].dot}`} />
            {HEALTH_META[health].label}
          </span>
          <p className="text-xs text-zinc-500 mt-2 truncate">
            {milestone ? <>Next milestone: <span className="font-medium text-zinc-700">{milestone.title}</span> · {fmtDate(milestone.dueDate)}</> : 'No open milestones'}
          </p>
        </div>
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-2">
            <FileQuestion className="h-5 w-5 text-zinc-400" />
            <span className="text-xs font-medium text-zinc-500">Open RFIs</span>
          </div>
          <p className="text-2xl font-bold text-zinc-900">{openRfiCount}</p>
          <p className="text-xs text-zinc-500 mt-1">{rfis.length} raised in total</p>
        </div>
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck className="h-5 w-5 text-zinc-400" />
            <span className="text-xs font-medium text-zinc-500">Approved Changes</span>
          </div>
          <p className="text-2xl font-bold text-zinc-900">{formatCurrency(coImpact.cost, currency)}</p>
          <p className="text-xs text-zinc-500 mt-1">
            {coImpact.days >= 0 ? '+' : ''}{coImpact.days} days schedule impact
            {failedInspections > 0 && <span className="text-red-600 font-medium"> · {failedInspections} failed inspection{failedInspections === 1 ? '' : 's'}</span>}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-white border border-zinc-200 rounded-xl p-1 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${tab === t.id ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}
          >
            <t.icon className="h-4 w-4" /> {t.label}
            {t.id === 'rfis' && openRfiCount > 0 && (
              <span className={`text-[10px] font-bold px-1.5 rounded-full ${tab === 'rfis' ? 'bg-white/20' : 'bg-amber-100 text-amber-700'}`}>{openRfiCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tasks & Milestones ── */}
      {tab === 'tasks' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-3 flex-wrap">
            <h3 className="font-semibold text-zinc-900">Tasks & Milestones</h3>
            <label className="flex items-center gap-1.5 text-xs text-zinc-500 cursor-pointer select-none">
              <input type="checkbox" checked={milestonesOnly} onChange={e => setMilestonesOnly(e.target.checked)} className="rounded" />
              Milestones only
            </label>
            <div className="flex-1" />
            {canManage && (
              <button onClick={() => setShowAddTask(true)} className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors">
                <Plus className="h-3.5 w-3.5" /> Add Task
              </button>
            )}
          </div>
          {tasks.length === 0 ? (
            <div className="py-16 text-center">
              <ListChecks className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">No site tasks yet. Add milestones like “Foundation complete” to start tracking progress.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-zinc-50/30 border-b border-zinc-100">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Task</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase hidden md:table-cell">Assignee</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Due</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase w-44">Progress</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {tasks.filter(t => !milestonesOnly || t.isMilestone).map(task => {
                    const overdue = task.status !== 'done' && new Date(task.dueDate).getTime() < Date.now();
                    const unmet = unmetDependencies(task, tasks);
                    return (
                      <tr key={task.id} className="border-b border-zinc-50 hover:bg-zinc-50/30 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {task.isMilestone && <Flag className="h-3.5 w-3.5 text-indigo-500 shrink-0" />}
                            <div className="min-w-0">
                              <p className={`text-sm font-medium truncate ${task.status === 'done' ? 'text-zinc-400 line-through' : 'text-zinc-900'}`}>{task.title}</p>
                              {unmet.length > 0 && (
                                <p className="text-[11px] text-amber-600 flex items-center gap-1 mt-0.5">
                                  <Link2 className="h-3 w-3" /> waits on {unmet.map(t => t.title).join(', ')}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-zinc-600 hidden md:table-cell">{userName(task.assignedTo)}</td>
                        <td className={`px-4 py-3 text-sm ${overdue ? 'text-red-600 font-semibold' : 'text-zinc-500'}`}>{fmtDate(task.dueDate)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {canManage ? (
                              <input
                                type="range" min={0} max={100} step={5} value={task.status === 'done' ? 100 : task.progress}
                                onChange={e => setTaskProgress(task, Number(e.target.value))}
                                className="w-24 accent-indigo-600"
                              />
                            ) : (
                              <div className="w-24 h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                                <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${task.status === 'done' ? 100 : task.progress}%` }} />
                              </div>
                            )}
                            <span className="text-xs font-semibold text-zinc-600 w-9">{task.status === 'done' ? 100 : task.progress}%</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center">
                          {canManage ? (
                            <select
                              value={task.status}
                              onChange={e => setTaskStatus(task, e.target.value as SiteTaskStatus)}
                              className="text-[11px] font-semibold px-2 py-1 rounded-full bg-zinc-50 border border-zinc-200 cursor-pointer"
                            >
                              {SITE_TASK_STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                            </select>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600">
                              <span className={`h-1.5 w-1.5 rounded-full ${SITE_TASK_STATUSES.find(s => s.id === task.status)?.color}`} />
                              {SITE_TASK_STATUSES.find(s => s.id === task.status)?.label}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {canManage && (
                            <button onClick={() => deleteTask(task)} className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 transition-colors">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Progress Log ── */}
      {tab === 'progress' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-zinc-500">{updates.length} update{updates.length === 1 ? '' : 's'} logged for {project?.name}</p>
            {canManage && (
              <button onClick={() => { setPendingPhotos([]); setShowAddUpdate(true); }} className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors">
                <Plus className="h-3.5 w-3.5" /> Log Update
              </button>
            )}
          </div>
          {updates.length === 0 ? (
            <div className="bg-white rounded-2xl border border-zinc-200/60 py-16 text-center">
              <Camera className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">No site updates yet. Field teams can log daily work with photos from their phone.</p>
            </div>
          ) : (
            updates.map(u => (
              <div key={u.id} className="bg-white rounded-2xl border border-zinc-200/60 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                      {userName(u.userId).split(' ').map(n => n[0]).join('').slice(0, 2) || '?'}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-zinc-900">{userName(u.userId)}</p>
                      <p className="text-[11px] text-zinc-500 flex items-center gap-2">
                        <CalendarDays className="h-3 w-3" /> {fmtDate(u.date)}
                        {u.workforce ? <span className="text-zinc-400">· {u.workforce} on site</span> : null}
                      </p>
                    </div>
                  </div>
                  {canManage && (
                    <button onClick={() => deleteUpdate(u)} className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 transition-colors">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <p className="text-sm text-zinc-700 mt-3 whitespace-pre-wrap">{u.summary}</p>
                {u.photos.length > 0 && (
                  <div className="flex gap-2 mt-3 flex-wrap">
                    {u.photos.map((p, i) => (
                      <button key={i} onClick={() => setPhotoPreview(p)} className="h-20 w-28 rounded-xl overflow-hidden border border-zinc-200 hover:opacity-90 transition-opacity">
                        <img src={p} alt={`Site photo ${i + 1}`} className="h-full w-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* ── RFIs ── */}
      {tab === 'rfis' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-3">
            <h3 className="font-semibold text-zinc-900">Requests for Information</h3>
            <div className="flex-1" />
            {canManage && (
              <button onClick={() => setShowAddRfi(true)} className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors">
                <Plus className="h-3.5 w-3.5" /> Raise RFI
              </button>
            )}
          </div>
          {rfis.length === 0 ? (
            <div className="py-16 text-center">
              <FileQuestion className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">No RFIs. Raise one when the site needs a design or spec clarification.</p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-50">
              {rfis.map(r => (
                <button key={r.id} onClick={() => setOpenRfi(r)} className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-zinc-50/50 transition-colors text-left">
                  <span className="text-xs font-mono font-semibold text-indigo-600 shrink-0">{rfiNo(r.number)}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-900 truncate">{r.subject}</p>
                    <p className="text-[11px] text-zinc-500">Raised by {userName(r.raisedBy)} · {fmtDate(r.createdAt)}{r.assignedTo ? ` · for ${userName(r.assignedTo)}` : ''}</p>
                  </div>
                  {r.dueDate && r.status === 'open' && new Date(r.dueDate).getTime() < Date.now() && (
                    <span className="text-[10px] font-semibold text-red-600 flex items-center gap-1"><Clock className="h-3 w-3" /> overdue</span>
                  )}
                  <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full shrink-0 ${
                    r.status === 'open' ? 'bg-amber-50 text-amber-700' : r.status === 'answered' ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-500'
                  }`}>{r.status}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Change Orders ── */}
      {tab === 'changes' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-3">
            <h3 className="font-semibold text-zinc-900">Change Orders</h3>
            <div className="flex-1" />
            {canManage && (
              <button onClick={() => setShowAddCo(true)} className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors">
                <Plus className="h-3.5 w-3.5" /> New Change Order
              </button>
            )}
          </div>
          {changeOrders.length === 0 ? (
            <div className="py-16 text-center">
              <ArrowUpRight className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">No change orders. Scope changes get costed, approved and tracked here.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-zinc-50/30 border-b border-zinc-100">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">#</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Change</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Cost Impact</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Time Impact</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {changeOrders.map(co => (
                    <tr key={co.id} className="border-b border-zinc-50 hover:bg-zinc-50/30 transition-colors">
                      <td className="px-4 py-3 text-xs font-mono font-semibold text-indigo-600">{coNo(co.number)}</td>
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-zinc-900">{co.title}</p>
                        {co.reason && <p className="text-[11px] text-zinc-500 truncate max-w-md">{co.reason}</p>}
                      </td>
                      <td className={`px-4 py-3 text-sm font-semibold text-right ${co.costImpact >= 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                        <span className="inline-flex items-center gap-1">
                          {co.costImpact >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                          {formatCurrency(Math.abs(co.costImpact), currency)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-zinc-600 text-right">{co.timeImpactDays >= 0 ? '+' : ''}{co.timeImpactDays}d</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${
                          co.status === 'approved' ? 'bg-emerald-50 text-emerald-700' :
                          co.status === 'rejected' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'
                        }`}>{co.status.replace('_', ' ')}</span>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {canApproveCo && co.status === 'pending_approval' && (
                          <>
                            <button onClick={() => decideCo(co, true)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors mr-1">Approve</button>
                            <button onClick={() => decideCo(co, false)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-red-50 text-red-600 hover:bg-red-100 transition-colors">Reject</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Inspections ── */}
      {tab === 'inspections' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-zinc-500">Quality & safety checklists for {project?.name}</p>
            {canManage && (
              <button onClick={() => { pickTemplate('quality', 0); setShowAddInspection(true); }} className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors">
                <Plus className="h-3.5 w-3.5" /> Schedule Inspection
              </button>
            )}
          </div>
          {inspections.length === 0 ? (
            <div className="bg-white rounded-2xl border border-zinc-200/60 py-16 text-center">
              <ClipboardCheck className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">No inspections yet. Start from a ready-made quality or safety checklist.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {inspections.map(insp => {
                const done = insp.items.filter(i => i.result !== 'pending').length;
                const fails = insp.items.filter(i => i.result === 'fail').length;
                return (
                  <div key={insp.id} className="bg-white rounded-2xl border border-zinc-200/60 p-5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${insp.type === 'safety' ? 'bg-orange-50' : 'bg-indigo-50'}`}>
                          {insp.type === 'safety' ? <ShieldCheck className="h-5 w-5 text-orange-500" /> : <ClipboardCheck className="h-5 w-5 text-indigo-500" />}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-zinc-900 truncate">{insp.title}</p>
                          <p className="text-[11px] text-zinc-500">{insp.type} · {fmtDate(insp.date)} · {userName(insp.inspectorId)}</p>
                        </div>
                      </div>
                      <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full shrink-0 ${
                        insp.status === 'passed' ? 'bg-emerald-50 text-emerald-700' :
                        insp.status === 'failed' ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-700'
                      }`}>{insp.status}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-3">
                      <div className="flex-1 h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${fails > 0 ? 'bg-red-500' : 'bg-emerald-500'}`} style={{ width: `${(done / Math.max(1, insp.items.length)) * 100}%` }} />
                      </div>
                      <span className="text-[11px] text-zinc-500">{done}/{insp.items.length} checked{fails > 0 ? ` · ${fails} failed` : ''}</span>
                    </div>
                    <div className="flex gap-2 mt-4">
                      <button
                        onClick={() => setRunInspection(insp)}
                        className="flex-1 py-2 bg-indigo-50 text-indigo-700 rounded-lg text-xs font-semibold hover:bg-indigo-100 transition-colors"
                      >
                        {insp.status === 'scheduled' && canManage ? 'Run Checklist' : 'View Checklist'}
                      </button>
                      {canManage && (
                        <button onClick={() => deleteInspection(insp)} className="p-2 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 transition-colors">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Modals ── */}

      {/* Photo lightbox */}
      {photoPreview && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-6" onClick={() => setPhotoPreview(null)}>
          <img src={photoPreview} alt="Site" className="max-h-full max-w-full rounded-2xl shadow-2xl" />
          <button className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors"><X className="h-5 w-5" /></button>
        </div>
      )}

      {/* Add task */}
      {showAddTask && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddTask(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Add Site Task</h3>
              <button onClick={() => setShowAddTask(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddTask} className="space-y-3">
              <div>
                <label className={labelCls}>Task Title *</label>
                <input name="title" required placeholder="Raft foundation pour — Tower A" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Description</label>
                <textarea name="description" rows={2} placeholder="Scope, drawings, notes..." className={`${inputCls} resize-none`} />
              </div>
              <label className="flex items-center gap-2 text-sm text-zinc-700 cursor-pointer select-none py-1">
                <input type="checkbox" name="isMilestone" className="rounded" />
                <Flag className="h-4 w-4 text-indigo-500" /> This is a milestone (drives progress & payment stages)
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Start Date</label>
                  <input name="startDate" type="date" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Due Date *</label>
                  <input name="dueDate" type="date" required className={inputCls} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Assignee</label>
                <select name="assignedTo" className={inputCls}>
                  <option value="">Unassigned</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.role.replace('_', ' ')})</option>)}
                </select>
              </div>
              {tasks.length > 0 && (
                <div>
                  <label className={labelCls}>Depends On</label>
                  <div className="max-h-32 overflow-y-auto border border-zinc-200 rounded-xl p-2 space-y-1">
                    {tasks.map(t => (
                      <label key={t.id} className="flex items-center gap-2 text-sm text-zinc-700 px-2 py-1 rounded-lg hover:bg-zinc-50 cursor-pointer">
                        <input type="checkbox" name="dependsOn" value={t.id} className="rounded" />
                        <span className="truncate">{t.title}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddTask(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Add Task</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Log progress update */}
      {showAddUpdate && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddUpdate(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Log Site Progress</h3>
              <button onClick={() => setShowAddUpdate(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddUpdate} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Date</label>
                  <input name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Workforce on Site</label>
                  <input name="workforce" type="number" min={0} placeholder="42" className={inputCls} />
                </div>
              </div>
              <div>
                <label className={labelCls}>What happened today? *</label>
                <textarea name="summary" rows={3} required placeholder="Slab casting completed for 4th floor, Tower B. Plumbing rough-in started on 2nd floor..." className={`${inputCls} resize-none`} />
              </div>
              <div>
                <label className={labelCls}>Photos (up to {MAX_PHOTOS_PER_UPDATE})</label>
                <div className="flex gap-2 flex-wrap">
                  {pendingPhotos.map((p, i) => (
                    <div key={i} className="relative h-20 w-28 rounded-xl overflow-hidden border border-zinc-200">
                      <img src={p} alt="" className="h-full w-full object-cover" />
                      <button type="button" onClick={() => setPendingPhotos(ps => ps.filter((_, x) => x !== i))} className="absolute top-1 right-1 p-0.5 bg-black/50 rounded-full text-white hover:bg-black/70">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  {pendingPhotos.length < MAX_PHOTOS_PER_UPDATE && (
                    <label className="h-20 w-28 rounded-xl border-2 border-dashed border-zinc-200 flex flex-col items-center justify-center text-zinc-400 hover:border-indigo-300 hover:text-indigo-500 cursor-pointer transition-colors">
                      <ImageIcon className="h-5 w-5" />
                      <span className="text-[10px] mt-1">{compressing ? 'Compressing…' : 'Add photo'}</span>
                      <input type="file" accept="image/*" multiple className="hidden" onChange={e => { handlePhotoFiles(e.target.files); e.target.value = ''; }} />
                    </label>
                  )}
                </div>
                <p className="text-[11px] text-zinc-400 mt-1">Photos are compressed on-device before saving.</p>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddUpdate(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" disabled={compressing} className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm disabled:opacity-50">Save Update</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Raise RFI */}
      {showAddRfi && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddRfi(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Raise an RFI</h3>
              <button onClick={() => setShowAddRfi(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddRfi} className="space-y-3">
              <div>
                <label className={labelCls}>Subject *</label>
                <input name="subject" required placeholder="Rebar spacing conflict — drawing S-204 vs S-208" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Question *</label>
                <textarea name="question" rows={3} required placeholder="Describe what needs clarification and why work is held up..." className={`${inputCls} resize-none`} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Assign To</label>
                  <select name="assignedTo" className={inputCls}>
                    <option value="">Anyone</option>
                    {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Answer Needed By</label>
                  <input name="dueDate" type="date" className={inputCls} />
                </div>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddRfi(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Raise RFI</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* RFI detail / answer */}
      {openRfi && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setOpenRfi(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-mono font-semibold text-indigo-600">{rfiNo(openRfi.number)}</span>
              <button onClick={() => setOpenRfi(null)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <h3 className="text-lg font-bold text-zinc-900 mb-1">{openRfi.subject}</h3>
            <p className="text-[11px] text-zinc-500 mb-4">
              Raised by {userName(openRfi.raisedBy)} on {fmtDate(openRfi.createdAt)}
              {openRfi.dueDate ? ` · answer needed by ${fmtDate(openRfi.dueDate)}` : ''}
            </p>
            <div className="bg-zinc-50 rounded-xl p-4 mb-4">
              <p className="text-xs text-zinc-500 mb-1">Question</p>
              <p className="text-sm text-zinc-800 whitespace-pre-wrap">{openRfi.question}</p>
            </div>
            {openRfi.answer ? (
              <div className="bg-emerald-50 rounded-xl p-4 mb-4">
                <p className="text-xs text-emerald-600 mb-1">Answer · {fmtDate(openRfi.answeredAt)}</p>
                <p className="text-sm text-zinc-800 whitespace-pre-wrap">{openRfi.answer}</p>
              </div>
            ) : canManage && (
              <form
                onSubmit={e => { e.preventDefault(); answerRfi(openRfi, new FormData(e.currentTarget).get('answer') as string); }}
                className="mb-4"
              >
                <label className={labelCls}>Answer</label>
                <textarea name="answer" rows={3} placeholder="Provide the clarification..." className={`${inputCls} resize-none mb-2`} />
                <button type="submit" className="w-full px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Submit Answer</button>
              </form>
            )}
            {canManage && openRfi.status !== 'closed' && (
              <button onClick={() => closeRfi(openRfi)} className="w-full px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50 flex items-center justify-center gap-2">
                <Ban className="h-4 w-4" /> Close RFI
              </button>
            )}
          </div>
        </div>
      )}

      {/* New change order */}
      {showAddCo && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddCo(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">New Change Order</h3>
              <button onClick={() => setShowAddCo(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddCo} className="space-y-3">
              <div>
                <label className={labelCls}>Title *</label>
                <input name="title" required placeholder="Upgrade lobby flooring to Italian marble" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Reason / Scope</label>
                <textarea name="reason" rows={2} placeholder="Why is this change needed?" className={`${inputCls} resize-none`} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Cost Impact ({currency})</label>
                  <input name="costImpact" type="number" placeholder="250000 (negative = saving)" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Time Impact (days)</label>
                  <input name="timeImpactDays" type="number" placeholder="14" className={inputCls} />
                </div>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddCo(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Submit for Approval</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Schedule inspection */}
      {showAddInspection && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddInspection(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Schedule Inspection</h3>
              <button onClick={() => setShowAddInspection(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddInspection} className="space-y-3">
              <div className="flex gap-2">
                {(['quality', 'safety'] as InspectionType[]).map(t => (
                  <button
                    key={t} type="button" onClick={() => pickTemplate(t, 0)}
                    className={`flex-1 py-2 rounded-xl text-sm font-semibold capitalize transition-colors ${inspectionType === t ? 'bg-indigo-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}`}
                  >{t}</button>
                ))}
              </div>
              <div>
                <label className={labelCls}>Start From Template</label>
                <select value={templateIdx} onChange={e => pickTemplate(inspectionType, Number(e.target.value))} className={inputCls}>
                  {INSPECTION_TEMPLATES[inspectionType].map((tpl, i) => <option key={i} value={i}>{tpl.title}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Inspection Title *</label>
                <input value={draftTitle} onChange={e => setDraftTitle(e.target.value)} required className={inputCls} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Date</label>
                  <input name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Inspector</label>
                  <select name="inspectorId" defaultValue={user?.id} className={inputCls}>
                    {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className={labelCls}>Checklist Items</label>
                <div className="space-y-2">
                  {draftItems.map((item, i) => (
                    <div key={i} className="flex gap-2">
                      <input
                        value={item}
                        onChange={e => setDraftItems(items => items.map((x, xi) => xi === i ? e.target.value : x))}
                        className={inputCls}
                      />
                      <button type="button" onClick={() => setDraftItems(items => items.filter((_, xi) => xi !== i))} className="p-2 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 shrink-0">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setDraftItems(items => [...items, ''])} className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-700 px-1 py-1">
                    <Plus className="h-3.5 w-3.5" /> Add item
                  </button>
                </div>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddInspection(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Schedule</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Run / view inspection checklist */}
      {runInspection && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setRunInspection(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize ${runInspection.type === 'safety' ? 'bg-orange-50 text-orange-600' : 'bg-indigo-50 text-indigo-600'}`}>{runInspection.type}</span>
              <button onClick={() => setRunInspection(null)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <h3 className="text-lg font-bold text-zinc-900">{runInspection.title}</h3>
            <p className="text-[11px] text-zinc-500 mb-4">{fmtDate(runInspection.date)} · Inspector: {userName(runInspection.inspectorId)}</p>
            <div className="space-y-2 mb-4">
              {runInspection.items.map(item => (
                <ChecklistRow
                  key={item.id}
                  item={item}
                  editable={canManage && runInspection.status === 'scheduled'}
                  onSet={result => setItemResult(runInspection, item.id, result)}
                />
              ))}
            </div>
            {canManage && runInspection.status === 'scheduled' && (
              <button
                onClick={() => completeInspection(runInspection)}
                className="w-full px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm flex items-center justify-center gap-2"
              >
                <CheckCircle2 className="h-4 w-4" /> Complete Inspection
              </button>
            )}
            {runInspection.status !== 'scheduled' && (
              <div className={`rounded-xl p-3 text-center text-sm font-semibold ${runInspection.status === 'passed' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                {runInspection.status === 'passed' ? '✓ Passed' : (<span className="inline-flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" /> Failed — raise corrective actions</span>)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ChecklistRow({ item, editable, onSet }: {
  item: InspectionItem;
  editable: boolean;
  onSet: (r: InspectionItemResult) => void;
}) {
  const options: { r: InspectionItemResult; label: string; cls: string }[] = [
    { r: 'pass', label: 'Pass', cls: 'bg-emerald-500 text-white' },
    { r: 'fail', label: 'Fail', cls: 'bg-red-500 text-white' },
    { r: 'na', label: 'N.A.', cls: 'bg-zinc-400 text-white' },
  ];
  return (
    <div className={`border rounded-xl p-3 ${item.result === 'fail' ? 'border-red-200 bg-red-50/40' : 'border-zinc-200'}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-zinc-800 flex-1">{item.label}</p>
        <div className="flex gap-1 shrink-0">
          {options.map(o => (
            <button
              key={o.r}
              type="button"
              disabled={!editable}
              onClick={() => onSet(item.result === o.r ? 'pending' : o.r)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all ${item.result === o.r ? o.cls : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'} ${!editable ? 'cursor-default opacity-70' : ''}`}
            >{o.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
