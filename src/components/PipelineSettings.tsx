import { useState } from 'react';
import { Plus, X, ArrowUp, ArrowDown, RotateCcw, Workflow } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { getByTenant, logAudit } from '../services/db';
import {
  getTenantMeta, saveTenantMeta, resetTenantMeta,
  stageKeyFromLabel, STAGE_COLORS, type TenantMeta, type StageDef,
} from '../services/metaService';
import type { Lead } from '../types';

/**
 * "Pipeline & Fields" — the zero-hardcoding editor. Stages, lead sources,
 * and configurations are tenant data; every page reads them dynamically, so
 * a builder reshapes their pipeline with no code deploy.
 */
export default function PipelineSettings() {
  const { user, tenant, hasPermission } = useAuth();
  const tenantId = tenant?.id || '';
  const canManage = hasPermission('manage_settings');

  const [meta, setMeta] = useState<TenantMeta>(() => getTenantMeta(tenantId));
  const [newStageLabel, setNewStageLabel] = useState('');
  const [newSource, setNewSource] = useState('');
  const [newConfig, setNewConfig] = useState('');

  const leadCountByStage = (stageId: string) =>
    getByTenant<Lead>('leads', tenantId).filter(l => l.stage === stageId).length;

  const persist = (next: TenantMeta) => {
    // Invariants: 'new' leads the board; 'booked' and 'lost' close it
    const core = { new: next.stages.find(s => s.id === 'new')!, booked: next.stages.find(s => s.id === 'booked')!, lost: next.stages.find(s => s.id === 'lost')! };
    const middle = next.stages.filter(s => !['new', 'booked', 'lost'].includes(s.id));
    const ordered = { ...next, stages: [core.new, ...middle, core.booked, core.lost] };
    setMeta(ordered);
    saveTenantMeta(tenantId, ordered);
    if (user && tenant) logAudit({ tenantId, userId: user.id, userName: user.name, action: 'update', entity: 'pipeline_meta', entityId: tenantId, details: 'Updated pipeline / field definitions' });
  };

  const renameStage = (id: string, label: string) => {
    setMeta(m => ({ ...m, stages: m.stages.map(s => s.id === id ? { ...s, label } : s) }));
  };

  const cycleColor = (id: string) => {
    const next = {
      ...meta,
      stages: meta.stages.map(s => {
        if (s.id !== id) return s;
        const idx = STAGE_COLORS.indexOf(s.color);
        return { ...s, color: STAGE_COLORS[(idx + 1) % STAGE_COLORS.length] };
      }),
    };
    persist(next);
  };

  const moveStage = (id: string, dir: -1 | 1) => {
    const stages = [...meta.stages];
    const idx = stages.findIndex(s => s.id === id);
    const target = idx + dir;
    if (target < 0 || target >= stages.length) return;
    // Custom stages move strictly within the middle block: never past 'new'
    // at the top or 'booked'/'lost' at the bottom
    if (['new', 'booked', 'lost'].includes(stages[target].id)) return;
    [stages[idx], stages[target]] = [stages[target], stages[idx]];
    persist({ ...meta, stages });
  };

  const addStage = () => {
    const label = newStageLabel.trim();
    if (!label) { toast.error('Give the stage a name'); return; }
    const id = stageKeyFromLabel(label);
    if (!id) { toast.error('Stage name needs letters or numbers'); return; }
    if (meta.stages.some(s => s.id === id)) { toast.error('A stage with this name already exists'); return; }
    const stages = [...meta.stages];
    const bookedIdx = stages.findIndex(s => s.id === 'booked');
    stages.splice(bookedIdx, 0, { id, label, color: STAGE_COLORS[(stages.length + 2) % STAGE_COLORS.length] });
    persist({ ...meta, stages });
    setNewStageLabel('');
    toast.success(`Stage "${label}" added — it's live on the Leads board now`);
  };

  const deleteStage = (s: StageDef) => {
    if (s.core) { toast.error(`"${s.label}" is a core stage and cannot be removed`); return; }
    const inUse = leadCountByStage(s.id);
    if (inUse > 0) { toast.error(`${inUse} lead(s) are in "${s.label}" — move them to another stage first`); return; }
    persist({ ...meta, stages: meta.stages.filter(x => x.id !== s.id) });
    toast.success(`Stage "${s.label}" removed`);
  };

  const addToList = (key: 'leadSources' | 'configurations', value: string, clear: () => void) => {
    const v = value.trim();
    if (!v) return;
    if (meta[key].some(x => x.toLowerCase() === v.toLowerCase())) { toast.error('Already in the list'); return; }
    persist({ ...meta, [key]: [...meta[key], v] });
    clear();
  };

  const removeFromList = (key: 'leadSources' | 'configurations', value: string) => {
    if (meta[key].length <= 1) { toast.error('Keep at least one option'); return; }
    persist({ ...meta, [key]: meta[key].filter(x => x !== value) });
  };

  return (
    <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-lg font-semibold text-zinc-900 flex items-center gap-2">
            <Workflow className="h-5 w-5 text-indigo-500" /> Pipeline & Fields
          </h3>
          <p className="text-sm text-zinc-500 mt-0.5">
            Your pipeline, your words — rename, recolor, reorder, or add stages and every board, report, and dropdown updates instantly. No deploys.
          </p>
        </div>
        {canManage && (
          <button
            onClick={() => { setMeta(resetTenantMeta(tenantId)); toast.success('Restored the default pipeline and fields'); }}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-zinc-200 text-zinc-600 rounded-lg text-xs font-medium hover:bg-zinc-50"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset to Defaults
          </button>
        )}
      </div>

      {/* Stage editor */}
      <div>
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Pipeline Stages</p>
        <div className="space-y-2">
          {meta.stages.map((s, i) => {
            const inUse = leadCountByStage(s.id);
            return (
              <div key={s.id} className="flex items-center gap-2 p-2.5 border border-zinc-100 rounded-xl bg-zinc-50/50">
                <button
                  onClick={() => canManage && cycleColor(s.id)}
                  className={`h-5 w-5 rounded-full ${s.color} shrink-0 ${canManage ? 'cursor-pointer ring-offset-1 hover:ring-2 ring-zinc-300' : ''}`}
                  title="Click to change color"
                />
                <input
                  disabled={!canManage}
                  value={s.label}
                  onChange={e => renameStage(s.id, e.target.value)}
                  onBlur={() => persist(meta)}
                  className="flex-1 bg-transparent text-sm font-medium text-zinc-800 focus:outline-none focus:bg-white focus:px-2 focus:py-1 focus:rounded-lg focus:border focus:border-indigo-200 min-w-0"
                />
                <span className="text-[10px] text-zinc-400 shrink-0">{inUse} lead{inUse === 1 ? '' : 's'}</span>
                {s.core ? (
                  <span className="text-[9px] font-bold uppercase tracking-wider bg-zinc-200 text-zinc-500 px-1.5 py-0.5 rounded shrink-0" title="Core stages anchor bookings, reports, and automations">Core</span>
                ) : canManage && (
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button onClick={() => moveStage(s.id, -1)} disabled={meta.stages[i - 1]?.id === 'new'} className="p-1 rounded hover:bg-zinc-200 text-zinc-400 disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                    <button onClick={() => moveStage(s.id, 1)} disabled={['booked', 'lost'].includes(meta.stages[i + 1]?.id || '')} className="p-1 rounded hover:bg-zinc-200 text-zinc-400 disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
                    <button onClick={() => deleteStage(s)} className="p-1 rounded hover:bg-red-50 text-zinc-400 hover:text-red-500"><X className="h-3.5 w-3.5" /></button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {canManage && (
          <div className="flex gap-2 mt-3">
            <input
              value={newStageLabel}
              onChange={e => setNewStageLabel(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addStage()}
              placeholder='Add a stage, e.g. "Site Revisit" or "Loan Approval"'
              className="flex-1 px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
            <button onClick={addStage} className="flex items-center gap-1.5 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700">
              <Plus className="h-4 w-4" /> Add Stage
            </button>
          </div>
        )}
        <p className="text-[11px] text-zinc-400 mt-2">
          New stages appear between "New" and your booking stage. Core stages keep their identity so bookings, reports, and automations never break.
        </p>
      </div>

      {/* Lead sources */}
      <div>
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Lead Sources</p>
        <div className="flex flex-wrap gap-2">
          {meta.leadSources.map(src => (
            <span key={src} className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-100 rounded-full text-xs font-medium text-zinc-700">
              {src}
              {canManage && (
                <button onClick={() => removeFromList('leadSources', src)} className="text-zinc-400 hover:text-red-500"><X className="h-3 w-3" /></button>
              )}
            </span>
          ))}
        </div>
        {canManage && (
          <div className="flex gap-2 mt-3">
            <input
              value={newSource}
              onChange={e => setNewSource(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addToList('leadSources', newSource, () => setNewSource(''))}
              placeholder='Add a source, e.g. "Exhibition Stall"'
              className="flex-1 px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
            <button onClick={() => addToList('leadSources', newSource, () => setNewSource(''))} className="px-4 py-2.5 border border-zinc-200 text-zinc-700 rounded-xl text-sm font-medium hover:bg-zinc-50">
              Add
            </button>
          </div>
        )}
      </div>

      {/* Configurations */}
      <div>
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Unit Configurations</p>
        <div className="flex flex-wrap gap-2">
          {meta.configurations.map(cfg => (
            <span key={cfg} className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-100 rounded-full text-xs font-medium text-zinc-700">
              {cfg}
              {canManage && (
                <button onClick={() => removeFromList('configurations', cfg)} className="text-zinc-400 hover:text-red-500"><X className="h-3 w-3" /></button>
              )}
            </span>
          ))}
        </div>
        {canManage && (
          <div className="flex gap-2 mt-3">
            <input
              value={newConfig}
              onChange={e => setNewConfig(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addToList('configurations', newConfig, () => setNewConfig(''))}
              placeholder='Add a configuration, e.g. "5 BHK Penthouse"'
              className="flex-1 px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
            <button onClick={() => addToList('configurations', newConfig, () => setNewConfig(''))} className="px-4 py-2.5 border border-zinc-200 text-zinc-700 rounded-xl text-sm font-medium hover:bg-zinc-50">
              Add
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
