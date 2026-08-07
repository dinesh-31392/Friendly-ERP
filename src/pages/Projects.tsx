import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2, Plus, Search, MapPin, Users, TrendingUp,
  Trash2, Eye, X, CheckCircle2, Clock, AlertCircle,
  Download, BarChart3, IndianRupee, HardHat, Flag,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getEffectiveLimits, withinLimit, isModuleEnabled } from '../services/planService';
import { projectProgress, projectHealth, nextMilestone, HEALTH_META } from '../services/executionService';
import { getByTenant, logAudit } from '../services/db';
import { isApiEnabled, apiGetProjects } from '../services/apiClient';
import { createProject, patchProject, deleteProject } from '../services/projectWrites';
import { formatCurrency, currencySymbol } from '../utils/format';
import type { Project, Lead, Unit, ProjectStatus, Tower } from '../types';
import { PROJECT_STATUSES } from '../types';
import toast from 'react-hot-toast';

export default function Projects() {
  const { user, tenant, hasPermission } = useAuth();
  const navigate = useNavigate();
  const tenantId = tenant?.id || '';
  const currency = tenant?.currency || 'INR';
  const canManage = hasPermission('manage_projects');
  const execOn = hasPermission('view_execution') && isModuleEnabled(tenant, 'execution');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | 'all'>('all');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  // Feature flag: with an API URL configured, projects are read from the
  // Fastify backend (RLS-scoped). Falls back to localStorage on any API failure
  // so the page never goes blank. Flag off → identical behavior to before.
  const [apiProjects, setApiProjects] = useState<Project[] | null>(null);
  useEffect(() => {
    if (!isApiEnabled()) { setApiProjects(null); return; }
    let cancelled = false;
    apiGetProjects()
      .then(rows => { if (!cancelled) setApiProjects(rows); })
      .catch(() => {
        if (!cancelled) {
          setApiProjects(null);
          toast.error('API unreachable — showing local data', { id: 'api-fallback' });
        }
      });
    return () => { cancelled = true; };
  }, [tenantId, refreshKey]);

  const projects = useMemo(() => {
    const source = apiProjects ?? getByTenant<Project>('projects', tenantId);
    return [...source].sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [apiProjects, tenantId, refreshKey]);

  const allLeads = useMemo(() => getByTenant<Lead>('leads', tenantId), [tenantId, refreshKey]);
  const allUnits = useMemo(() => getByTenant<Unit>('units', tenantId), [tenantId, refreshKey]);
  const allTowers = useMemo(() => getByTenant<Tower>('towers', tenantId), [tenantId, refreshKey]);

  const filteredProjects = useMemo(() => {
    return projects.filter(p => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (search && !p.name.toLowerCase().includes(search.toLowerCase()) && !p.location.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [projects, search, statusFilter]);

  // Calculate project stats — leads may reference a project by id or by name
  // (seeded/manual leads only carry the project name string)
  const getProjectStats = (project: Project) => {
    const projectLeads = allLeads.filter(l => l.projectId === project.id || l.project === project.name);
    const projectTowers = allTowers.filter(t => t.projectId === project.id);
    const projectUnits = allUnits.filter(u => projectTowers.some(t => t.id === u.towerId));
    const bookedLeads = projectLeads.filter(l => l.stage === 'booked');
    const availableUnits = projectUnits.filter(u => u.status === 'available');
    const totalRevenue = bookedLeads.reduce((s, l) => s + l.budget, 0);

    return {
      leads: projectLeads.length,
      booked: bookedLeads.length,
      conversionRate: projectLeads.length > 0 ? ((bookedLeads.length / projectLeads.length) * 100).toFixed(1) : '0.0',
      towers: projectTowers.length,
      units: projectUnits.length,
      available: availableUnits.length,
      revenue: totalRevenue,
    };
  };

  const handleAddProject = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = fd.get('name') as string;
    const location = fd.get('location') as string;
    if (!name || !location) { toast.error('Name and location are required'); return; }

    // Enforce the effective project limit (plan, or super-admin override)
    const limits = getEffectiveLimits(tenant);
    if (!withinLimit(projects.length, limits.projects)) {
      toast.error(`Your workspace allows up to ${limits.projects} projects. Upgrade in Settings → Billing & Plan (or contact support) to add more.`);
      return;
    }

    const totalUnits = Number(fd.get('totalUnits')) || 0;
    try {
      const created = await createProject({
        tenantId, name, location,
        type: (fd.get('type') as string) || 'Residential',
        status: (fd.get('status') as ProjectStatus) || 'pre_launch',
        reraNumber: (fd.get('reraNumber') as string) || '',
        totalUnits,
        // Demo store keeps a static count; in API mode availableUnits is computed
        // server-side from live unit inventory and this value is ignored.
        availableUnits: totalUnits,
        priceRange: [Number(fd.get('minPrice')) || 0, Number(fd.get('maxPrice')) || 0],
        launchDate: (fd.get('launchDate') as string) || '',
        completionDate: (fd.get('completionDate') as string) || '',
        description: (fd.get('description') as string) || '',
        createdAt: new Date().toISOString(),
      });
      if (user) logAudit({ tenantId, userId: user.id, userName: user.name, action: 'create', entity: 'project', entityId: created.id, details: `Created project "${name}"` });
      setShowAddModal(false);
      refresh();
      toast.success('Project created successfully');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create project');
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    if (!confirm('Are you sure? This will delete the project along with its towers and units. Leads will be kept.')) return;
    try {
      // API mode cascades server-side via FKs; demo mode cascades in the helper.
      await deleteProject(projectId, tenantId);
      if (user) logAudit({ tenantId, userId: user.id, userName: user.name, action: 'delete', entity: 'project', entityId: projectId, details: 'Deleted project' });
      if (selectedProject?.id === projectId) setSelectedProject(null);
      refresh();
      toast.success('Project deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete project');
    }
  };

  const statusColors: Record<ProjectStatus, string> = {
    'pre_launch': 'bg-purple-100 text-purple-700 border-purple-200',
    'under_construction': 'bg-amber-100 text-amber-700 border-amber-200',
    'ready_to_move': 'bg-emerald-100 text-emerald-700 border-emerald-200',
    'completed': 'bg-blue-100 text-blue-700 border-blue-200',
  };

  const statusIcons: Record<ProjectStatus, any> = {
    'pre_launch': Clock,
    'under_construction': AlertCircle,
    'ready_to_move': CheckCircle2,
    'completed': CheckCircle2,
  };

  // Aggregate stats
  const totalProjects = projects.length;
  const activeProjects = projects.filter(p => p.status !== 'completed').length;
  const totalLeads = allLeads.length;
  const totalRevenue = allLeads.filter(l => l.stage === 'booked').reduce((s, l) => s + l.budget, 0);

  return (
    <div className="space-y-6 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Projects</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Manage your real estate projects, track progress, and monitor performance.</p>
        </div>
        {canManage && (
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm"
          >
            <Plus className="h-4 w-4" /> Add Project
          </button>
        )}
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gradient-to-br from-indigo-500 to-violet-600 rounded-2xl p-4 text-white">
          <div className="flex items-center gap-2 mb-2">
            <Building2 className="h-5 w-5 text-indigo-200" />
            <span className="text-xs font-medium text-indigo-200">Total Projects</span>
          </div>
          <p className="text-3xl font-bold">{totalProjects}</p>
          <p className="text-xs text-indigo-200 mt-1">{activeProjects} active</p>
        </div>
        <div className="bg-gradient-to-br from-emerald-500 to-teal-600 rounded-2xl p-4 text-white">
          <div className="flex items-center gap-2 mb-2">
            <Users className="h-5 w-5 text-emerald-200" />
            <span className="text-xs font-medium text-emerald-200">Total Leads</span>
          </div>
          <p className="text-3xl font-bold">{totalLeads}</p>
          <p className="text-xs text-emerald-200 mt-1">Across all projects</p>
        </div>
        <div className="bg-gradient-to-br from-amber-500 to-orange-600 rounded-2xl p-4 text-white">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="h-5 w-5 text-amber-200" />
            <span className="text-xs font-medium text-amber-200">Conversion Rate</span>
          </div>
          <p className="text-3xl font-bold">{totalLeads > 0 ? ((allLeads.filter(l => l.stage === 'booked').length / totalLeads) * 100).toFixed(1) : '0.0'}%</p>
          <p className="text-xs text-amber-200 mt-1">Lead to booking</p>
        </div>
        <div className="bg-gradient-to-br from-violet-500 to-purple-600 rounded-2xl p-4 text-white">
          <div className="flex items-center gap-2 mb-2">
            <IndianRupee className="h-5 w-5 text-violet-200" />
            <span className="text-xs font-medium text-violet-200">Total Revenue</span>
          </div>
          <p className="text-3xl font-bold">{formatCurrency(totalRevenue, currency)}</p>
          <p className="text-xs text-violet-200 mt-1">Booked value</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search projects by name or location..."
            className="w-full pl-9 pr-4 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
          />
        </div>
        <div className="flex items-center gap-2 bg-white border border-zinc-200 rounded-xl p-1 flex-wrap">
          <button
            onClick={() => setStatusFilter('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${statusFilter === 'all' ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
          >All</button>
          {PROJECT_STATUSES.map(s => (
            <button
              key={s.id}
              onClick={() => setStatusFilter(s.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${statusFilter === s.id ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
            >{s.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-1 bg-white border border-zinc-200 rounded-xl p-1">
          <button
            onClick={() => setViewMode('grid')}
            className={`p-1.5 rounded-lg transition-all ${viewMode === 'grid' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:text-zinc-600'}`}
          >
            <BarChart3 className="h-4 w-4" />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`p-1.5 rounded-lg transition-all ${viewMode === 'list' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:text-zinc-600'}`}
          >
            <Download className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Projects Grid/List */}
      {filteredProjects.length === 0 ? (
        <div className="bg-white rounded-2xl border border-zinc-200/60 py-16 text-center">
          <Building2 className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
          <p className="text-sm text-zinc-500">No projects found. Create your first project to get started.</p>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredProjects.map(project => {
            const stats = getProjectStats(project);
            const StatusIcon = statusIcons[project.status];
            return (
              <div key={project.id} className="bg-white rounded-2xl border border-zinc-200/60 p-5 hover:shadow-lg transition-all">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shrink-0">
                      <Building2 className="h-6 w-6 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-bold text-zinc-900 truncate">{project.name}</h3>
                      <p className="text-xs text-zinc-500 flex items-center gap-1 mt-0.5">
                        <MapPin className="h-3 w-3" /> {project.location}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full border ${statusColors[project.status]}`}>
                      <StatusIcon className="h-3 w-3" />
                      {PROJECT_STATUSES.find(s => s.id === project.status)?.label}
                    </span>
                    {canManage && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteProject(project.id); }}
                        className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="space-y-2 mb-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-500">Type</span>
                    <span className="font-semibold text-zinc-900">{project.type}</span>
                  </div>
                  {project.reraNumber && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-500">RERA</span>
                      <span className="font-semibold text-emerald-600">✓ {project.reraNumber}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-500">Price Range</span>
                    <span className="font-semibold text-zinc-900">{formatCurrency(project.priceRange[0], currency)} - {formatCurrency(project.priceRange[1], currency)}</span>
                  </div>
                </div>

                {/* Construction pulse — derived from Site Execution when in use */}
                {execOn && (() => {
                  const prog = projectProgress(tenantId, project.id);
                  if (prog === null) return null;
                  const health = projectHealth(tenantId, project.id);
                  const ms = nextMilestone(tenantId, project.id);
                  return (
                    <div className="mb-3 pt-2 border-t border-zinc-100">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] font-semibold text-zinc-500 uppercase flex items-center gap-1"><HardHat className="h-3 w-3" /> Build Progress</span>
                        <span className="flex items-center gap-1.5">
                          <span className={`inline-flex items-center gap-1 text-[9px] font-semibold px-1.5 py-0.5 rounded-full border ${HEALTH_META[health].badge}`}>
                            <span className={`h-1 w-1 rounded-full ${HEALTH_META[health].dot}`} />{HEALTH_META[health].label}
                          </span>
                          <span className="text-xs font-bold text-zinc-800">{prog}%</span>
                        </span>
                      </div>
                      <div className="h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 rounded-full" style={{ width: `${prog}%` }} />
                      </div>
                      {ms && (
                        <p className="text-[10px] text-zinc-500 mt-1 flex items-center gap-1 truncate">
                          <Flag className="h-2.5 w-2.5 text-zinc-400 shrink-0" /> Next: {ms.title} · {new Date(ms.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                        </p>
                      )}
                    </div>
                  );
                })()}

                <div className="grid grid-cols-3 gap-2 py-3 border-t border-zinc-100">
                  <div className="text-center">
                    <p className="text-lg font-bold text-zinc-900">{stats.leads}</p>
                    <p className="text-[10px] text-zinc-500">Leads</p>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-bold text-zinc-900">{stats.booked}</p>
                    <p className="text-[10px] text-zinc-500">Booked</p>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-bold text-zinc-900">{stats.conversionRate}%</p>
                    <p className="text-[10px] text-zinc-500">Conversion</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-3 border-t border-zinc-100">
                  <div className="text-center">
                    <p className="text-xs font-semibold text-zinc-900">{stats.towers} Towers</p>
                    <p className="text-[10px] text-zinc-500">{stats.units} units</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs font-semibold text-emerald-600">{stats.available} Available</p>
                    <p className="text-[10px] text-zinc-500">Ready to sell</p>
                  </div>
                </div>

                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => setSelectedProject(project)}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-indigo-50 text-indigo-700 rounded-lg text-xs font-semibold hover:bg-indigo-100 transition-colors"
                  >
                    <Eye className="h-3.5 w-3.5" /> View Details
                  </button>
                  <button
                    onClick={() => navigate(`/leads?project=${project.id}`)}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-zinc-50 text-zinc-700 rounded-lg text-xs font-semibold hover:bg-zinc-100 transition-colors"
                  >
                    <Users className="h-3.5 w-3.5" /> View Leads
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-zinc-50/50 border-b border-zinc-100">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-zinc-500 uppercase">Project</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-zinc-500 uppercase">Location</th>
                  <th className="text-center px-5 py-3 text-xs font-semibold text-zinc-500 uppercase">Status</th>
                  <th className="text-center px-5 py-3 text-xs font-semibold text-zinc-500 uppercase">Leads</th>
                  <th className="text-center px-5 py-3 text-xs font-semibold text-zinc-500 uppercase">Booked</th>
                  <th className="text-center px-5 py-3 text-xs font-semibold text-zinc-500 uppercase">Conversion</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-zinc-500 uppercase">Revenue</th>
                  <th className="text-center px-5 py-3 text-xs font-semibold text-zinc-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredProjects.map(project => {
                  const stats = getProjectStats(project);
                  const StatusIcon = statusIcons[project.status];
                  return (
                    <tr key={project.id} className="border-b border-zinc-50 hover:bg-zinc-50/50 transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
                            <Building2 className="h-5 w-5 text-white" />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-zinc-900">{project.name}</p>
                            <p className="text-xs text-zinc-500">{project.type}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-zinc-700">{project.location}</td>
                      <td className="px-5 py-3.5 text-center">
                        <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full border ${statusColors[project.status]}`}>
                          <StatusIcon className="h-3 w-3" />
                          {PROJECT_STATUSES.find(s => s.id === project.status)?.label}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-center text-sm font-semibold text-zinc-900">{stats.leads}</td>
                      <td className="px-5 py-3.5 text-center text-sm font-semibold text-zinc-900">{stats.booked}</td>
                      <td className="px-5 py-3.5 text-center text-sm font-semibold text-zinc-900">{stats.conversionRate}%</td>
                      <td className="px-5 py-3.5 text-right text-sm font-semibold text-zinc-900">{formatCurrency(stats.revenue, currency)}</td>
                      <td className="px-5 py-3.5 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => setSelectedProject(project)}
                            className="p-1.5 rounded-lg hover:bg-indigo-50 text-zinc-400 hover:text-indigo-600 transition-colors"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          {canManage && (
                            <button
                              onClick={() => handleDeleteProject(project.id)}
                              className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 transition-colors"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Project Details Modal */}
      {selectedProject && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setSelectedProject(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="h-14 w-14 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
                  <Building2 className="h-7 w-7 text-white" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-zinc-900">{selectedProject.name}</h3>
                  <p className="text-xs text-zinc-500 flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> {selectedProject.location}
                  </p>
                </div>
              </div>
              <button onClick={() => setSelectedProject(null)} className="p-1.5 rounded-lg hover:bg-zinc-100">
                <X className="h-4 w-4 text-zinc-500" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="bg-zinc-50 rounded-xl p-3">
                <p className="text-xs text-zinc-500 mb-1">Project Type</p>
                <p className="text-sm font-semibold text-zinc-900">{selectedProject.type}</p>
              </div>
              <div className="bg-zinc-50 rounded-xl p-3">
                <p className="text-xs text-zinc-500 mb-1">Status</p>
                <p className="text-sm font-semibold text-zinc-900">{PROJECT_STATUSES.find(s => s.id === selectedProject.status)?.label}</p>
              </div>
              {selectedProject.reraNumber && (
                <div className="bg-emerald-50 rounded-xl p-3">
                  <p className="text-xs text-emerald-600 mb-1">RERA Number</p>
                  <p className="text-sm font-semibold text-emerald-700">✓ {selectedProject.reraNumber}</p>
                </div>
              )}
              <div className="bg-zinc-50 rounded-xl p-3">
                <p className="text-xs text-zinc-500 mb-1">Price Range</p>
                <p className="text-sm font-semibold text-zinc-900">{formatCurrency(selectedProject.priceRange[0], currency)} - {formatCurrency(selectedProject.priceRange[1], currency)}</p>
              </div>
              {selectedProject.launchDate && (
                <div className="bg-zinc-50 rounded-xl p-3">
                  <p className="text-xs text-zinc-500 mb-1">Launch Date</p>
                  <p className="text-sm font-semibold text-zinc-900">{new Date(selectedProject.launchDate).toLocaleDateString('en-IN')}</p>
                </div>
              )}
              {selectedProject.completionDate && (
                <div className="bg-zinc-50 rounded-xl p-3">
                  <p className="text-xs text-zinc-500 mb-1">Completion Date</p>
                  <p className="text-sm font-semibold text-zinc-900">{new Date(selectedProject.completionDate).toLocaleDateString('en-IN')}</p>
                </div>
              )}
            </div>

            {selectedProject.description && (
              <div className="bg-zinc-50 rounded-xl p-4 mb-4">
                <p className="text-xs text-zinc-500 mb-1">Description</p>
                <p className="text-sm text-zinc-700">{selectedProject.description}</p>
              </div>
            )}

            {/* Microsite — public lead-capture landing page */}
            {canManage && (() => {
              const url = `${window.location.origin}/site/${tenant?.slug}/${selectedProject.id}`;
              const published = !!selectedProject.micrositePublished;
              return (
                <div className="border border-zinc-200 rounded-xl p-4 mb-4">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <p className="text-sm font-semibold text-zinc-900 flex items-center gap-1.5">🌐 Project Microsite</p>
                      <p className="text-xs text-zinc-500 mt-0.5">A public landing page that captures enquiries straight into your pipeline.</p>
                    </div>
                    <button
                      onClick={async () => {
                        try {
                          await patchProject(selectedProject.id, { micrositePublished: !published });
                          if (user) logAudit({ tenantId, userId: user.id, userName: user.name, action: 'update', entity: 'project', entityId: selectedProject.id, details: `${published ? 'Unpublished' : 'Published'} microsite for "${selectedProject.name}"` });
                          setSelectedProject({ ...selectedProject, micrositePublished: !published });
                          refresh();
                          toast.success(published ? 'Microsite unpublished' : 'Microsite is now live');
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : 'Could not update microsite');
                        }
                      }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${published ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}
                    >
                      {published ? '● Live' : 'Publish'}
                    </button>
                  </div>
                  {published && (
                    <div className="flex items-center gap-2 mt-3">
                      <code className="flex-1 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-[11px] text-indigo-600 truncate">{url}</code>
                      <button onClick={() => { navigator.clipboard?.writeText(url).then(() => toast.success('Microsite link copied')).catch(() => {}); }} className="px-3 py-2 bg-white border border-zinc-200 rounded-lg text-xs font-medium text-zinc-700 hover:bg-zinc-50">Copy</button>
                      <a href={url} target="_blank" rel="noopener noreferrer" className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-xs font-semibold hover:bg-indigo-700">Open</a>
                    </div>
                  )}
                </div>
              );
            })()}

            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="bg-indigo-50 rounded-xl p-3 text-center">
                <p className="text-2xl font-bold text-indigo-900">{getProjectStats(selectedProject).leads}</p>
                <p className="text-xs text-indigo-600">Total Leads</p>
              </div>
              <div className="bg-emerald-50 rounded-xl p-3 text-center">
                <p className="text-2xl font-bold text-emerald-900">{getProjectStats(selectedProject).booked}</p>
                <p className="text-xs text-emerald-600">Booked</p>
              </div>
              <div className="bg-amber-50 rounded-xl p-3 text-center">
                <p className="text-2xl font-bold text-amber-900">{getProjectStats(selectedProject).conversionRate}%</p>
                <p className="text-xs text-amber-600">Conversion</p>
              </div>
            </div>

            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => navigate(`/leads?project=${selectedProject.id}`)}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors"
              >
                <Users className="h-4 w-4" /> View All Leads
              </button>
              {execOn && (
                <button
                  onClick={() => navigate(`/execution?project=${selectedProject.id}`)}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-zinc-900 text-white rounded-xl text-sm font-semibold hover:bg-zinc-800 transition-colors"
                >
                  <HardHat className="h-4 w-4" /> Site Execution
                </button>
              )}
              <button
                onClick={() => navigate(`/inventory?project=${selectedProject.id}`)}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-zinc-100 text-zinc-700 rounded-xl text-sm font-semibold hover:bg-zinc-200 transition-colors"
              >
                <Building2 className="h-4 w-4" /> View Inventory
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Project Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Add New Project</h3>
              <button onClick={() => setShowAddModal(false)} className="p-1.5 rounded-lg hover:bg-zinc-100">
                <X className="h-4 w-4 text-zinc-500" />
              </button>
            </div>
            <form onSubmit={handleAddProject} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Project Name *</label>
                  <input name="name" required placeholder="Skyline Heights" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Location *</label>
                  <input name="location" required placeholder="Whitefield, Bangalore" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Type</label>
                  <select name="type" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    <option>Residential</option><option>Commercial</option><option>Villas</option><option>Plots</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Status</label>
                  <select name="status" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    {PROJECT_STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">RERA Number</label>
                  <input name="reraNumber" placeholder="RERA/BLR/2024/001" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Total Units</label>
                  <input name="totalUnits" type="number" placeholder="100" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Min Price ({currencySymbol(currency).trim()})</label>
                  <input name="minPrice" type="number" placeholder="5000000" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Max Price ({currencySymbol(currency).trim()})</label>
                  <input name="maxPrice" type="number" placeholder="20000000" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Launch Date</label>
                  <input name="launchDate" type="date" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Completion Date</label>
                  <input name="completionDate" type="date" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Description</label>
                  <textarea name="description" rows={3} placeholder="Project description..." className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 resize-none" />
                </div>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddModal(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Create Project</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
