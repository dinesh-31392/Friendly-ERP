import { useState, useRef, useEffect } from 'react';
import { Calendar, ChevronDown, X } from 'lucide-react';
import {
  type DateRange,
  PRESET_OPTIONS,
  rangeLabel,
  todayInputValue,
  isCustomIncomplete,
} from '../utils/dateRange';

interface Props {
  value: DateRange;
  onChange: (r: DateRange) => void;
  /** Cap the custom picker (and presets) so no future dates can be chosen.
   *  True for "received"-style filters where future is meaningless. Default true. */
  maxToday?: boolean;
  /** Optional right-aligned popover (for headers near the screen edge). */
  align?: 'left' | 'right';
  className?: string;
}

/**
 * Compact date-range control: a trigger button showing the active range, and a
 * popover with quick presets (Today, This week, This month, …) plus a custom
 * From/To range. Fully controlled via `value`/`onChange`. Closes on outside
 * click or Escape.
 */
export default function DateRangeFilter({ value, onChange, maxToday = true, align = 'left', className = '' }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const max = maxToday ? todayInputValue() : undefined;
  const active = value.preset !== 'all';

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const pickPreset = (preset: typeof PRESET_OPTIONS[number]['value']) => {
    onChange({ preset });
    if (preset !== 'all') setOpen(false);
  };

  const setCustom = (field: 'customFrom' | 'customTo', v: string) => {
    onChange({ preset: 'custom', customFrom: value.customFrom ?? null, customTo: value.customTo ?? null, [field]: v || null });
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium border transition-colors whitespace-nowrap ${
          active
            ? 'bg-indigo-50 border-indigo-200 text-indigo-700 hover:bg-indigo-100'
            : 'bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-50'
        }`}
      >
        <Calendar className="h-4 w-4" />
        <span className="max-w-[10rem] truncate">{rangeLabel(value)}</span>
        {active ? (
          <X
            className="h-3.5 w-3.5 opacity-70 hover:opacity-100"
            onClick={(e) => { e.stopPropagation(); onChange({ preset: 'all' }); setOpen(false); }}
          />
        ) : (
          <ChevronDown className="h-4 w-4 opacity-60" />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Filter by date range"
          className={`absolute z-30 mt-2 w-64 rounded-xl border border-zinc-200 bg-white shadow-lg p-2 ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          <div className="grid grid-cols-2 gap-1">
            {PRESET_OPTIONS.map(p => (
              <button
                key={p.value}
                type="button"
                onClick={() => pickPreset(p.value)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium text-left transition-colors ${
                  value.preset === p.value ? 'bg-indigo-600 text-white' : 'text-zinc-600 hover:bg-zinc-100'
                }`}
              >{p.label}</button>
            ))}
          </div>

          <div className="mt-2 pt-2 border-t border-zinc-100">
            <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 mb-1.5">Custom range</p>
            <div className="flex items-center gap-2">
              <label className="flex-1">
                <span className="sr-only">From date</span>
                <input
                  type="date"
                  value={value.preset === 'custom' ? (value.customFrom ?? '') : ''}
                  max={value.customTo || max}
                  onChange={e => setCustom('customFrom', e.target.value)}
                  className="w-full px-2 py-1.5 bg-white border border-zinc-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                />
              </label>
              <span className="text-zinc-400 text-xs">→</span>
              <label className="flex-1">
                <span className="sr-only">To date</span>
                <input
                  type="date"
                  value={value.preset === 'custom' ? (value.customTo ?? '') : ''}
                  min={value.customFrom || undefined}
                  max={max}
                  onChange={e => setCustom('customTo', e.target.value)}
                  className="w-full px-2 py-1.5 bg-white border border-zinc-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                />
              </label>
            </div>
            {isCustomIncomplete(value) && (
              <p className="mt-1.5 px-1 text-[11px] text-amber-600">Pick a start and/or end date.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
