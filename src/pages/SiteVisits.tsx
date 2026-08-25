import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  CalendarClock, CheckCircle2, XCircle, UserX, RefreshCw, MapPin,
  Clock, ArrowRight, Users, TrendingUp,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  apiGetSiteVisits, apiGetSiteVisitFunnel, apiRescheduleSiteVisit, apiCloseSiteVisit,
  type ApiSiteVisit,
} from '../services/apiClient';
import { receivedOn, sinceArrival, localeFor } from '../utils/format';

/**
 * Site visits — the middle of the funnel.
 *
 * The conversion event in this industry, and until now unreachable: migration
 * 043 and siteVisitRoutes have been live and under test (27 assertions) with
 * no page and no nav entry, so nobody could open it. A visit could be recorded
 * as a lead activity but never scheduled, reassigned, rescheduled, or counted.
 *
 * Gated on the LEAD permissions, not a key of its own — a visit is an event in
 * a lead's life, and inventing `manage_site_visits` would have left the feature
 * unreachable until a migration granted it to somebody. The server scopes rows
 * the same way it scopes leads: a rep restricted to their own leads sees only
 * visits assigned to them, so there is no filter to get wrong here.
 */

type Range = 'upcoming' | 'today' | 'week' | 'all';

const STATUS_STYLE: Record<string, string> = {
  scheduled: 'bg-blue-50 text-blue-700 border-blue-200',
  confirmed: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  no_show:   'bg-red-50 text-red-700 border-red-200',
  cancelled: 'bg-zinc-100 text-zinc-500 border-zinc-200',
};

const OUTCOME_STYLE: Record<string, string> = {
  booked:         'bg-emerald-100 text-emerald-800',
  interested:     'bg-blue-100 text-blue-800',
  needs_followup: 'bg-amber-100 text-amber-800',
  not_interested: 'bg-zinc-100 text-zinc-600',
};

const label = (s: string) => s.replace(/_/g, ' ');

export default function SiteVisits() {
  const { hasPermission, tenant } = useAuth();
  const appLocale = localeFor(tenant?.currency);
  const canWrite = hasPermission('manage_leads') || hasPermission('manage_own_leads');

  const [visits, setVisits] = useState<ApiSiteVisit[]>([]);
  const [funnel, setFunnel] = useState({ scheduled: 0, completed: 0, noShow: 0, booked: 0 });
  const [range, setRange] = useState<Range>('upcoming');
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [closing, setClosing] = useState<ApiSiteVisit | null>(null);

  const refresh = () => setRefreshKey(k => k + 1);

  // The window is applied HERE rather than by the server so switching it does
  // not re-fetch: a diary is small, and the visits already in hand answer every
  // range the toolbar offers.
  const bounds = useMemo(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const weekEnd = new Date(start); weekEnd.setDate(weekEnd.getDate() + 7);
    return { start, end, weekEnd };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      apiGetSiteVisits().catch(() => [] as ApiSiteVisit[]),
      apiGetSiteVisitFunnel().catch(() => ({ scheduled: 0, completed: 0, noShow: 0, booked: 0 })),
    ]).then(([v, f]) => {
      if (cancelled) return;
      setVisits(v);
      setFunnel(f);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const shown = useMemo(() => {
    const t = (v: ApiSiteVisit) => new Date(v.scheduledAt).getTime();
    const open = (v: ApiSiteVisit) => v.status === 'scheduled' || v.status === 'confirmed';
    const list = visits.slice().sort((a, b) => t(a) - t(b));
    switch (range) {
      // Everything still open from today onward — the working list, and why
      // this is the default.
      case 'upcoming': return list.filter(v => open(v) && t(v) >= bounds.start.getTime());
      case 'today':    return list.filter(v => t(v) >= bounds.start.getTime() && t(v) < bounds.end.getTime());
      case 'week':     return list.filter(v => t(v) >= bounds.start.getTime() && t(v) < bounds.weekEnd.getTime());
      default:         return list.slice().reverse();
    }
  }, [visits, range, bounds]);

  const reschedule = useCallback(async (v: ApiSiteVisit) => {
    const when = window.prompt(
      `Reschedule ${v.leadName ?? 'this visit'} — new date and time (YYYY-MM-DD HH:MM)`,
      v.scheduledAt.slice(0, 16).replace('T', ' '));
    if (!when) return;
    const iso = new Date(when.replace(' ', 'T')).toISOString();
    if (Number.isNaN(Date.parse(iso))) { toast.error('That date could not be read'); return; }
    try {
      await apiRescheduleSiteVisit(v.id, iso);
      toast.success('Visit rescheduled');
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reschedule');
    }
  }, []);

  const close = useCallback(async (
    v: ApiSiteVisit, status: 'completed' | 'no_show' | 'cancelled',
    outcome?: ApiSiteVisit['outcome'], feedback?: string,
  ) => {
    try {
      await apiCloseSiteVisit(v.id, status, outcome, feedback);
      toast.success(status === 'completed' ? 'Visit closed' : `Marked ${label(status)}`);
      setClosing(null);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the visit');
    }
  }, []);

  // Booked ÷ completed, not ÷ scheduled: a visit nobody turned up to says
  // nothing about whether the visit converts.
  const conversion = funnel.completed > 0
    ? ((funnel.booked / funnel.completed) * 100).toFixed(1) : '0.0';

  const KPI = [
    { label: 'Scheduled', value: funnel.scheduled, icon: CalendarClock, tone: 'text-blue-600 bg-blue-50' },
    { label: 'Completed', value: funnel.completed, icon: CheckCircle2, tone: 'text-emerald-600 bg-emerald-50' },
    { label: 'No-shows', value: funnel.noShow, icon: UserX, tone: 'text-red-600 bg-red-50' },
    { label: 'Booked after visit', value: funnel.booked, icon: TrendingUp, tone: 'text-indigo-600 bg-indigo-50' },
  ];

  return (
    <div className="space-y-6 max-w-[1200px]">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Site Visits</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            Scheduled → completed → booked. {conversion}% of completed visits convert.
          </p>
        </div>
        <button
          onClick={refresh}
          className="flex items-center gap-2 px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {KPI.map(k => (
          <div key={k.label} className="bg-white rounded-2xl border border-zinc-200/60 p-4">
            <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg mb-2 ${k.tone}`}>
              <k.icon className="h-4 w-4" />
            </span>
            <p className="text-2xl font-bold text-zinc-900 tabular-nums">{k.value}</p>
            <p className="text-[11px] text-zinc-500 mt-0.5">{k.label}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        <div className="px-5 py-3 border-b border-zinc-100 flex items-center gap-2 flex-wrap">
          {([['upcoming', 'Upcoming'], ['today', 'Today'], ['week', 'Next 7 days'], ['all', 'All']] as const)
            .map(([id, text]) => (
              <button
                key={id}
                onClick={() => setRange(id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  range === id ? 'bg-indigo-600 text-white' : 'text-zinc-500 hover:bg-zinc-100'
                }`}
              >{text}</button>
            ))}
          <span className="ml-auto text-[11px] text-zinc-400">
            {shown.length} visit{shown.length === 1 ? '' : 's'}
          </span>
        </div>

        {loading ? (
          <div className="py-16 text-center text-sm text-zinc-400">Loading visits…</div>
        ) : shown.length === 0 ? (
          <div className="py-16 text-center">
            <MapPin className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">No visits in this window.</p>
            <p className="text-[11px] text-zinc-400 mt-1">
              Visits are booked from a lead — open one and choose Schedule Visit.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-50">
            {shown.map(v => {
              const when = new Date(v.scheduledAt);
              const isOpen = v.status === 'scheduled' || v.status === 'confirmed';
              const overdue = isOpen && when.getTime() < Date.now();
              return (
                <div key={v.id} className="flex items-start gap-3 px-5 py-3.5 flex-wrap sm:flex-nowrap">
                  <div className={`h-10 w-10 rounded-xl flex flex-col items-center justify-center shrink-0 ${
                    overdue ? 'bg-red-50' : 'bg-indigo-50'}`}>
                    <span className={`text-[10px] font-bold leading-none ${overdue ? 'text-red-600' : 'text-indigo-600'}`}>
                      {when.toLocaleDateString(appLocale, { month: 'short' }).toUpperCase()}
                    </span>
                    <span className={`text-sm font-bold leading-none mt-0.5 ${overdue ? 'text-red-700' : 'text-indigo-700'}`}>
                      {when.getDate()}
                    </span>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-zinc-900 truncate">{v.leadName ?? 'Lead'}</p>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border capitalize ${STATUS_STYLE[v.status] ?? ''}`}>
                        {label(v.status)}
                      </span>
                      {v.outcome && (
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${OUTCOME_STYLE[v.outcome] ?? ''}`}>
                          {label(v.outcome)}
                        </span>
                      )}
                      {/* An open visit whose time has passed is the row that
                          needs a decision — say so rather than leaving it to
                          be spotted by reading dates. */}
                      {overdue && (
                        <span className="text-[10px] font-semibold text-red-600">needs closing</span>
                      )}
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-0.5">
                      <Clock className="inline h-3 w-3 mr-1 -mt-0.5" />
                      {receivedOn(v.scheduledAt, appLocale)} · {v.durationMinutes} min
                      {v.assigneeName ? <> · <Users className="inline h-3 w-3 mx-1 -mt-0.5" />{v.assigneeName}</> : null}
                      {isOpen ? ` · ${sinceArrival(v.scheduledAt)}` : ''}
                    </p>
                    {v.feedback && <p className="text-[11px] text-zinc-400 mt-1 italic truncate">“{v.feedback}”</p>}
                  </div>

                  {canWrite && isOpen && (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => reschedule(v)}
                        className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-zinc-600 border border-zinc-200 hover:bg-zinc-50"
                      >Reschedule</button>
                      <button
                        onClick={() => close(v, 'no_show')}
                        className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-red-600 border border-red-200 hover:bg-red-50"
                      >No-show</button>
                      <button
                        onClick={() => setClosing(v)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-indigo-600 text-white hover:bg-indigo-700"
                      >Close <ArrowRight className="h-3 w-3" /></button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Closing a visit is where the funnel number comes from, so the outcome
          is required rather than optional — a completed visit with no outcome
          would count as completed and convert nothing. */}
      {closing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 backdrop-blur-sm p-4"
          onClick={() => setClosing(null)} role="dialog" aria-modal="true" aria-label="Close site visit"
        >
          <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl border border-zinc-200 p-5" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-zinc-900">How did the visit go?</h3>
            <p className="text-xs text-zinc-500 mt-0.5 mb-4">{closing.leadName}</p>
            <form
              onSubmit={e => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const outcome = String(f.get('outcome')) as NonNullable<ApiSiteVisit['outcome']>;
                void close(closing, 'completed', outcome, String(f.get('feedback') || ''));
              }}
              className="space-y-3"
            >
              <div className="grid grid-cols-2 gap-2">
                {(['booked', 'interested', 'needs_followup', 'not_interested'] as const).map((o, i) => (
                  <label key={o} className="flex items-center gap-2 px-3 py-2 rounded-xl border border-zinc-200 cursor-pointer hover:bg-zinc-50 text-xs font-medium capitalize">
                    <input type="radio" name="outcome" value={o} defaultChecked={i === 0} required className="accent-indigo-600" />
                    {label(o)}
                  </label>
                ))}
              </div>
              <textarea
                name="feedback" rows={3} maxLength={2000}
                placeholder="What did they say? (optional)"
                className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
              <div className="flex items-center gap-2">
                <button type="submit" className="flex-1 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700">
                  Save outcome
                </button>
                <button
                  type="button" onClick={() => setClosing(null)}
                  className="px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50"
                >Cancel</button>
              </div>
            </form>
            <button
              type="button"
              onClick={() => void close(closing, 'cancelled')}
              className="w-full mt-3 text-[11px] font-medium text-zinc-400 hover:text-red-600 flex items-center justify-center gap-1"
            >
              <XCircle className="h-3 w-3" /> The visit was cancelled, not held
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
