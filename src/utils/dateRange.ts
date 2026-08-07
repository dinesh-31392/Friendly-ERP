/**
 * Date-range primitives shared by the Leads list, Dashboard and Reports.
 *
 * All boundaries are computed in LOCAL time (the browser's zone — IST for our
 * en-IN workspaces) so "today" means the user's calendar day, not a UTC day.
 * `from` is start-of-day (00:00:00.000); `to` is END-of-day (23:59:59.999),
 * i.e. the range is INCLUSIVE on both ends. A null bound means "open" on that
 * side, so `all` is `{ from: null, to: null }` and matches everything.
 */

export type RangePreset =
  | 'all'
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'this_month'
  | 'last_7'
  | 'last_30'
  | 'custom';

export interface DateRange {
  preset: RangePreset;
  /** Only meaningful when preset === 'custom'; ISO date strings 'yyyy-mm-dd'. */
  customFrom?: string | null;
  customTo?: string | null;
}

export interface ResolvedRange {
  from: Date | null;
  to: Date | null;
}

export const ALL_RANGE: DateRange = { preset: 'all' };

/** Preset chips shown in the picker, in display order. 'custom' is handled
 *  separately by the two date inputs, so it is not in this list. */
export const PRESET_OPTIONS: { value: Exclude<RangePreset, 'custom'>; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This week' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_7', label: 'Last 7 days' },
  { value: 'last_30', label: 'Last 30 days' },
];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

/** Parse a 'yyyy-mm-dd' value from <input type="date"> as a LOCAL date (not
 *  UTC — `new Date('2026-08-04')` is UTC midnight and would drift a day back
 *  in IST). Returns null for empty/invalid input. */
function parseLocalDateInput(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve a DateRange to concrete { from, to } Date bounds relative to `now`
 * (defaults to the current time). Week starts Monday.
 */
export function resolveRange(range: DateRange, now: Date = new Date()): ResolvedRange {
  const today = startOfDay(now);
  switch (range.preset) {
    case 'all':
      return { from: null, to: null };
    case 'today':
      return { from: today, to: endOfDay(now) };
    case 'yesterday': {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      return { from: y, to: endOfDay(y) };
    }
    case 'this_week': {
      // Monday-start: getDay() is 0(Sun)..6(Sat); shift so Monday = 0.
      const dow = (today.getDay() + 6) % 7;
      const from = new Date(today);
      from.setDate(from.getDate() - dow);
      return { from, to: endOfDay(now) };
    }
    case 'this_month': {
      const from = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from, to: endOfDay(now) };
    }
    case 'last_7': {
      const from = new Date(today);
      from.setDate(from.getDate() - 6); // inclusive of today = 7 calendar days
      return { from, to: endOfDay(now) };
    }
    case 'last_30': {
      const from = new Date(today);
      from.setDate(from.getDate() - 29);
      return { from, to: endOfDay(now) };
    }
    case 'custom': {
      const from = parseLocalDateInput(range.customFrom);
      const to = parseLocalDateInput(range.customTo);
      return { from: from ? startOfDay(from) : null, to: to ? endOfDay(to) : null };
    }
    default:
      return { from: null, to: null };
  }
}

/** True when an ISO timestamp falls within the resolved range (inclusive).
 *  Open bounds (null) never exclude. Unparseable input is excluded. */
export function inRange(iso: string | null | undefined, r: ResolvedRange): boolean {
  if (r.from === null && r.to === null) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  if (r.from && t < r.from.getTime()) return false;
  if (r.to && t > r.to.getTime()) return false;
  return true;
}

/** True when a custom range is selected but not yet fully/validly filled. */
export function isCustomIncomplete(range: DateRange): boolean {
  if (range.preset !== 'custom') return false;
  const { from, to } = resolveRange(range);
  return !from && !to;
}

const DMY: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };

/** Human label for the active range — for headers, badges and CSV filenames. */
export function rangeLabel(range: DateRange, locale = 'en-IN'): string {
  const preset = PRESET_OPTIONS.find(p => p.value === range.preset);
  if (preset && range.preset !== 'custom') return preset.label;
  const { from, to } = resolveRange(range);
  if (!from && !to) return 'All time';
  const f = from ? from.toLocaleDateString(locale, DMY) : '…';
  const t = to ? to.toLocaleDateString(locale, DMY) : '…';
  if (from && !to) return `From ${f}`;
  if (!from && to) return `Until ${t}`;
  return f === t ? f : `${f} – ${t}`;
}

/** Compact slug for filenames, e.g. 'this-month' or '2026-08-01_2026-08-31'. */
export function rangeSlug(range: DateRange): string {
  if (range.preset !== 'custom') return range.preset.replace(/_/g, '-');
  const from = range.customFrom || 'start';
  const to = range.customTo || 'end';
  return `${from}_${to}`;
}

/** Today as a 'yyyy-mm-dd' string in LOCAL time — the max for received-date
 *  custom pickers (no future dates). */
export function todayInputValue(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
