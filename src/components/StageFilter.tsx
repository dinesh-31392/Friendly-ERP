import { useState, useRef, useEffect } from 'react';
import { Filter, ChevronDown, X, Check } from 'lucide-react';
import type { StageDef } from '../services/metaService';

interface Props {
  /** The tenant's own pipeline. Not a hardcoded list — stages are tenant data. */
  stages: StageDef[];
  /** Selected stage id, or 'all'. */
  value: string;
  onChange: (stage: string) => void;
  /** Lead count per stage id, for the numbers beside each row. */
  counts: Record<string, number>;
  /** Total across every stage, shown against "All stages". */
  total: number;
  align?: 'left' | 'right';
  className?: string;
}

/**
 * Stage filter for the Leads page.
 *
 * These stages used to be a row of tabs — All / New / Contacted / … / Lost —
 * which on a tenant with a longer pipeline pushed the toolbar into a
 * horizontal scroll and left the search box fighting for room. They now live
 * behind the Filters button, which until this change had no click handler at
 * all and did nothing.
 *
 * COLLAPSING A CONTROL HIDES ITS STATE, so the trigger carries the answer: it
 * shows the selected stage's name rather than the word "Filters", turns
 * indigo, and offers an X to clear without opening anything. A filtered list
 * that looks unfiltered is worse than a crowded toolbar.
 *
 * Deliberately built to match DateRangeFilter, which sits beside it: same
 * trigger shape, same active treatment, same outside-click and Escape
 * handling. Two adjacent controls that behave differently is its own bug.
 */
export default function StageFilter({
  stages, value, onChange, counts, total, align = 'left', className = '',
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = value !== 'all';
  const selected = stages.find(s => s.id === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const pick = (id: string) => { onChange(id); setOpen(false); };

  const row = (id: string, label: string, count: number, dot?: string) => {
    const on = value === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => pick(id)}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
          on ? 'bg-indigo-50 text-indigo-900 font-semibold' : 'text-zinc-700 hover:bg-zinc-100'
        }`}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot ?? 'bg-zinc-300'}`} />
        <span className="flex-1 truncate">{label}</span>
        {/* The count is the reason to open this rather than guess: an empty
            stage is worth knowing about before you filter into it. */}
        <span className={`text-xs tabular-nums ${on ? 'text-indigo-500' : 'text-zinc-400'}`}>{count}</span>
        {on && <Check className="h-3.5 w-3.5 shrink-0 text-indigo-600" />}
      </button>
    );
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={active ? `Filtered by stage: ${selected?.label ?? value}` : 'Filter by stage'}
        className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium border transition-colors whitespace-nowrap ${
          active
            ? 'bg-indigo-50 border-indigo-200 text-indigo-700 hover:bg-indigo-100'
            : 'bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-50'
        }`}
      >
        <Filter className="h-4 w-4" />
        <span className="max-w-[10rem] truncate">{active ? (selected?.label ?? value) : 'Filters'}</span>
        {active ? (
          <X
            className="h-3.5 w-3.5 opacity-70 hover:opacity-100"
            onClick={(e) => { e.stopPropagation(); onChange('all'); setOpen(false); }}
          />
        ) : (
          <ChevronDown className="h-4 w-4 opacity-60" />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Filter by stage"
          className={`absolute z-30 mt-2 w-60 max-h-[22rem] overflow-y-auto rounded-xl border border-zinc-200 bg-white shadow-lg p-2 ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Stage</p>
          <div className="space-y-0.5">
            {row('all', 'All stages', total)}
            {stages.map(s => row(s.id, s.label, counts[s.id] ?? 0, s.color))}
          </div>
        </div>
      )}
    </div>
  );
}
