import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, Plus, Filter, Phone, MessageCircle, Mail, MapPin,
  Clock, X, Building2, Tag,
  Download, Upload, Trash2, Users, GitMerge, AlertTriangle, Gauge, Calendar, Sparkles, BookOpenCheck,
  List, LayoutGrid, Kanban, UserCheck
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, create, update, logAudit } from '../services/db';
import type { Lead, LeadStage, Note, Activity, Task, Priority, User as UserType } from '../types';
import { leadScoreBand, explainLeadScore, LOST_REASONS } from '../types';
import { getLeadStages, getLeadSources, getConfigurations, type StageDef } from '../services/metaService';
import { formatCurrency, currencySymbol } from '../utils/format';
import { telHref, mailtoHref } from '../utils/contact';
import { whatsappSend } from '../services/whatsappService';
import { toCsv } from '../utils/csv';
import { inviteCustomer, portalPath } from '../services/portalService';
import { isApiEnabled, apiGetLeads, apiWhatsappSession } from '../services/apiClient';
import { createLead, patchLead, deleteLead as removeLead, patchLeads, deleteLeads } from '../services/leadWrites';
import { useTenantUsers } from '../hooks/useTenantUsers';
import DateRangeFilter from '../components/DateRangeFilter';
import LeadWhatsAppChat from '../components/LeadWhatsAppChat';
import { type DateRange, ALL_RANGE, resolveRange, inRange, rangeSlug, rangeLabel } from '../utils/dateRange';
import { qualificationBadge } from '../services/chatbotService';
import {
  getCallingMode, setCallingMode, initiateCloudCall,
  CALL_STATUSES, type CallingMode, type CallStatus,
} from '../services/callService';
import toast from 'react-hot-toast';

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10);
}


// Minimal CSV parser that handles quoted fields ("a,b", doubled "" quotes)
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows;
}

interface ImportRow {
  name: string; phone: string; email: string;
  project: string; budget: number; configuration: string; source: string;
}

const defaultStageBorders: Record<string, string> = {
  new: 'border-l-blue-500', contacted: 'border-l-purple-500', qualified: 'border-l-indigo-500',
  visit_scheduled: 'border-l-amber-500', negotiation: 'border-l-orange-500', booked: 'border-l-emerald-500',
  lost: 'border-l-red-400',
};

const priorityColors: Record<string, string> = {
  hot: 'bg-red-100 text-red-700', warm: 'bg-amber-100 text-amber-700', cold: 'bg-zinc-100 text-zinc-500',
};

// Literal class map (Tailwind only generates classes it can see in source) —
// pairs every palette color from the stage editor with its border variant
const BORDER_BY_BG: Record<string, string> = {
  'bg-blue-500': 'border-l-blue-500', 'bg-purple-500': 'border-l-purple-500',
  'bg-indigo-500': 'border-l-indigo-500', 'bg-violet-500': 'border-l-violet-500',
  'bg-amber-500': 'border-l-amber-500', 'bg-orange-500': 'border-l-orange-500',
  'bg-emerald-500': 'border-l-emerald-500', 'bg-teal-500': 'border-l-teal-500',
  'bg-pink-500': 'border-l-pink-500', 'bg-cyan-500': 'border-l-cyan-500',
  'bg-red-400': 'border-l-red-400', 'bg-zinc-500': 'border-l-zinc-500',
};

export default function Leads() {
  const { user, tenant, hasPermission } = useAuth();
  const navigate = useNavigate();
  const tenantId = tenant?.id || '';
  const userId = user?.id || '';
  const currency = tenant?.currency || 'INR';

  // Metadata-driven pipeline: stages/sources/configurations are tenant data
  // (editable in Settings → Pipeline & Fields), not compiled constants
  const [leadStages, setLeadStages] = useState<StageDef[]>(() => getLeadStages(tenantId));
  const [leadSources, setLeadSources] = useState<string[]>(() => getLeadSources(tenantId));
  const [configOptions, setConfigOptions] = useState<string[]>(() => getConfigurations(tenantId));
  useEffect(() => {
    const sync = () => {
      setLeadStages(getLeadStages(tenantId));
      setLeadSources(getLeadSources(tenantId));
      setConfigOptions(getConfigurations(tenantId));
    };
    sync();
    window.addEventListener('friendly_crm_meta_changed', sync);
    return () => window.removeEventListener('friendly_crm_meta_changed', sync);
  }, [tenantId]);
  const stageMap = useMemo(() => new Map(leadStages.map(s => [s.id, s])), [leadStages]);
  const stageBorder = (id: string) =>
    BORDER_BY_BG[stageMap.get(id)?.color || ''] || defaultStageBorders[id] || 'border-l-zinc-300';

  const [search, setSearch] = useState('');
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [chatLead, setChatLead] = useState<Lead | null>(null);
  // Whether the CALLER has a linked WhatsApp session — decides if the button
  // opens the chat thread (connected) or keeps the one-shot greeting flow.
  const [waConnected, setWaConnected] = useState(false);
  useEffect(() => {
    if (!isApiEnabled()) return;
    apiWhatsappSession().then(s => setWaConnected(s.status === 'connected')).catch(() => {});
  }, []);
  const [filterStage, setFilterStage] = useState<LeadStage | 'all'>('all');
  const [dateRange, setDateRange] = useState<DateRange>(ALL_RANGE);
  const [showAddModal, setShowAddModal] = useState(false);
  const [noteInput, setNoteInput] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [viewMode, setViewMode] = useState<'kanban' | 'list' | 'grid'>('list');

  // Bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showImport, setShowImport] = useState(false);
  const [importPreview, setImportPreview] = useState<{ valid: ImportRow[]; invalid: number; dupes: number } | null>(null);

  // Dual-mode calling: SIM (device dialer) vs Cloud (telephony API bridge).
  // Per-user preference; the post-call modal forces duration/status logging.
  const [callingMode, setCallingModeState] = useState<CallingMode>(() => getCallingMode(user?.id || ''));
  const [callLogModal, setCallLogModal] = useState<{ mode: CallingMode; leadId: string; leadName: string } | null>(null);
  // Site-visit scheduler: holds the chosen date/time while the modal is open.
  const [visitModal, setVisitModal] = useState<{ date: string; time: string } | null>(null);
  const toggleCallingMode = (mode: CallingMode) => {
    setCallingModeState(mode);
    setCallingMode(user?.id || '', mode);
    toast.success(mode === 'API_CLOUD'
      ? 'Cloud calling on — calls bridge via the telephony API and are recorded'
      : 'SIM calling on — calls dial through your device');
  };



  // Telecallers work the same personally-scoped view as sales executives
  const isExecutive = user?.role === 'sales_executive' || user?.role === 'telecaller';

  // Feature flag: with an API URL configured, leads are read from the Fastify
  // backend (RLS-scoped). Falls back to localStorage on any API failure so
  // the app never goes blank. Flag off → identical behavior to before.
  const [apiLeads, setApiLeads] = useState<Lead[] | null>(null);
  useEffect(() => {
    if (!isApiEnabled()) { setApiLeads(null); return; }
    let cancelled = false;
    apiGetLeads()
      .then(rows => { if (!cancelled) setApiLeads(rows); })
      .catch(() => {
        if (!cancelled) {
          setApiLeads(null);
          toast.error('API unreachable — showing local data', { id: 'api-fallback' });
        }
      });
    return () => { cancelled = true; };
  }, [tenantId, refreshKey]);

  const allLeadsData = useMemo(
    () => apiLeads ?? getByTenant<Lead>('leads', tenantId),
    [apiLeads, tenantId, refreshKey]
  );
  const allUsers = useTenantUsers(tenantId, refreshKey);
  const tenantProjects = useMemo(() => getByTenant<{ tenantId: string; id: string; name: string }>('projects', tenantId), [tenantId, refreshKey]);
  // Front-line staff see leads assigned to them, PLUS (when the admin has
  // scoped them to projects) every lead in their assigned projects — the
  // user_project_assignments model from the CRM spec.
  const leads = useMemo(() => {
    if (!isExecutive) return allLeadsData;
    const assignedProjects = user?.projectIds || [];
    const projectNames = new Set(
      tenantProjects.filter(p => assignedProjects.includes(p.id)).map(p => p.name)
    );
    return allLeadsData.filter(l =>
      l.assignedTo === userId ||
      (l.projectId ? assignedProjects.includes(l.projectId) : projectNames.has(l.project))
    );
  }, [allLeadsData, isExecutive, userId, user?.projectIds, tenantProjects]);
  const notes = useMemo(() => getByTenant<Note>('notes', tenantId), [tenantId, refreshKey]);
  const activities = useMemo(() => getByTenant<Activity>('activities', tenantId), [tenantId, refreshKey]);

  // Deep linking: consume the focus key on mount AND whenever global search
  // fires its event (covers the case where we're already on /leads)
  useEffect(() => {
    const consumeFocus = () => {
      const focusId = localStorage.getItem('friendly_crm_focus_lead');
      if (!focusId) return;
      localStorage.removeItem('friendly_crm_focus_lead');
      // Respect role filtering: only focus if the lead is visible to current user
      const target = leads.find(l => l.id === focusId);
      if (target) setSelectedLead(target);
    };
    consumeFocus();
    window.addEventListener('friendly_crm_search_focus', consumeFocus);
    return () => window.removeEventListener('friendly_crm_search_focus', consumeFocus);
  }, [leads]);

  const refresh = () => setRefreshKey(k => k + 1);

  // Resolve the active date window once per change; leads are filtered by their
  // received date (createdAt).
  const resolvedRange = useMemo(() => resolveRange(dateRange), [dateRange]);
  const filteredLeads = leads.filter(l => {
    if (filterStage !== 'all' && l.stage !== filterStage) return false;
    if (search && !l.name.toLowerCase().includes(search.toLowerCase()) && !l.phone.includes(search)) return false;
    if (!inRange(l.createdAt, resolvedRange)) return false;
    return true;
  });

  const groupedLeads = leadStages.reduce((acc, stage) => {
    acc[stage.id] = filteredLeads.filter(l => l.stage === stage.id);
    return acc;
  }, {} as Record<LeadStage, Lead[]>);

  // Performance: Create lookup maps for O(1) access instead of O(n) find()
  const userMap = useMemo(() => {
    const map = new Map<string, UserType>();
    allUsers.forEach(u => map.set(u.id, u));
    return map;
  }, [allUsers]);

  const notesMap = useMemo(() => {
    const map = new Map<string, Note[]>();
    notes.forEach(n => {
      if (!map.has(n.leadId)) map.set(n.leadId, []);
      map.get(n.leadId)!.push(n);
    });
    return map;
  }, [notes]);

  const activitiesMap = useMemo(() => {
    const map = new Map<string, Activity[]>();
    activities.forEach(a => {
      if (!map.has(a.leadId)) map.set(a.leadId, []);
      map.get(a.leadId)!.push(a);
    });
    return map;
  }, [activities]);

  const getUserName = (id: string) => userMap.get(id)?.name || 'Unassigned';
  const leadNotes = selectedLead ? (notesMap.get(selectedLead.id) || []) : [];
  const leadActivities = selectedLead ? (activitiesMap.get(selectedLead.id) || []) : [];

  // Duplicate detection — group leads that share a phone or email
  const duplicateGroups = useMemo(() => {
    const groups: Record<string, Lead[]> = {};
    leads.forEach(l => {
      const key = normalizePhone(l.phone) || l.email.toLowerCase();
      if (!key) return;
      groups[key] = groups[key] || [];
      groups[key].push(l);
    });
    return Object.values(groups).filter(g => g.length > 1);
  }, [leads]);
  const duplicateCount = duplicateGroups.reduce((s, g) => s + g.length, 0);

  const audit = (action: string, entityId: string, details: string) => {
    if (!user) return;
    logAudit({ tenantId, userId, userName: user.name, action, entity: 'lead', entityId, details });
  };

  const handleMerge = async (primary: Lead, secondary: Lead) => {
    if (!confirm(`Merge "${secondary.name}" into "${primary.name}"? Notes & activities will be moved to the primary lead and the duplicate will be deleted.`)) return;
    // Move notes & activities to the primary lead
    getByTenant<Note>('notes', tenantId).filter(n => n.leadId === secondary.id).forEach(n => {
      update<Note>('notes', n.id, { leadId: primary.id });
    });
    getByTenant<Activity>('activities', tenantId).filter(a => a.leadId === secondary.id).forEach(a => {
      update<Activity>('activities', a.id, { leadId: primary.id });
    });
    // Keep the most advanced stage and highest budget ('lost' ranks below
    // everything so an active stage always wins regardless of merge order)
    const stageOrder = leadStages.map(s => s.id);
    const stageRank = (s: LeadStage) => (s === 'lost' ? -1 : stageOrder.indexOf(s));
    const bestStage = stageRank(secondary.stage) > stageRank(primary.stage) ? secondary.stage : primary.stage;
    try {
      await patchLead(primary.id, {
        budget: Math.max(primary.budget, secondary.budget),
        stage: bestStage,
        lastContact: new Date().toISOString(),
      });
      // Only drop the duplicate once the survivor actually took the merge —
      // otherwise a failed patch would still destroy the secondary lead.
      await removeLead(secondary.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not merge the leads');
      return;
    }
    audit('merge', primary.id, `Merged duplicate "${secondary.name}" into "${primary.name}"`);
    setSelectedIds(prev => {
      if (!prev.has(secondary.id)) return prev;
      const next = new Set(prev); next.delete(secondary.id); return next;
    });
    refresh();
    toast.success('Leads merged successfully');
  };

  // Marking a lead lost requires a reason (spec: lost_reason mandatory when
  // stage = lost) — the stage change parks here until the modal supplies one.
  const [lostPromptLeadId, setLostPromptLeadId] = useState<string | null>(null);

  const handleStageChange = async (leadId: string, newStage: LeadStage, lostReason?: string) => {
    // "Booked" is an outcome, not a label: it requires a unit + payment
    // schedule, which only the booking flow creates
    if (newStage === 'booked') {
      const hasBooking = getByTenant<{ tenantId: string; leadId: string }>('bookings', tenantId).some(b => b.leadId === leadId);
      if (!hasBooking) {
        toast.error('Use "Confirm Unit Booking" in the lead drawer — booking locks a unit and generates the payment schedule');
        return;
      }
    }
    if (newStage === 'lost' && !lostReason) {
      setLostPromptLeadId(leadId);
      return;
    }
    const now = new Date().toISOString();
    try {
      await patchLead(leadId, { stage: newStage, lastContact: now, ...(lostReason ? { lostReason } : {}) });
    } catch (err) {
      // Surface the server's reason (e.g. a stage not in this tenant's
      // pipeline, or no permission) instead of leaving the board looking moved.
      toast.error(err instanceof Error ? err.message : 'Could not update the stage');
      return;
    }
    create<Activity>('activities', {
      id: '', tenantId, leadId, userId, type: 'status_change',
      description: `Stage changed to ${leadStages.find(s => s.id === newStage)?.label}${lostReason ? ` — reason: ${lostReason}` : ''}`,
      createdAt: now,
    });
    audit('stage_change', leadId, `Stage changed to ${leadStages.find(s => s.id === newStage)?.label}${lostReason ? ` (${lostReason})` : ''}`);
    refresh();
    if (selectedLead?.id === leadId) {
      setSelectedLead(prev => prev ? { ...prev, stage: newStage, lastContact: now } : null);
    }
    toast.success('Lead stage updated');
  };

  const handleAddNote = async () => {
    if (!noteInput.trim() || !selectedLead) return;
    create<Note>('notes', {
      id: '', tenantId, leadId: selectedLead.id, userId, content: noteInput.trim(),
      createdAt: new Date().toISOString(),
    });
    create<Activity>('activities', {
      id: '', tenantId, leadId: selectedLead.id, userId, type: 'note',
      description: `Note added: ${noteInput.trim().slice(0, 50)}...`,
      createdAt: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    // Non-fatal: the note itself is already saved, so a failed "last contact"
    // touch must not present as the note having failed.
    await patchLead(selectedLead.id, { lastContact: now }).catch(() => {});
    setSelectedLead(prev => prev ? { ...prev, lastContact: now } : null);
    setNoteInput('');
    refresh();
    toast.success('Note added');
  };

  const handleAddLead = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    const name = formData.get('name') as string;
    const email = formData.get('email') as string;
    const phone = formData.get('phone') as string;
    if (!name || !phone) { toast.error('Name and phone are required'); return; }

    // Duplicate detection on create
    const inPhone = normalizePhone(phone);
    const existing = leads.find(l =>
      (inPhone && normalizePhone(l.phone) === inPhone) ||
      (email && l.email.toLowerCase() === email.toLowerCase())
    );
    if (existing) {
      if (!confirm(`A lead with this phone/email already exists ("${existing.name}"). Create anyway?`)) return;
    }

    let created: Lead;
    try {
      created = await createLead({
        tenantId, name, email: email || '', phone,
        source: (formData.get('source') as string) || 'Manual',
        project: (formData.get('project') as string) || tenantProjects[0]?.name || 'General Enquiry',
        budget: Number(formData.get('budget')) || 0,
        configuration: (formData.get('configuration') as string) || '2 BHK',
        stage: 'new', priority: 'warm', assignedTo: (formData.get('assignedTo') as string) || userId,
        // Knowingly-created duplicate stays traceable to the original
        ...(existing ? { duplicateOf: existing.id } : {}),
        lastContact: new Date().toISOString(), createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the lead');
      return;
    }
    audit('create', created.id, `Created lead "${name}"`);
    setShowAddModal(false);
    refresh();
    toast.success('Lead created successfully');
  };

  const handleDeleteLead = async (leadId: string) => {
    if (!confirm('Are you sure you want to delete this lead?')) return;
    const target = leads.find(l => l.id === leadId);
    try {
      await removeLead(leadId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete the lead');
      return;
    }
    audit('delete', leadId, `Deleted lead "${target?.name || leadId}"`);
    if (selectedLead?.id === leadId) setSelectedLead(null);
    // Keep the bulk-selection count honest
    setSelectedIds(prev => {
      if (!prev.has(leadId)) return prev;
      const next = new Set(prev); next.delete(leadId); return next;
    });
    refresh();
    toast.success('Lead deleted');
  };

  // ── Bulk actions ──────────────────────────────────────────────────────────
  const canManage = hasPermission('manage_leads');
  const canAssign = canManage || hasPermission('assign_leads');
  const canBulk = canManage || hasPermission('manage_own_leads');

  const selectedLeads = leads.filter(l => selectedIds.has(l.id));
  const allVisibleSelected = filteredLeads.length > 0 && filteredLeads.every(l => selectedIds.has(l.id));

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds(allVisibleSelected ? new Set() : new Set(filteredLeads.map(l => l.id)));
  };

  const clearSelection = () => setSelectedIds(new Set());

  const handleBulkAssign = async (assigneeId: string) => {
    if (!assigneeId || selectedLeads.length === 0) return;
    const { ok, failed } = await patchLeads(selectedLeads.map(l => l.id), { assignedTo: assigneeId });
    setSelectedLead(prev => prev && selectedIds.has(prev.id) ? { ...prev, assignedTo: assigneeId } : prev);
    audit('bulk_assign', 'bulk', `Bulk-assigned ${ok} lead(s) to ${getUserName(assigneeId)}`);
    // Report what actually happened — a partial failure used to be invisible.
    if (ok) toast.success(`${ok} lead(s) assigned to ${getUserName(assigneeId)}`);
    if (failed) toast.error(`${failed} lead(s) could not be assigned`);
    clearSelection();
    refresh();
  };

  const handleBulkStage = async (stage: LeadStage) => {
    if (selectedLeads.length === 0) return;
    if (stage === 'booked') {
      toast.error('Bulk-moving to Booked is disabled — each booking needs a unit and payment schedule. Use "Confirm Unit Booking" per lead.');
      return;
    }
    const label = leadStages.find(s => s.id === stage)?.label;
    const now = new Date().toISOString();
    const { ok, failed } = await patchLeads(selectedLeads.map(l => l.id), { stage, lastContact: now });
    selectedLeads.forEach(l => {
      create<Activity>('activities', {
        id: '', tenantId, leadId: l.id, userId, type: 'status_change',
        description: `Stage changed to ${label} (bulk update)`, createdAt: now,
      });
    });
    audit('bulk_stage', 'bulk', `Bulk-moved ${ok} lead(s) to ${label}`);
    if (ok) toast.success(`${ok} lead(s) moved to ${label}`);
    if (failed) toast.error(`${failed} lead(s) could not be moved`);
    clearSelection();
    refresh();
  };

  const handleBulkPriority = async (priority: Priority) => {
    if (selectedLeads.length === 0) return;
    const { ok, failed } = await patchLeads(selectedLeads.map(l => l.id), { priority });
    setSelectedLead(prev => prev && selectedIds.has(prev.id) ? { ...prev, priority } : prev);
    audit('bulk_priority', 'bulk', `Bulk-set priority ${priority} on ${ok} lead(s)`);
    if (ok) toast.success(`${ok} lead(s) set to ${priority}`);
    if (failed) toast.error(`${failed} lead(s) could not be updated`);
    clearSelection();
    refresh();
  };

  const handleBulkDelete = async () => {
    if (selectedLeads.length === 0) return;
    if (!confirm(`Delete ${selectedLeads.length} lead(s)? This cannot be undone.`)) return;
    const { ok, failed } = await deleteLeads(selectedLeads.map(l => l.id));
    audit('bulk_delete', 'bulk', `Bulk-deleted ${ok} lead(s): ${selectedLeads.slice(0, 5).map(l => l.name).join(', ')}${selectedLeads.length > 5 ? '…' : ''}`);
    if (selectedLead && selectedIds.has(selectedLead.id)) setSelectedLead(null);
    if (ok) toast.success(`${ok} lead(s) deleted`);
    if (failed) toast.error(`${failed} lead(s) could not be deleted`);
    clearSelection();
    refresh();
  };

  const handleBulkExport = () => {
    if (selectedLeads.length === 0) return;
    const rows = [['Name', 'Phone', 'Email', 'Project', 'Stage', 'Budget', 'Source', 'Assigned To']];
    selectedLeads.forEach(l => rows.push([l.name, l.phone, l.email, l.project, l.stage, String(l.budget), l.source, getUserName(l.assignedTo)]));
    // toCsv neutralises formula-injection: a lead name from an untrusted source
    // (microsite enquiry, portal, import) must not execute when opened in Excel.
    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `leads-selected-${new Date().toISOString().split('T')[0]}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast.success(`${selectedLeads.length} lead(s) exported`);
  };

  // ── Bulk upload (CSV import) ──────────────────────────────────────────────
  const downloadTemplate = () => {
    const csv = 'Name,Phone,Email,Project,Budget,Configuration,Source\n"Rohan Verma","+91 98220 11223","rohan.v@email.com","Skyline Heights","15000000","3 BHK","Website"';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'leads-import-template.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (file: File) => {
    // Strip the UTF-8 BOM Excel prepends, or the "Name" header never matches
    const text = (await file.text()).replace(/^﻿/, '');
    const rows = parseCsv(text);
    if (rows.length < 2) { toast.error('CSV must have a header row and at least one data row'); return; }
    const header = rows[0].map(h => h.trim().toLowerCase());
    const col = (name: string) => header.indexOf(name);
    if (col('name') === -1 || col('phone') === -1) {
      toast.error('CSV must include "Name" and "Phone" columns — download the template for the format');
      return;
    }
    const existingPhones = new Set(allLeadsData.map(l => normalizePhone(l.phone)).filter(Boolean));
    const existingEmails = new Set(allLeadsData.map(l => l.email.toLowerCase()).filter(Boolean));
    const valid: ImportRow[] = [];
    let invalid = 0, dupes = 0;
    rows.slice(1).forEach(r => {
      const cell = (name: string) => (col(name) >= 0 ? (r[col(name)] || '').trim() : '');
      const name = cell('name'), phone = cell('phone');
      if (!name || !phone) { invalid++; return; }
      const nPhone = normalizePhone(phone);
      const email = cell('email').toLowerCase();
      if ((nPhone && existingPhones.has(nPhone)) || (email && existingEmails.has(email))) { dupes++; return; }
      if (nPhone) existingPhones.add(nPhone);
      if (email) existingEmails.add(email);
      valid.push({
        name, phone, email: cell('email'),
        project: cell('project') || 'General Enquiry',
        budget: Number(cell('budget').replace(/[^0-9.]/g, '')) || 0,
        configuration: cell('configuration') || '2 BHK',
        source: cell('source') || 'Bulk Import',
      });
    });
    setImportPreview({ valid, invalid, dupes });
  };

  const handleConfirmImport = async () => {
    if (!importPreview || importPreview.valid.length === 0) return;
    const now = new Date().toISOString();
    // Sequential: a CSV can be hundreds of rows and the API rate-limits per IP.
    let ok = 0, failed = 0;
    for (const rowData of importPreview.valid) {
      try {
        await createLead({
          tenantId, ...rowData,
          stage: 'new', priority: 'warm', assignedTo: userId,
          lastContact: now, createdAt: now,
        });
        ok++;
      } catch { failed++; }
    }
    audit('bulk_import', 'bulk', `Bulk-imported ${ok} lead(s) from CSV`);
    if (ok) toast.success(`${ok} lead(s) imported`);
    if (failed) toast.error(`${failed} row(s) could not be imported`);
    setImportPreview(null);
    setShowImport(false);
    refresh();
  };

  return (
    <div className="flex gap-0 h-full max-w-full relative">
      {/* Kanban Board */}
      <div className={`flex-1 transition-all ${selectedLead ? 'lg:mr-[440px]' : ''}`}>
        {/* Toolbar - Responsive with mobile stacking */}
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-3 mb-4">
          {/* Search - Full width on mobile */}
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search leads by name or phone..."
              className="w-full pl-9 pr-4 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all"
            />
          </div>
          
          {/* Stage Filters - Scrollable on mobile */}
          <div className="flex items-center gap-2 bg-white border border-zinc-200 rounded-xl p-1 overflow-x-auto lg:overflow-visible scrollbar-hide">
            <button
              onClick={() => setFilterStage('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${filterStage === 'all' ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
            >All</button>
            {leadStages.map(s => (
              <button
                key={s.id}
                onClick={() => setFilterStage(s.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${filterStage === s.id ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
              >{s.label}</button>
            ))}
          </div>
          
          {/* Action Buttons - Stack on mobile, row on desktop */}
          <div className="flex items-center gap-2 flex-wrap lg:flex-nowrap">
            <DateRangeFilter value={dateRange} onChange={setDateRange} align="right" />
            <button className="flex items-center gap-2 px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors">
              <Filter className="h-4 w-4" /> Filters
            </button>
            <button
              onClick={() => {
                const rows = [['Name', 'Phone', 'Email', 'Project', 'Stage', 'Budget', 'Source', 'Assigned To']];
                filteredLeads.forEach(l => rows.push([l.name, l.phone, l.email, l.project, l.stage, String(l.budget), l.source, getUserName(l.assignedTo)]));
                const csv = toCsv(rows);   // formula-injection-safe (see utils/csv.ts)
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                const rangePart = dateRange.preset === 'all' ? '' : `-${rangeSlug(dateRange)}`;
                a.href = url; a.download = `leads${rangePart}-${new Date().toISOString().split('T')[0]}.csv`; a.click();
                URL.revokeObjectURL(url);
                toast.success(`Exported ${filteredLeads.length} lead${filteredLeads.length === 1 ? '' : 's'} to CSV`);
              }}
              className="flex items-center gap-2 px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors"
            >
              <Download className="h-4 w-4" /> Export
            </button>
            {canBulk && (
              <button
                onClick={() => { setImportPreview(null); setShowImport(true); }}
                className="flex items-center gap-2 px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors"
              >
                <Upload className="h-4 w-4" /> Import
              </button>
            )}
            <div className="flex items-center gap-1 bg-white border border-zinc-200 rounded-xl p-1 shrink-0">
              <button
                onClick={() => setViewMode('kanban')}
                className={`p-1.5 rounded-lg transition-all ${viewMode === 'kanban' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:text-zinc-600'}`}
                title="Kanban View"
              >
                <Kanban className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded-lg transition-all ${viewMode === 'list' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:text-zinc-600'}`}
                title="List View"
              >
                <List className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode('grid')}
                className={`p-1.5 rounded-lg transition-all ${viewMode === 'grid' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:text-zinc-600'}`}
                title="Grid View"
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
            </div>
            {duplicateGroups.length > 0 && (hasPermission('manage_leads') || hasPermission('manage_own_leads')) && (
              <button
                onClick={() => setShowDuplicates(true)}
                className="flex items-center gap-2 px-3 py-2.5 bg-amber-50 border border-amber-200 text-amber-700 rounded-xl text-sm font-medium hover:bg-amber-100 transition-colors"
              >
                <AlertTriangle className="h-4 w-4" /> {duplicateCount} Duplicates
              </button>
            )}
            {(hasPermission('manage_own_leads') || hasPermission('manage_leads')) && (
              <button
                onClick={() => setShowAddModal(true)}
                className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm whitespace-nowrap"
              >
                <Plus className="h-4 w-4" /> Add Lead
              </button>
            )}
          </div>
        </div>

        {/* API-mode indicator: reads are live from the backend; writes stay
            local until the Phase-2 write APIs land */}
        {apiLeads !== null && (
          <div className="flex items-center gap-2 bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-xl px-3 py-2 mb-4 text-xs font-medium">
            ⚡ Live server data — leads are stored in PostgreSQL with tenant isolation (RLS) and permissions enforced in the database. Creates, edits and deletes are saved to the server.
          </div>
        )}

        {/* Active date-filter summary */}
        {dateRange.preset !== 'all' && (
          <div className="flex items-center gap-2 flex-wrap bg-white border border-zinc-200 rounded-xl px-3 py-2 mb-4 text-xs">
            <Calendar className="h-3.5 w-3.5 text-indigo-500" />
            <span className="font-medium text-zinc-600">Received: <span className="text-indigo-700">{rangeLabel(dateRange)}</span></span>
            <span className="text-zinc-400">·</span>
            <span className="text-zinc-500">{filteredLeads.length} lead{filteredLeads.length === 1 ? '' : 's'}</span>
            <button
              onClick={() => setDateRange(ALL_RANGE)}
              className="ml-1 text-indigo-600 hover:text-indigo-800 underline underline-offset-2"
            >Clear</button>
          </div>
        )}

        {/* Bulk action bar */}
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2 flex-wrap bg-indigo-600 text-white rounded-xl px-4 py-2.5 mb-4 shadow-md animate-fade-in">
            <span className="text-sm font-semibold">{selectedIds.size} selected</span>
            <button onClick={clearSelection} className="text-xs text-indigo-200 hover:text-white underline underline-offset-2">Clear</button>
            <div className="flex-1" />
            {canAssign && (
              <div className="flex items-center gap-1.5">
                <UserCheck className="h-3.5 w-3.5 text-indigo-200" />
                <select
                  value=""
                  onChange={e => handleBulkAssign(e.target.value)}
                  className="text-xs bg-indigo-500/60 border border-indigo-400 rounded-lg px-2 py-1.5 text-white focus:outline-none cursor-pointer"
                >
                  <option value="" disabled>Assign to…</option>
                  {allUsers.filter(u => u.role !== 'super_admin' && u.active).map(u => (
                    <option key={u.id} value={u.id} className="text-zinc-900">{u.name}</option>
                  ))}
                </select>
              </div>
            )}
            <select
              value=""
              onChange={e => handleBulkStage(e.target.value as LeadStage)}
              className="text-xs bg-indigo-500/60 border border-indigo-400 rounded-lg px-2 py-1.5 text-white focus:outline-none cursor-pointer"
            >
              <option value="" disabled>Move to stage…</option>
              {leadStages.map(s => <option key={s.id} value={s.id} className="text-zinc-900">{s.label}</option>)}
            </select>
            <select
              value=""
              onChange={e => handleBulkPriority(e.target.value as Priority)}
              className="text-xs bg-indigo-500/60 border border-indigo-400 rounded-lg px-2 py-1.5 text-white focus:outline-none cursor-pointer"
            >
              <option value="" disabled>Set priority…</option>
              <option value="hot" className="text-zinc-900">Hot</option>
              <option value="warm" className="text-zinc-900">Warm</option>
              <option value="cold" className="text-zinc-900">Cold</option>
            </select>
            <button
              onClick={handleBulkExport}
              className="flex items-center gap-1.5 text-xs font-medium bg-indigo-500/60 border border-indigo-400 rounded-lg px-2.5 py-1.5 hover:bg-indigo-500"
            >
              <Download className="h-3.5 w-3.5" /> Export
            </button>
            {canManage && (
              <button
                onClick={handleBulkDelete}
                className="flex items-center gap-1.5 text-xs font-semibold bg-red-500 rounded-lg px-2.5 py-1.5 hover:bg-red-600"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
            )}
          </div>
        )}

        {/* Kanban View */}
        {viewMode === 'kanban' && (
          <div className="flex gap-4 overflow-x-auto pb-4" style={{ minHeight: 'calc(100vh - 200px)' }}>
            {leadStages.map(stage => {
              const stageLeads = groupedLeads[stage.id] || [];
              return (
                <div key={stage.id} className="flex-1 min-w-[250px] max-w-[320px] shrink-0">
                  <div className="flex items-center justify-between mb-3 px-1">
                    <div className="flex items-center gap-2">
                      <div className={`h-2.5 w-2.5 rounded-full ${stage.color}`} />
                      <h3 className="text-sm font-semibold text-zinc-800">{stage.label}</h3>
                    </div>
                    <span className="text-xs font-medium text-zinc-400 bg-zinc-100 px-2 py-0.5 rounded-full">{stageLeads.length}</span>
                  </div>
                  <div className="space-y-2.5">
                    {stageLeads.map(lead => (
                      <div key={lead.id} className="relative group/card">
                        <button
                          onClick={() => setSelectedLead(lead)}
                          className={`w-full text-left bg-white rounded-xl border border-zinc-200/60 border-l-4 ${stageBorder(lead.stage)} p-3.5 hover:shadow-md hover:border-zinc-300 transition-all duration-200`}
                        >
                          <div className="flex items-start justify-between mb-2">
                            <div className="flex items-center gap-2.5">
                              <div className={`h-8 w-8 rounded-lg ${lead.priority === 'hot' ? 'bg-gradient-to-br from-red-100 to-orange-100' : 'bg-zinc-100'} flex items-center justify-center`}>
                                <span className={`text-xs font-bold ${lead.priority === 'hot' ? 'text-orange-600' : 'text-zinc-500'}`}>
                                  {lead.name.split(' ').map(n => n[0]).join('')}
                                </span>
                              </div>
                              <div>
                                <p className="text-sm font-semibold text-zinc-900 group-hover/card:text-indigo-700 transition-colors">{lead.name}</p>
                                <p className="text-[11px] text-zinc-500">{lead.phone}</p>
                              </div>
                            </div>
                            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${priorityColors[lead.priority]}`}>{lead.priority}</span>
                          </div>
                          <div className="flex items-center gap-3 text-[11px] text-zinc-500">
                            <span className="flex items-center gap-1"><Building2 className="h-3 w-3" />{lead.project}</span>
                            <span className="flex items-center gap-1">{formatCurrency(lead.budget, currency)}</span>
                          </div>
                          <div className="flex items-center gap-3 mt-2 pt-2 border-t border-zinc-100">
                            <span className="flex items-center gap-1 text-[11px] text-zinc-400">
                              <Clock className="h-3 w-3" />
                              {new Date(lead.lastContact).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                            </span>
                            <span className="text-[11px] text-zinc-400">{getUserName(lead.assignedTo)}</span>
                          </div>
                        </button>
                        {/* Stage change quick actions */}
                        <div className="absolute top-2 right-2 opacity-0 group-hover/card:opacity-100 transition-opacity flex gap-1">
                          {leadStages.filter(s => s.id !== lead.stage).slice(0, 2).map(s => (
                            <button
                              key={s.id}
                              onClick={(e) => { e.stopPropagation(); handleStageChange(lead.id, s.id); }}
                              className={`h-5 w-5 rounded-full ${s.color} opacity-60 hover:opacity-100 transition-opacity`}
                              title={`Move to ${s.label}`}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                    {stageLeads.length === 0 && (
                      <div className="text-center py-8 text-zinc-400">
                        <div className="h-12 w-12 rounded-xl bg-zinc-100 mx-auto mb-2 flex items-center justify-center">
                          <Users className="h-5 w-5 text-zinc-300" />
                        </div>
                        <p className="text-xs">No leads</p>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* List View */}
        {viewMode === 'list' && (
          <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-zinc-50/50 border-b border-zinc-100">
                    <th className="px-4 py-3 w-10">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAll}
                        className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                        title="Select all visible leads"
                      />
                    </th>
                    <th className="text-left px-5 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Name</th>
                    <th className="text-left px-5 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Contact</th>
                    <th className="text-left px-5 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Project</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Budget</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Stage</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Priority</th>
                    <th className="text-left px-5 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Assigned To</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLeads.map(lead => (
                    <tr
                      key={lead.id}
                      onClick={() => setSelectedLead(lead)}
                      className={`border-b border-zinc-50 hover:bg-zinc-50/50 transition-colors cursor-pointer ${selectedIds.has(lead.id) ? 'bg-indigo-50/40' : ''}`}
                    >
                      <td className="px-4 py-3.5" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(lead.id)}
                          onChange={() => toggleSelect(lead.id)}
                          className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                        />
                      </td>
                      <td className="px-5 py-3.5">
                        <p className="text-sm font-semibold text-zinc-900">{lead.name}</p>
                        <p className="text-[11px] text-zinc-500 mt-0.5">Source: {lead.source}</p>
                      </td>
                      <td className="px-5 py-3.5" onClick={e => e.stopPropagation()}>
                        <a href={telHref(lead.phone)} className="text-sm text-zinc-700 hover:text-indigo-600 hover:underline block">{lead.phone}</a>
                        {lead.email && <a href={mailtoHref(lead.email)} className="text-xs text-zinc-500 mt-0.5 hover:text-indigo-600 hover:underline block">{lead.email}</a>}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-zinc-700">{lead.project}</td>
                      <td className="px-5 py-3.5 text-sm font-semibold text-zinc-900 text-right">
                        {formatCurrency(lead.budget, currency)}
                      </td>
                      <td className="px-5 py-3.5 text-center">
                        <span className={`inline-block text-[11px] font-semibold px-2.5 py-1 rounded-full ${stageBorder(lead.stage)} bg-opacity-10 text-opacity-100 ${
                          lead.stage === 'new' ? 'bg-blue-500 text-blue-700 border border-blue-200' :
                          lead.stage === 'booked' ? 'bg-emerald-500 text-emerald-700 border border-emerald-200' :
                          lead.stage === 'lost' ? 'bg-red-500 text-red-700 border border-red-200' :
                          'bg-zinc-500 text-zinc-700 border border-zinc-200'
                        }`}>
                          {leadStages.find(s => s.id === lead.stage)?.label || lead.stage}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-center">
                        <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${priorityColors[lead.priority]}`}>
                          {lead.priority}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-zinc-700">
                        {getUserName(lead.assignedTo)}
                      </td>
                    </tr>
                  ))}
                  {filteredLeads.length === 0 && (
                    <tr>
                      <td colSpan={8} className="text-center py-12 text-zinc-400">
                        <Users className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
                        <p className="text-sm">No leads match the filters</p>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {viewMode === 'grid' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredLeads.map(lead => (
              <div key={lead.id} className="relative">
                <input
                  type="checkbox"
                  checked={selectedIds.has(lead.id)}
                  onChange={() => toggleSelect(lead.id)}
                  onClick={e => e.stopPropagation()}
                  className="absolute top-3 right-3 z-10 h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                  title="Select lead"
                />
              <button
                onClick={() => setSelectedLead(lead)}
                className={`w-full text-left bg-white rounded-2xl border ${selectedIds.has(lead.id) ? 'border-indigo-300 ring-2 ring-indigo-100' : 'border-zinc-200/60'} border-l-4 ${stageBorder(lead.stage)} p-4 hover:shadow-lg hover:border-zinc-300 transition-all duration-200 group relative`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className={`h-10 w-10 rounded-xl ${lead.priority === 'hot' ? 'bg-gradient-to-br from-red-100 to-orange-100' : 'bg-zinc-100'} flex items-center justify-center shrink-0`}>
                      <span className={`text-sm font-bold ${lead.priority === 'hot' ? 'text-orange-600' : 'text-zinc-500'}`}>
                        {lead.name.split(' ').map(n => n[0]).join('')}
                      </span>
                    </div>
                    <div>
                      <p className="text-sm font-bold text-zinc-900 group-hover:text-indigo-700 transition-colors">{lead.name}</p>
                      <p className="text-xs text-zinc-500 mt-0.5">{lead.phone}</p>
                    </div>
                  </div>
                  <span className={`mr-7 text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${priorityColors[lead.priority]}`}>
                    {lead.priority}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 py-2 border-t border-b border-zinc-50 my-3">
                  <div>
                    <p className="text-[10px] text-zinc-400 uppercase tracking-wider">Project</p>
                    <p className="text-xs font-medium text-zinc-700 truncate mt-0.5">{lead.project}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-zinc-400 uppercase tracking-wider">Budget</p>
                    <p className="text-xs font-semibold text-zinc-900 mt-0.5">{formatCurrency(lead.budget, currency)}</p>
                  </div>
                </div>

                <div className="flex items-center justify-between text-[11px] text-zinc-500">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {new Date(lead.lastContact).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                  </span>
                  <span className="font-medium bg-zinc-100 text-zinc-600 px-2 py-0.5 rounded">
                    {leadStages.find(s => s.id === lead.stage)?.label || lead.stage}
                  </span>
                </div>
              </button>
              </div>
            ))}
            {filteredLeads.length === 0 && (
              <div className="col-span-full text-center py-16 bg-white rounded-2xl border border-zinc-200/60">
                <Users className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
                <p className="text-sm text-zinc-500">No leads found</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Lead Detail Drawer - Responsive: Full width on mobile, side panel on desktop */}
      {selectedLead && (
        <>
          {/* Mobile Overlay */}
          <div 
            className="lg:hidden fixed inset-0 bg-black/40 backdrop-blur-sm z-40 animate-fade-in"
            onClick={() => setSelectedLead(null)}
          />
          
          {/* Drawer */}
          <div className="fixed lg:sticky top-0 right-0 h-full lg:h-auto w-full sm:w-[420px] lg:w-[420px] shrink-0 bg-white border-l border-zinc-200 overflow-y-auto animate-slide-in z-50 lg:z-auto">
            <div className="sticky top-0 bg-white border-b border-zinc-100 p-4 flex items-center justify-between z-10">
              <h3 className="font-semibold text-zinc-900 flex items-center gap-2">
                <div className={`h-8 w-8 rounded-lg ${selectedLead.priority === 'hot' ? 'bg-gradient-to-br from-red-100 to-orange-100' : 'bg-zinc-100'} flex items-center justify-center`}>
                  <span className={`text-xs font-bold ${selectedLead.priority === 'hot' ? 'text-orange-600' : 'text-zinc-500'}`}>
                    {selectedLead.name.split(' ').map(n => n[0]).join('')}
                  </span>
                </div>
                <span className="truncate">{selectedLead.name}</span>
              </h3>
              <div className="flex items-center gap-1">
                {/* Dual-mode calling toggle (persistent per user) */}
                <div className="flex items-center bg-zinc-100 rounded-lg p-0.5 mr-1" title="Calling mode: SIM dials from your device; Cloud bridges via the telephony API with recording">
                  <button
                    onClick={() => toggleCallingMode('SIM_NATIVE')}
                    className={`px-2 py-1 rounded-md text-[10px] font-bold transition-all ${callingMode === 'SIM_NATIVE' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-400 hover:text-zinc-600'}`}
                  >
                    📱 SIM
                  </button>
                  <button
                    onClick={() => toggleCallingMode('API_CLOUD')}
                    className={`px-2 py-1 rounded-md text-[10px] font-bold transition-all ${callingMode === 'API_CLOUD' ? 'bg-white text-indigo-600 shadow-sm' : 'text-zinc-400 hover:text-zinc-600'}`}
                  >
                    ☁️ Cloud
                  </button>
                </div>
                <button
                  onClick={() => {
                    if (confirm(`Delete ${selectedLead.name}? This cannot be undone.`)) {
                      handleDeleteLead(selectedLead.id);
                    }
                  }}
                  className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 transition-colors"
                  title="Delete lead"
                >
                  <X className="h-4 w-4" />
                </button>
                <button onClick={() => setSelectedLead(null)} className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-500 transition-colors ml-1">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>

          <div className="p-4 space-y-5">
            {/* Quick Info */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-zinc-50 rounded-xl p-3">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium">Stage</p>
                <select
                  value={selectedLead.stage}
                  onChange={e => handleStageChange(selectedLead.id, e.target.value as LeadStage)}
                  className="mt-1 text-xs font-semibold bg-transparent border-0 p-0 focus:outline-none cursor-pointer"
                >
                  {leadStages.map(s => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div className="bg-zinc-50 rounded-xl p-3">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium">Priority</p>
                <span className={`inline-block mt-1 text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${priorityColors[selectedLead.priority]}`}>{selectedLead.priority}</span>
              </div>
              <div className="bg-zinc-50 rounded-xl p-3">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium">Budget</p>
                <p className="text-sm font-semibold text-zinc-900 mt-0.5">{formatCurrency(selectedLead.budget, currency)}</p>
              </div>
              <div className="bg-zinc-50 rounded-xl p-3">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium">Config</p>
                <p className="text-sm font-semibold text-zinc-900 mt-0.5">{selectedLead.configuration}</p>
              </div>
            </div>

            {/* Lead Score — explainable ("Lead Prophecy") */}
            {(() => {
              const { score, factors, nextBestAction } = explainLeadScore(selectedLead);
              const band = leadScoreBand(score);
              return (
                <div className="bg-zinc-50 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium flex items-center gap-1">
                      <Gauge className="h-3.5 w-3.5" /> Lead Score
                    </p>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${band.color}`}>{score}/100 · {band.label}</span>
                  </div>
                  <div className="h-2 bg-zinc-200 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${score >= 70 ? 'bg-red-500' : score >= 45 ? 'bg-amber-500' : 'bg-zinc-400'}`} style={{ width: `${score}%` }} />
                  </div>
                  {/* Transparency: exactly why this lead scored what it did */}
                  <details className="mt-2 group">
                    <summary className="text-[11px] font-medium text-indigo-600 cursor-pointer hover:text-indigo-700 list-none flex items-center gap-1">
                      <Sparkles className="h-3 w-3" /> Why this score?
                    </summary>
                    <div className="mt-2 space-y-1">
                      {factors.map(f => (
                        <div key={f.label} className="flex items-start justify-between gap-2 text-[11px]">
                          <span className="text-zinc-600">{f.label} <span className="text-zinc-400">· {f.detail}</span></span>
                          <span className={`font-semibold shrink-0 ${f.points > 0 ? 'text-emerald-600' : 'text-zinc-400'}`}>+{f.points}</span>
                        </div>
                      ))}
                      <div className="mt-2 pt-2 border-t border-zinc-200 flex items-start gap-1.5">
                        <span className="text-[11px]">💡</span>
                        <p className="text-[11px] text-zinc-700"><span className="font-semibold">Next best action:</span> {nextBestAction}</p>
                      </div>
                    </div>
                  </details>
                </div>
              );
            })()}

            {/* Assignment */}
            {(hasPermission('assign_leads') || hasPermission('manage_leads')) && (
              <div className="bg-zinc-50 rounded-xl p-3">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium mb-1.5">Assigned To</p>
                <select
                  value={selectedLead.assignedTo}
                  onChange={async e => {
                    const assignedTo = e.target.value;   // capture before awaiting
                    try {
                      await patchLead(selectedLead.id, { assignedTo });
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : 'Could not reassign the lead');
                      return;
                    }
                    setSelectedLead(prev => prev ? { ...prev, assignedTo } : null);
                    refresh();
                    toast.success('Lead reassigned');
                  }}
                  className="w-full text-sm font-semibold bg-white border border-zinc-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  {allUsers.filter(u => u.role !== 'super_admin' && u.active).map(u => (
                    <option key={u.id} value={u.id}>{u.name} ({u.role.replace('_', ' ')})</option>
                  ))}
                </select>
              </div>
            )}

            {/* Priority Change */}
            <div className="bg-zinc-50 rounded-xl p-3">
              <p className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium mb-1.5">Priority</p>
              <div className="flex gap-2">
                {(['hot', 'warm', 'cold'] as const).map(p => (
                  <button
                    key={p}
                    onClick={async () => {
                      try {
                        await patchLead(selectedLead.id, { priority: p });
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : 'Could not set the priority');
                        return;
                      }
                      setSelectedLead(prev => prev ? { ...prev, priority: p } : null);
                      refresh();
                      toast.success(`Priority set to ${p}`);
                    }}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-semibold capitalize transition-all ${selectedLead.priority === p ? priorityColors[p] + ' ring-2 ring-current/20' : 'bg-white text-zinc-500 hover:bg-zinc-100'}`}
                  >{p}</button>
                ))}
              </div>
            </div>

            {/* Contact */}
            <div>
              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Contact</h4>
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-zinc-700">
                  <Mail className="h-4 w-4 text-zinc-400" />
                  {selectedLead.email
                    ? <a href={mailtoHref(selectedLead.email)} className="hover:text-indigo-600 hover:underline">{selectedLead.email}</a>
                    : 'N/A'}
                </div>
                <div className="flex items-center gap-2 text-sm text-zinc-700">
                  <Phone className="h-4 w-4 text-zinc-400" />
                  <a href={telHref(selectedLead.phone)} className="hover:text-indigo-600 hover:underline">{selectedLead.phone}</a>
                </div>
                <div className="flex items-center gap-2 text-sm text-zinc-700"><Building2 className="h-4 w-4 text-zinc-400" /> {selectedLead.project}</div>
                <div className="flex items-center gap-2 text-sm text-zinc-700"><Tag className="h-4 w-4 text-zinc-400" /> {selectedLead.source}</div>
              </div>
            </div>

            {/* Chatbot qualification snapshot + custom answers (only when captured) */}
            {(selectedLead.qualification || (selectedLead.customFields && Object.keys(selectedLead.customFields).length > 0)) && (
              <div className="space-y-2.5 bg-indigo-50/40 rounded-2xl p-3.5 border border-indigo-100">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider">Captured via {selectedLead.source}</p>
                  {selectedLead.qualification && (() => {
                    const b = qualificationBadge(selectedLead.qualification.status);
                    return <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${b.color}`}>{b.label} · {selectedLead.qualification.score}/100</span>;
                  })()}
                </div>
                {selectedLead.qualification?.reasons?.length ? (
                  <ul className="space-y-1">
                    {selectedLead.qualification.reasons.map((r, i) => (
                      <li key={i} className="text-xs text-zinc-600 flex items-start gap-1.5"><span className="text-indigo-400 mt-0.5">•</span>{r}</li>
                    ))}
                  </ul>
                ) : null}
                {selectedLead.customFields && Object.keys(selectedLead.customFields).length > 0 && (
                  <div className="pt-1 border-t border-indigo-100/70 space-y-1">
                    {Object.entries(selectedLead.customFields).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3 text-xs">
                        <span className="text-zinc-400 capitalize">{k.replace(/_/g, ' ')}</span>
                        <span className="text-zinc-700 font-medium text-right">{v}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Synced Workspace Actions */}
            <div className="space-y-2 bg-zinc-50/50 rounded-2xl p-3.5 border border-zinc-100">
              <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider mb-2">Synced Actions</p>
              
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    const target = { mode: callingMode, leadId: selectedLead.id, leadName: selectedLead.name };
                    if (callingMode === 'API_CLOUD') {
                      toast.loading('Bridging call via telephony API…', { id: 'cloudcall' });
                      try {
                        const res = await initiateCloudCall({
                          tenantId, agentPhone: user?.phone || '', leadPhone: selectedLead.phone, leadId: selectedLead.id,
                        });
                        toast.success(`Cloud call initiated (${res.provider}, ref ${res.callId}) — your phone rings first`, { id: 'cloudcall' });
                      } catch {
                        toast.error('Could not reach the telephony service — try again or switch to SIM mode', { id: 'cloudcall' });
                        return; // no call happened; don't force a log entry
                      }
                    } else {
                      toast.success(`Opening dialer for ${selectedLead.phone}...`);
                      window.location.href = telHref(selectedLead.phone);
                    }
                    // Post-call logging is mandatory: the modal captures
                    // duration + status into the lead history
                    setCallLogModal(target);
                  }}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-emerald-50 text-emerald-700 rounded-xl text-sm font-medium hover:bg-emerald-100 transition-colors"
                  title={callingMode === 'API_CLOUD' ? 'Call via cloud telephony (recorded)' : 'Call via device SIM'}
                >
                  <Phone className="h-4 w-4" /> {callingMode === 'API_CLOUD' ? 'Cloud Call' : 'Call'}
                </button>
                <button
                  onClick={async () => {
                    // Rep has a linked WhatsApp session → open the real chat
                    // thread (send + read replies without leaving the ERP).
                    if (isApiEnabled() && waConnected) { setChatLead(selectedLead); return; }
                    // Otherwise: the one-shot greeting flow, dispatched through
                    // whichever provider the tenant runs (click-to-chat / Meta).
                    const greeting = `Hi ${selectedLead.name.split(' ')[0]}, this is ${user?.name || 'your advisor'} from ${tenant?.name || 'our team'} regarding ${selectedLead.project}. Is this a good time to chat?`;
                    const out = await whatsappSend({ tenantId, phone: selectedLead.phone, text: greeting, leadId: selectedLead.id });
                    const viaLabel = out.provider === 'evolution' ? 'your WhatsApp' : 'Business API';
                    audit('whatsapp_log', selectedLead.id, out.delivered
                      ? `Sent WhatsApp to ${selectedLead.name} via ${viaLabel}`
                      : `Opened WhatsApp chat with ${selectedLead.name} (${out.provider})`);
                    create<Activity>('activities', {
                      id: '', tenantId, leadId: selectedLead.id, userId, type: 'whatsapp',
                      description: out.delivered
                        ? `WhatsApp sent to ${selectedLead.name} via ${viaLabel}`
                        : `WhatsApp conversation opened with ${selectedLead.name}`,
                      createdAt: new Date().toISOString(),
                    });
                    refresh();
                    if (out.delivered) toast.success(out.provider === 'evolution' ? 'Sent from your WhatsApp' : 'Message sent via WhatsApp Business API');
                    else if (out.link) window.open(out.link, '_blank', 'noopener');
                    if (out.error) toast(`WhatsApp API unavailable — opened a chat instead`);
                  }}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-green-50 text-green-700 rounded-xl text-sm font-medium hover:bg-green-100 transition-colors"
                >
                  <MessageCircle className="h-4 w-4" /> WhatsApp
                </button>
                <button
                  onClick={() => {
                    if (!selectedLead.email) { toast.error('This lead has no email address on file'); return; }
                    audit('email_log', selectedLead.id, `Drafted email to ${selectedLead.name}`);
                    create<Activity>('activities', {
                      id: '', tenantId, leadId: selectedLead.id, userId, type: 'email',
                      description: `Email drafted to ${selectedLead.name} (${selectedLead.email})`,
                      createdAt: new Date().toISOString(),
                    });
                    refresh();
                    // Open the default mail client with a prefilled draft
                    const subject = `${selectedLead.project} — your enquiry with ${tenant?.name || 'us'}`;
                    const body = `Hi ${selectedLead.name.split(' ')[0]},\n\nThank you for your interest in ${selectedLead.project}. I'd love to help you take the next step — would you be available for a quick call or site visit this week?\n\nBest regards,\n${user?.name || ''}\n${tenant?.name || ''}`;
                    window.location.href = mailtoHref(selectedLead.email, subject, body);
                  }}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-blue-50 text-blue-700 rounded-xl text-sm font-medium hover:bg-blue-100 transition-colors"
                >
                  <Mail className="h-4 w-4" /> Email
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2 mt-2">
                <button
                  onClick={() => {
                    // Open the date/time picker prefilled with tomorrow 11:00.
                    const t = new Date(Date.now() + 86400000);
                    const date = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
                    setVisitModal({ date, time: '11:00' });
                  }}
                  className="flex items-center justify-center gap-1.5 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-xl text-xs font-semibold transition-all border border-indigo-100/50"
                >
                  <Calendar className="h-3.5 w-3.5" /> Schedule Visit
                </button>

                <button
                  onClick={() => {
                    const draft = `Hi ${selectedLead.name.split(' ')[0]}, this is ${user?.name || 'your advisor'} from ${tenant?.name || 'Friendly ERP'}. We loved hosting our buyers at ${selectedLead.project} recently! We've got a hot new matching ${selectedLead.configuration} unit within your ${formatCurrency(selectedLead.budget, currency)} budget limit. Would Saturday at 11am work for a call?`;
                    
                    // Add Note & Activity
                    create<Note>('notes', {
                      id: '', tenantId, leadId: selectedLead.id, userId,
                      content: `✨ AI Brand-Voice Draft generated: "${draft}"`,
                      createdAt: new Date().toISOString(),
                    });
                    create<Activity>('activities', {
                      id: '', tenantId, leadId: selectedLead.id, userId, type: 'note',
                      description: `AI brand-voice follow-up suggested and logged`,
                      createdAt: new Date().toISOString(),
                    });
                    toast.success('AI brand-voice follow-up suggested & saved as Note!');
                    refresh();
                  }}
                  className="flex items-center justify-center gap-1.5 py-2 bg-amber-50 hover:bg-amber-100 text-amber-700 rounded-xl text-xs font-semibold transition-all border border-amber-100/50"
                >
                  <Sparkles className="h-3.5 w-3.5" /> ✨ AI Follow-up
                </button>
              </div>

              <button
                onClick={() => {
                  if (!navigator.geolocation) { toast.error('Location is not available on this device'); return; }
                  // Capture the target at click time — GPS resolves async and
                  // the user may have opened a different lead by then
                  const targetId = selectedLead.id;
                  const targetName = selectedLead.name;
                  toast.loading('Getting your location…', { id: 'geo' });
                  navigator.geolocation.getCurrentPosition(
                    async pos => {
                      const { latitude, longitude, accuracy } = pos.coords;
                      const mapsLink = `https://maps.google.com/?q=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
                      create<Activity>('activities', {
                        id: '', tenantId, leadId: targetId, userId, type: 'visit',
                        description: `📍 Geo-verified site check-in with ${targetName} at ${latitude.toFixed(5)}, ${longitude.toFixed(5)} (±${Math.round(accuracy)}m) — ${mapsLink}`,
                        createdAt: new Date().toISOString(),
                      });
                      audit('site_checkin', targetId, `Geo-verified site visit check-in (${latitude.toFixed(5)}, ${longitude.toFixed(5)})`);
                      const now = new Date().toISOString();
                      await patchLead(targetId, { lastContact: now }).catch(() => {});
                      setSelectedLead(prev => prev && prev.id === targetId ? { ...prev, lastContact: now } : prev);
                      refresh();
                      toast.success('Site visit check-in verified with your GPS location ✓', { id: 'geo' });
                    },
                    err => {
                      toast.error(err.code === err.PERMISSION_DENIED
                        ? 'Location permission denied — allow it to verify check-ins'
                        : 'Could not get your location — try again outdoors', { id: 'geo' });
                    },
                    { enableHighAccuracy: true, timeout: 10000 }
                  );
                }}
                className="w-full flex items-center justify-center gap-2 py-2 bg-teal-50 hover:bg-teal-100 text-teal-700 rounded-xl text-xs font-semibold transition-all border border-teal-100/50"
              >
                <MapPin className="h-3.5 w-3.5" /> Geo-Verified Site Check-in
              </button>

              {selectedLead.stage !== 'booked' && (
                <button
                  onClick={() => {
                    // Store lead ID for pre-selection in Bookings page
                    localStorage.setItem('friendly_crm_initiate_booking_lead', selectedLead.id);
                    toast.success(`Redirecting to Bookings with ${selectedLead.name} pre-selected...`);
                    // Use proper router navigation
                    navigate('/bookings');
                  }}
                  className="w-full flex items-center justify-center gap-2 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:from-emerald-700 hover:to-teal-700 rounded-xl text-xs font-bold transition-all shadow-sm"
                >
                  <BookOpenCheck className="h-3.5 w-3.5" /> Confirm Unit Booking
                </button>
              )}

              {(hasPermission('manage_leads') || hasPermission('manage_own_leads')) && (
                <button
                  onClick={async () => {
                    if (!selectedLead.email) { toast.error('Add an email address to this lead first'); return; }
                    if (!user || !tenant) return;
                    let creds;
                    try {
                      creds = await inviteCustomer(tenantId, selectedLead, { id: user.id, name: user.name });
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : 'Could not grant portal access');
                      return;
                    }
                    const shareText = `Your ${tenant.name} portal access:\n${window.location.origin}${portalPath(tenant)}\nEmail: ${creds.email}\nPassword: ${creds.password}`;
                    navigator.clipboard?.writeText(shareText).catch(() => {});
                    toast.success(
                      `Portal access ${creds.isNew ? 'created' : 'reset'} for ${selectedLead.name}\nEmail: ${creds.email}\nPassword: ${creds.password}\n(copied to clipboard — share via WhatsApp/email)`,
                      { duration: 10000 }
                    );
                    refresh();
                  }}
                  className="w-full flex items-center justify-center gap-2 py-2 bg-zinc-900 text-white hover:bg-zinc-800 rounded-xl text-xs font-bold transition-all shadow-sm"
                >
                  🔑 Customer Portal Access
                </button>
              )}
            </div>

            {/* Notes */}
            <div>
              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Notes ({leadNotes.length})</h4>
              {leadNotes.map(note => (
                <div key={note.id} className="bg-zinc-50 rounded-xl p-3 mb-2">
                  <p className="text-sm text-zinc-700">{note.content}</p>
                  <p className="text-[11px] text-zinc-400 mt-1.5 flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {new Date(note.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    · {getUserName(note.userId)}
                  </p>
                </div>
              ))}
              <div className="flex gap-2 mt-1">
                <input
                  value={noteInput}
                  onChange={e => setNoteInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddNote()}
                  placeholder="Add a note..."
                  className="flex-1 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
                <button onClick={handleAddNote} className="px-3 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 transition-colors">Add</button>
              </div>
            </div>

            {/* Activity Timeline */}
            <div>
              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Activity Timeline</h4>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {leadActivities.map(act => (
                  <div key={act.id} className="flex items-start gap-3 py-2 border-b border-zinc-50 last:border-0">
                    <div className="h-7 w-7 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0 mt-0.5">
                      {act.type === 'call' ? <Phone className="h-3.5 w-3.5 text-zinc-500" /> :
                       act.type === 'whatsapp' ? <MessageCircle className="h-3.5 w-3.5 text-zinc-500" /> :
                       act.type === 'email' ? <Mail className="h-3.5 w-3.5 text-zinc-500" /> :
                       act.type === 'visit' ? <MapPin className="h-3.5 w-3.5 text-zinc-500" /> :
                       <Clock className="h-3.5 w-3.5 text-zinc-500" />}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm text-zinc-700">{act.description}</p>
                      <p className="text-[11px] text-zinc-400 mt-0.5">{new Date(act.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
                    </div>
                  </div>
                ))}
                {leadActivities.length === 0 && <p className="text-xs text-zinc-400 text-center py-4">No activity recorded yet</p>}
              </div>
            </div>
          </div>
        </div>
      </>
      )}

      {/* Schedule Site Visit — pick a specific date & time */}
      {visitModal && selectedLead && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4" onClick={() => setVisitModal(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-zinc-900 flex items-center gap-2 mb-1">
              <Calendar className="h-4 w-4 text-indigo-600" /> Schedule Site Visit
            </h3>
            <p className="text-xs text-zinc-500 mb-4">{selectedLead.name} · {selectedLead.project}</p>
            <form
              onSubmit={e => {
                e.preventDefault();
                const when = new Date(`${visitModal.date}T${visitModal.time}`);
                if (Number.isNaN(when.getTime())) { toast.error('Please pick a valid date and time'); return; }
                if (when.getTime() < Date.now()) { toast.error('Pick a future date and time'); return; }

                create<Task>('tasks', {
                  id: '', tenantId, userId,
                  title: `Site Visit - ${selectedLead.name}`,
                  description: `Guided tour of ${selectedLead.project} with ${selectedLead.name}`,
                  dueDate: when.toISOString(),
                  priority: 'hot', status: 'pending', category: 'visit',
                });
                handleStageChange(selectedLead.id, 'visit_scheduled');
                const label = when.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
                create<Activity>('activities', {
                  id: '', tenantId, leadId: selectedLead.id, userId, type: 'visit',
                  description: `Site visit scheduled for ${label}`,
                  createdAt: new Date().toISOString(),
                });
                audit('schedule_visit', selectedLead.id, `Scheduled site visit for ${selectedLead.name} on ${label}`);
                toast.success(`Site visit scheduled for ${label}`);
                setVisitModal(null);
              }}
            >
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div>
                  <label className="block text-xs font-medium text-zinc-500 mb-1">Date</label>
                  <input
                    type="date" required value={visitModal.date}
                    min={new Date().toISOString().split('T')[0]}
                    onChange={e => setVisitModal(v => v && { ...v, date: e.target.value })}
                    className="w-full px-3 py-2 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-500 mb-1">Time</label>
                  <input
                    type="time" required value={visitModal.time}
                    onChange={e => setVisitModal(v => v && { ...v, time: e.target.value })}
                    className="w-full px-3 py-2 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setVisitModal(null)} className="flex-1 py-2.5 rounded-xl text-sm font-medium text-zinc-600 bg-zinc-100 hover:bg-zinc-200 transition-colors">Cancel</button>
                <button type="submit" className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors">Schedule Visit</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Lead Modal */}
      {/* Post-call logging modal — duration + status land in the lead history */}
      {callLogModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-fade-in">
            <h3 className="text-lg font-semibold text-zinc-900 flex items-center gap-2 mb-1">
              <Phone className="h-4 w-4 text-emerald-600" /> Log Call — {callLogModal.leadName}
            </h3>
            <p className="text-xs text-zinc-500 mb-4">
              {callLogModal.mode === 'API_CLOUD' ? '☁️ Cloud call (recording attached automatically in production)' : '📱 SIM call from your device'}
            </p>
            <form
              onSubmit={async e => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const status = fd.get('status') as CallStatus;
                const duration = Number(fd.get('duration')) || 0;
                const note = (fd.get('note') as string || '').trim();
                const statusLabel = CALL_STATUSES.find(s => s.id === status)?.label || status;
                const now = new Date().toISOString();
                create<Activity>('activities', {
                  id: '', tenantId, leadId: callLogModal.leadId, userId, type: 'call',
                  description: `Call via ${callLogModal.mode === 'API_CLOUD' ? 'Cloud (Exotel)' : 'SIM'} — ${statusLabel}${duration ? `, ${duration} min` : ''}${note ? ` — "${note}"` : ''}`,
                  createdAt: now,
                });
                audit('call_log', callLogModal.leadId, `Logged ${callLogModal.mode === 'API_CLOUD' ? 'cloud' : 'SIM'} call: ${statusLabel}, ${duration} min`);
                await patchLead(callLogModal.leadId, { lastContact: now }).catch(() => {});
                setSelectedLead(prev => prev && prev.id === callLogModal.leadId ? { ...prev, lastContact: now } : prev);
                setCallLogModal(null);
                refresh();
                toast.success('Call logged to lead history');
              }}
              className="space-y-3"
            >
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Call Status *</label>
                <select name="status" required className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                  {CALL_STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Duration (minutes)</label>
                <input name="duration" type="number" min="0" step="0.5" placeholder="e.g. 4" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Notes</label>
                <textarea name="note" rows={2} placeholder="Key points discussed…" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 resize-none" />
              </div>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setCallLogModal(null)} className="flex-1 px-4 py-2.5 border border-zinc-200 text-zinc-700 rounded-xl text-sm font-medium hover:bg-zinc-50">
                  Discard
                </button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700">
                  Save Log
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Bulk Import Modal */}
      {showImport && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowImport(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-semibold text-zinc-900 flex items-center gap-2">
                <Upload className="h-5 w-5 text-indigo-500" /> Bulk Import Leads
              </h3>
              <button onClick={() => setShowImport(false)} className="p-1 rounded hover:bg-zinc-100 text-zinc-400">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-zinc-500 mb-4">
              Upload a CSV with columns <span className="font-mono bg-zinc-100 px-1 rounded">Name, Phone, Email, Project, Budget, Configuration, Source</span>.
              Name and Phone are required. Duplicates (matching phone/email) are skipped automatically.
            </p>

            {!importPreview ? (
              <div className="space-y-3">
                <label className="block border-2 border-dashed border-zinc-300 rounded-xl p-8 text-center cursor-pointer hover:border-indigo-400 hover:bg-indigo-50/30 transition-colors">
                  <Upload className="h-8 w-8 text-zinc-300 mx-auto mb-2" />
                  <p className="text-sm font-medium text-zinc-700">Click to choose a CSV file</p>
                  <p className="text-xs text-zinc-400 mt-1">.csv up to 5,000 rows</p>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) handleImportFile(file);
                      e.target.value = '';
                    }}
                  />
                </label>
                <button
                  onClick={downloadTemplate}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-zinc-200 text-zinc-700 rounded-xl text-sm font-medium hover:bg-zinc-50"
                >
                  <Download className="h-4 w-4" /> Download CSV Template
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-center">
                    <p className="text-xl font-bold text-emerald-700">{importPreview.valid.length}</p>
                    <p className="text-[11px] text-emerald-600 font-medium">Ready to import</p>
                  </div>
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-center">
                    <p className="text-xl font-bold text-amber-700">{importPreview.dupes}</p>
                    <p className="text-[11px] text-amber-600 font-medium">Duplicates skipped</p>
                  </div>
                  <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-center">
                    <p className="text-xl font-bold text-red-600">{importPreview.invalid}</p>
                    <p className="text-[11px] text-red-500 font-medium">Invalid rows</p>
                  </div>
                </div>
                {importPreview.valid.length > 0 && (
                  <div className="max-h-40 overflow-y-auto border border-zinc-100 rounded-xl divide-y divide-zinc-50">
                    {importPreview.valid.slice(0, 8).map((r, i) => (
                      <div key={i} className="px-3 py-2 flex items-center justify-between text-xs">
                        <span className="font-medium text-zinc-800">{r.name}</span>
                        <span className="text-zinc-500">{r.phone} · {r.project}</span>
                      </div>
                    ))}
                    {importPreview.valid.length > 8 && (
                      <div className="px-3 py-2 text-[11px] text-zinc-400 text-center">+ {importPreview.valid.length - 8} more…</div>
                    )}
                  </div>
                )}
                <div className="flex gap-3">
                  <button
                    onClick={() => setImportPreview(null)}
                    className="flex-1 px-4 py-2.5 border border-zinc-200 text-zinc-700 rounded-xl text-sm font-medium hover:bg-zinc-50"
                  >
                    Choose Another File
                  </button>
                  <button
                    onClick={handleConfirmImport}
                    disabled={importPreview.valid.length === 0}
                    className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Import {importPreview.valid.length} Lead{importPreview.valid.length === 1 ? '' : 's'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">Add New Lead</h3>
              <button onClick={() => setShowAddModal(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddLead} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Name *</label>
                  <input name="name" required placeholder="Full name" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Phone *</label>
                  <input name="phone" required placeholder="+91 99999..." className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Email</label>
                  <input name="email" type="email" placeholder="email@example.com" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Source</label>
                  <select name="source" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    {leadSources.map(src => <option key={src}>{src}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Project</label>
                  <select name="project" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    {tenantProjects.length === 0
                      ? <option>General Enquiry</option>
                      : tenantProjects.map(p => <option key={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Budget ({currencySymbol(currency).trim()})</label>
                  <input name="budget" type="number" placeholder="5000000" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Configuration</label>
                  <select name="configuration" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    {configOptions.map(cfg => <option key={cfg}>{cfg}</option>)}
                  </select>
                </div>
                {(hasPermission('assign_leads') || hasPermission('manage_leads')) && (
                  <div className="col-span-2">
                    <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Assign To</label>
                    <select name="assignedTo" defaultValue={userId} className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                      {allUsers.filter(u => u.role !== 'super_admin' && u.active).map(u => (
                        <option key={u.id} value={u.id}>{u.name} ({u.role.replace('_', ' ')})</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddModal(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm">Create Lead</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Duplicate Detection Modal */}
      {showDuplicates && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowDuplicates(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-y-auto p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900 flex items-center gap-2">
                  <GitMerge className="h-5 w-5 text-amber-500" /> Duplicate Leads
                </h3>
                <p className="text-sm text-zinc-500 mt-0.5">{duplicateGroups.length} group(s) sharing a phone or email. Merge to keep one clean record.</p>
              </div>
              <button onClick={() => setShowDuplicates(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <div className="space-y-4">
              {duplicateGroups.map((group, gi) => (
                <div key={gi} className="border border-zinc-200 rounded-xl p-4">
                  <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                    Match: {normalizePhone(group[0].phone) || group[0].email}
                  </p>
                  <div className="space-y-2">
                    {group.map((lead, li) => (
                      <div key={lead.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-zinc-50">
                        <div className="h-8 w-8 rounded-lg bg-white border border-zinc-200 flex items-center justify-center shrink-0">
                          <span className="text-xs font-bold text-zinc-600">{lead.name.split(' ').map(n => n[0]).join('')}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-zinc-900">{lead.name} {li === 0 && <span className="text-[10px] text-indigo-500 font-normal bg-indigo-50 px-1.5 py-0.5 rounded">Primary</span>}</p>
                          <p className="text-[11px] text-zinc-500">{lead.phone} · {lead.stage} · {formatCurrency(lead.budget, currency)} · {getUserName(lead.assignedTo)}</p>
                        </div>
                        {li > 0 && (
                          <button
                            onClick={() => handleMerge(group[0], lead)}
                            className="flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold hover:bg-indigo-700 transition-colors shrink-0"
                          >
                            <GitMerge className="h-3.5 w-3.5" /> Merge into Primary
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {duplicateGroups.length === 0 && (
                <p className="text-sm text-zinc-400 text-center py-8">No duplicates found 🎉</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Lost-reason prompt — a lead can only be marked lost WITH a reason */}
      {lostPromptLeadId && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setLostPromptLeadId(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-semibold text-zinc-900">Why was this lead lost?</h3>
              <button onClick={() => setLostPromptLeadId(null)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <p className="text-xs text-zinc-500 mb-4">The reason feeds your loss analysis — it's required to close a lead.</p>
            <div className="space-y-1.5">
              {LOST_REASONS.map(reason => (
                <button
                  key={reason}
                  onClick={() => {
                    const id = lostPromptLeadId;
                    setLostPromptLeadId(null);
                    handleStageChange(id, 'lost', reason);
                  }}
                  className="w-full text-left px-4 py-2.5 rounded-xl border border-zinc-200 text-sm text-zinc-700 hover:border-red-300 hover:bg-red-50/50 transition-colors"
                >
                  {reason}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* WhatsApp chat thread — opens when the rep has a linked session */}
      {chatLead && (
        <LeadWhatsAppChat lead={chatLead} tenantId={tenantId} onClose={() => setChatLead(null)} />
      )}
    </div>
  );
}
