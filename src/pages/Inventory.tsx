import { useState, useMemo, useEffect } from 'react';
import {
  Search, Building2, ChevronDown, MapPin, Grid3X3, List, Plus, X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, remove, logAudit } from '../services/db';
import { isApiEnabled, apiGetProjects, apiGetTowers, apiGetUnits } from '../services/apiClient';
import { createUnit, patchUnit } from '../services/inventoryWrites';
import { formatCurrency, formatCurrencyFull, currencySymbol } from '../utils/format';
import type { Project, Tower, Unit, UnitStatus, Lead, Booking } from '../types';
import { UNIT_STATUSES } from '../types';
import toast from 'react-hot-toast';

// Locking rules: which transitions are allowed from a given status.
// 'sold' is terminal (locked). Others follow a sensible workflow.
const allowedTransitions: Record<UnitStatus, UnitStatus[]> = {
  available: ['reserved', 'blocked', 'on_hold', 'booked'],
  reserved: ['available', 'booked', 'on_hold', 'blocked'],
  on_hold: ['available', 'reserved', 'blocked'],
  blocked: ['available'],
  booked: ['sold', 'available', 'reserved'],
  sold: [], // terminal — locked
};

const statusColors: Record<UnitStatus, string> = {
  available: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  reserved: 'bg-amber-100 text-amber-700 border-amber-300',
  blocked: 'bg-zinc-100 text-zinc-500 border-zinc-300',
  booked: 'bg-blue-100 text-blue-700 border-blue-300',
  sold: 'bg-violet-100 text-violet-700 border-violet-300',
  on_hold: 'bg-red-100 text-red-500 border-red-300',
};

const statusLabels: Record<UnitStatus, string> = {
  available: 'Available', reserved: 'Reserved', blocked: 'Blocked',
  booked: 'Booked', sold: 'Sold', on_hold: 'On Hold',
};

export default function Inventory() {
  const { user, tenant, hasPermission } = useAuth();
  const tenantId = tenant?.id || '';
  const currency = tenant?.currency || 'INR';
  const canManage = hasPermission('manage_inventory');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  // Feature flag: with an API URL configured, inventory is read from the
  // Fastify backend (RLS-scoped). Falls back to localStorage on any API failure
  // so the page never goes blank. Flag off → identical behavior to before.
  const [apiData, setApiData] = useState<{ projects: Project[]; towers: Tower[]; units: Unit[] } | null>(null);
  useEffect(() => {
    if (!isApiEnabled()) { setApiData(null); return; }
    let cancelled = false;
    Promise.all([apiGetProjects(), apiGetTowers(), apiGetUnits()])
      .then(([projects, towers, units]) => { if (!cancelled) setApiData({ projects, towers, units }); })
      .catch(() => {
        if (!cancelled) {
          setApiData(null);
          toast.error('API unreachable — showing local data', { id: 'api-fallback' });
        }
      });
    return () => { cancelled = true; };
  }, [tenantId, refreshKey]);

  const projects = useMemo(() => apiData?.projects ?? getByTenant<Project>('projects', tenantId), [apiData, tenantId, refreshKey]);
  const towers = useMemo(() => apiData?.towers ?? getByTenant<Tower>('towers', tenantId), [apiData, tenantId, refreshKey]);
  const allUnits = useMemo(() => apiData?.units ?? getByTenant<Unit>('units', tenantId), [apiData, tenantId, refreshKey]);

  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedTower, setSelectedTower] = useState<Tower | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<UnitStatus | 'all'>('all');
  const [configFilter, setConfigFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'matrix' | 'list'>('matrix');
  const [showAddUnit, setShowAddUnit] = useState(false);

  // Auto-select first project and tower
  const currentProject = selectedProject || projects[0] || null;
  const projectTowers = currentProject ? towers.filter(t => t.projectId === currentProject.id) : [];
  const currentTower = selectedTower && selectedTower.projectId === currentProject?.id
    ? selectedTower
    : projectTowers[0] || null;

  const currentUnits = currentTower
    ? allUnits.filter(u => u.towerId === currentTower.id)
    : [];

  // Performance: Create a lead lookup map for O(1) access instead of O(n) find()
  // This also handles orphaned bookedBy references (when a lead is deleted but unit still references it)
  const leadMap = useMemo(() => {
    const allLeads = getByTenant<Lead>('leads', tenantId);
    const map = new Map<string, Lead>();
    allLeads.forEach(l => map.set(l.id, l));
    return map;
  }, [tenantId, refreshKey]);

  const filteredUnits = useMemo(() => {
    return currentUnits.filter(u => {
      if (statusFilter !== 'all' && u.status !== statusFilter) return false;
      if (configFilter !== 'all' && u.configuration !== configFilter) return false;
      if (searchQuery && !u.number.includes(searchQuery) && !u.type.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
  }, [currentUnits, statusFilter, configFilter, searchQuery]);

  const floors = useMemo(() => {
    const floorSet = new Set(filteredUnits.map(u => u.floorNumber));
    return Array.from(floorSet).sort((a, b) => b - a);
  }, [filteredUnits]);

  // Group actual units per floor so the matrix shows every unit regardless
  // of its number format (manually added units don't follow `${floor}0${n}`)
  const unitsByFloor = useMemo(() => {
    const map = new Map<number, Unit[]>();
    filteredUnits.forEach(u => {
      if (!map.has(u.floorNumber)) map.set(u.floorNumber, []);
      map.get(u.floorNumber)!.push(u);
    });
    map.forEach(list => list.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true })));
    return map;
  }, [filteredUnits]);

  const matrixColumns = currentTower
    ? Math.max(currentTower.unitsPerFloor, ...Array.from(unitsByFloor.values()).map(l => l.length), 1)
    : 1;

  const unitConfigs = useMemo(() => [...new Set(currentUnits.map(u => u.configuration))], [currentUnits]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { total: currentUnits.length };
    currentUnits.forEach(u => { counts[u.status] = (counts[u.status] || 0) + 1; });
    return counts;
  }, [currentUnits]);

  const handleStatusChange = async (unitId: string, newStatus: UnitStatus) => {
    if (!canManage) {
      toast.error('You do not have permission to change unit status');
      return;
    }
    const unit = allUnits.find(u => u.id === unitId);
    if (!unit) return;
    if (unit.status === newStatus) return;

    // Locking: enforce allowed transitions to prevent conflicting reservations
    if (unit.status === 'sold') {
      toast.error('Sold units are locked and cannot be changed');
      return;
    }
    if (!allowedTransitions[unit.status].includes(newStatus)) {
      toast.error(`Cannot move ${statusLabels[unit.status]} → ${statusLabels[newStatus]}`);
      return;
    }

    const updates: Partial<Unit> = { status: newStatus };
    // Releasing a booked unit must clear its owner and cancel the booking,
    // otherwise the unit could be double-booked while an active Booking
    // record still points at it. (In demo mode bookings live in localStorage;
    // once the Bookings module is API-cut-over this cascade moves server-side.)
    if (unit.status === 'booked' && newStatus !== 'sold') {
      updates.bookedBy = undefined;
      getByTenant<Booking>('bookings', tenantId)
        .filter(b => b.unitId === unitId)
        .forEach(b => remove('bookings', b.id));
    }
    try {
      await patchUnit(unitId, updates);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update unit');
      return;
    }
    if (user) {
      logAudit({
        tenantId, userId: user.id, userName: user.name,
        action: newStatus === 'sold' ? 'sell' : newStatus === 'booked' ? 'book' : 'update',
        entity: 'unit', entityId: unitId,
        details: `Unit ${unit.number} status: ${statusLabels[unit.status]} → ${statusLabels[newStatus]}`,
      });
    }
    refresh();
    toast.success(`Unit ${unit.number} updated to ${statusLabels[newStatus]}`);
  };

  // Cycle to next allowed status (used by matrix click)
  const cycleStatus = (unit: Unit) => {
    if (!canManage) { toast.error('No permission to change status'); return; }
    const options = allowedTransitions[unit.status];
    if (options.length === 0) { toast.error('Sold units are locked'); return; }
    handleStatusChange(unit.id, options[0]);
  };

  const handleAddUnit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!currentTower) return;
    const form = e.currentTarget;
    const formData = new FormData(form);
    const floorNum = parseInt(formData.get('floor') as string);
    const unitNum = (formData.get('number') as string);

    // Check for duplicate unit number
    const existingUnit = allUnits.find(u => u.number === unitNum && u.towerId === currentTower.id);
    if (existingUnit) {
      toast.error(`Unit ${unitNum} already exists in this tower`);
      return;
    }

    let newUnit: Unit;
    try {
      newUnit = await createUnit({
        towerId: currentTower.id, floorNumber: floorNum,
        number: unitNum,
        type: (formData.get('type') as string) || '2 BHK',
        configuration: (formData.get('configuration') as string) || '2 BHK',
        area: Number(formData.get('area')) || 1000,
        price: Number(formData.get('price')) || 5000000,
        status: 'available',
        tenantId,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add unit');
      return;
    }

    // Audit log for adding unit
    if (user) {
      logAudit({
        tenantId, userId: user.id, userName: user.name,
        action: 'create', entity: 'unit', entityId: newUnit.id,
        details: `Added unit ${unitNum} to ${currentTower.name} (Floor ${floorNum}, ${formData.get('configuration')} ${formData.get('type')}, ${formData.get('area')} sqft, ${formatCurrencyFull(Number(formData.get('price')), currency)})`,
      });
    }

    setShowAddUnit(false);
    refresh();
    toast.success('Unit added successfully');
  };

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Building2 className="h-12 w-12 text-zinc-300 mb-4" />
        <h3 className="text-lg font-semibold text-zinc-700 mb-1">No Projects Found</h3>
        <p className="text-sm text-zinc-500 max-w-sm">Create your first project to start managing inventory.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-full">
      {/* Project/Tower Selector */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <select
            value={currentProject?.id || ''}
            onChange={e => {
              const p = projects.find(p => p.id === e.target.value);
              setSelectedProject(p || null);
              setSelectedTower(null);
            }}
            className="appearance-none pl-9 pr-8 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm font-semibold text-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer"
          >
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 pointer-events-none" />
        </div>

        {projectTowers.length > 0 && (
          <div className="flex items-center gap-2 bg-white border border-zinc-200 rounded-xl p-1">
            {projectTowers.map(t => (
              <button
                key={t.id}
                onClick={() => setSelectedTower(t)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${currentTower?.id === t.id ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
              >
                {t.name}
              </button>
            ))}
          </div>
        )}

        {currentProject && (
          <span className="text-sm text-zinc-500 flex items-center gap-1">
            <MapPin className="h-4 w-4" /> {currentProject.location}
          </span>
        )}

        {currentTower && (
          <span className="text-sm text-zinc-500">
            {currentTower.floors} floors · {currentTower.unitsPerFloor} units/floor
          </span>
        )}

        {canManage && (
          <button
            onClick={() => setShowAddUnit(true)}
            className="flex items-center gap-2 px-3 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 transition-colors shadow-sm ml-auto"
          >
            <Plus className="h-4 w-4" /> Add Unit
          </button>
        )}
      </div>

      {/* Status Legend & Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5 bg-white border border-zinc-200 rounded-xl p-1 flex-wrap">
          <button
            onClick={() => setStatusFilter('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${statusFilter === 'all' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-700'}`}
          >
            All ({statusCounts.total})
          </button>
          {UNIT_STATUSES.map(s => (
            <button
              key={s.id}
              onClick={() => setStatusFilter(s.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all capitalize ${statusFilter === s.id ? 'bg-zinc-800 text-white' : `${statusColors[s.id].split(' ')[0]} ${statusColors[s.id].split(' ')[1]} hover:opacity-80`}`}
            >
              {s.label} ({statusCounts[s.id] || 0})
            </button>
          ))}
        </div>

        <select
          value={configFilter}
          onChange={e => setConfigFilter(e.target.value)}
          className="px-3 py-2 bg-white border border-zinc-200 rounded-xl text-xs font-medium text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        >
          <option value="all">All Configs</option>
          {unitConfigs.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search unit..."
            className="pl-8 pr-3 py-2 bg-white border border-zinc-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 w-40"
          />
        </div>

        <div className="flex items-center gap-1 bg-white border border-zinc-200 rounded-xl p-1 ml-auto">
          <button onClick={() => setViewMode('matrix')} className={`p-2 rounded-lg transition-all ${viewMode === 'matrix' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:text-zinc-600'}`}>
            <Grid3X3 className="h-4 w-4" />
          </button>
          <button onClick={() => setViewMode('list')} className={`p-2 rounded-lg transition-all ${viewMode === 'list' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:text-zinc-600'}`}>
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Matrix View */}
      {viewMode === 'matrix' && currentTower && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-x-auto">
          <div className="min-w-[600px]">
            <div className="flex border-b border-zinc-100 bg-zinc-50/50 sticky top-0">
              <div className="w-20 shrink-0 px-3 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider border-r border-zinc-100">Floor</div>
              {Array.from({ length: matrixColumns }, (_, i) => (
                <div key={i} className="flex-1 px-3 py-3 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wider border-r border-zinc-100 last:border-r-0">Unit {i + 1}</div>
              ))}
            </div>
            {floors.map(floorNum => {
              const unitsOnFloor = unitsByFloor.get(floorNum) || [];
              const floorUnits = Array.from({ length: matrixColumns }, (_, i) => unitsOnFloor[i]);
              return (
                <div key={floorNum} className="flex border-b border-zinc-50 last:border-b-0 hover:bg-zinc-50/30 transition-colors">
                  <div className="w-20 shrink-0 px-3 py-3 flex items-center border-r border-zinc-100">
                    <div>
                      <p className="text-sm font-semibold text-zinc-800">Floor {floorNum}</p>
                      <p className="text-[10px] text-zinc-400">{floorUnits.filter(Boolean).length} units</p>
                    </div>
                  </div>
                    {floorUnits.map((unit, i) => {
                    // Performance: O(1) lookup using leadMap instead of O(n) find()
                    // Also handles orphaned bookedBy references gracefully
                    const bookedLead = unit && unit.bookedBy ? (leadMap.get(unit.bookedBy) || null) : null;
                    const hasOrphanedReference = unit && unit.bookedBy && !bookedLead;
                    
                    return (
                      <div key={i} className="flex-1 px-2 py-2 border-r border-zinc-50 last:border-r-0">
                        {unit ? (
                          <div
                            className={`rounded-xl border-2 p-2 text-center transition-all group relative ${statusColors[unit.status]} ${canManage && unit.status !== 'sold' ? 'cursor-pointer hover:shadow-md' : 'cursor-default'}`}
                            onClick={() => {
                              if (!canManage || unit.status === 'sold') return;
                              // Confirmation for status changes to prevent accidental clicks
                              const nextStatus = allowedTransitions[unit.status][0];
                              if (nextStatus && confirm(`Change Unit ${unit.number} from ${statusLabels[unit.status]} to ${statusLabels[nextStatus]}?`)) {
                                cycleStatus(unit);
                              }
                            }}
                            title={unit.status === 'sold' ? 'Sold — locked' : hasOrphanedReference ? '⚠️ Orphaned booking reference' : canManage ? 'Click to advance status' : 'View only'}
                          >
                            <p className="text-xs font-bold">{unit.number}</p>
                            <p className="text-[10px] font-medium mt-0.5">{unit.configuration}</p>
                            <p className="text-[10px] opacity-70 mt-0.5">{unit.area} sqft</p>
                            <p className="text-[10px] font-semibold mt-0.5">{formatCurrency(unit.price, currency)}</p>
                            {bookedLead && (
                              <div className="mt-1 pt-1 border-t border-black/5">
                                <p className="text-[9px] font-bold text-zinc-700 truncate" title={`Booked by ${bookedLead.name}`}>
                                  👤 {bookedLead.name.split(' ')[0]}
                                </p>
                              </div>
                            )}
                            {hasOrphanedReference && (
                              <div className="mt-1 pt-1 border-t border-red-200">
                                <p className="text-[9px] font-bold text-red-600" title="Client record was deleted">
                                  ⚠️ Orphaned
                                </p>
                              </div>
                            )}
                          </div>
                         ) : (
                          <div className="rounded-xl border-2 border-dashed border-zinc-200 p-2 text-center opacity-40">
                            <p className="text-xs">—</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* List View */}
      {viewMode === 'list' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-zinc-50/50 border-b border-zinc-100">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Unit</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Type</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Floor</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Area</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Price</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredUnits.map(unit => (
                  <tr key={unit.id} className="border-b border-zinc-50 hover:bg-zinc-50/30 transition-colors">
                    <td className="px-4 py-3"><p className="text-sm font-semibold text-zinc-900">{unit.number}</p></td>
                    <td className="px-4 py-3 text-sm text-zinc-600">{unit.configuration}</td>
                    <td className="px-4 py-3 text-sm text-zinc-600">Floor {unit.floorNumber}</td>
                    <td className="px-4 py-3 text-sm text-zinc-600 text-right">{unit.area} sqft</td>
                    <td className="px-4 py-3 text-sm font-medium text-zinc-900 text-right">{formatCurrency(unit.price, currency)}</td>
                    <td className="px-4 py-3 text-center">
                      <select
                        value={unit.status}
                        disabled={!canManage || unit.status === 'sold'}
                        onChange={e => handleStatusChange(unit.id, e.target.value as UnitStatus)}
                        className={`text-[11px] font-semibold px-2 py-1 rounded-full border-0 ${statusColors[unit.status]} ${(!canManage || unit.status === 'sold') ? 'cursor-not-allowed opacity-80' : 'cursor-pointer'}`}
                      >
                        {UNIT_STATUSES.map(s => (
                          <option key={s.id} value={s.id}>{s.label}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Stats Footer */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <div className="bg-white rounded-xl border border-zinc-200/60 p-3 text-center">
          <p className="text-xl font-bold text-zinc-900">{statusCounts.total}</p>
          <p className="text-[11px] text-zinc-500 font-medium">Total Units</p>
        </div>
        {UNIT_STATUSES.map(s => (
          <div key={s.id} className="bg-white rounded-xl border border-zinc-200/60 p-3 text-center">
            <p className={`text-xl font-bold ${s.id === 'available' ? 'text-emerald-600' : s.id === 'sold' ? 'text-violet-600' : 'text-zinc-600'}`}>
              {statusCounts[s.id] || 0}
            </p>
            <p className="text-[11px] text-zinc-500 font-medium">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Add Unit Modal */}
      {showAddUnit && currentTower && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddUnit(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">Add Unit to {currentTower.name}</h3>
              <button onClick={() => setShowAddUnit(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddUnit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Floor No.</label>
                  <input name="floor" type="number" required min="1" max={currentTower.floors} className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Unit No.</label>
                  <input name="number" required placeholder="101" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Config</label>
                  <select name="configuration" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    <option>1 BHK</option><option>2 BHK</option><option>3 BHK</option><option>4 BHK</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Type</label>
                  <input name="type" defaultValue="Apartment" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Area (sqft)</label>
                  <input name="area" type="number" defaultValue="1200" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Price ({currencySymbol(currency).trim()})</label>
                  <input name="price" type="number" defaultValue="8500000" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowAddUnit(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Add Unit</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
