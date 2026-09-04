import { useState, useEffect, useMemo } from 'react';
import { Loader2, LogIn, Clock, ShieldCheck, AlertTriangle, CalendarPlus } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  isApiEnabled, apiGetSessions, apiPreviewDerivedAttendance, apiDeriveAttendance,
  type ApiUserSession, type ApiDerivedDay,
} from '../services/apiClient';

/**
 * Sign-in times, and the attendance they can propose.
 *
 * WHAT THIS SCREEN IS CAREFUL ABOUT
 *
 * A session proves an account was signed in. It does not prove somebody was at
 * work, and it is not hours worked. Presenting derived times as if they were
 * attendance is how a payroll run ends up wrong, so the screen keeps the two
 * apart: the left half is what happened, the right half is what would be
 * written, and nothing is written without a click.
 *
 * The note about pay is not decoration. Monthly staff are paid a salary
 * regardless of attendance; contract workers are paid by the day and do not
 * have logins at all. Anyone reaching for this expecting it to drive payroll
 * should learn that here rather than after a run.
 */

/** Local YYYY-MM-DD — toISOString would shift the day for anyone east of UTC. */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const hhmm = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

const hours = (minutes: number) => {
  const m = Math.max(0, Math.round(minutes));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

const ENDED_STYLE: Record<string, string> = {
  open:       'bg-emerald-50 text-emerald-700',
  logout:     'bg-zinc-100 text-zinc-600',
  logout_all: 'bg-zinc-100 text-zinc-600',
  revoked:    'bg-amber-50 text-amber-700',
  expired:    'bg-zinc-100 text-zinc-500',
};

export default function SessionAttendancePanel({ canManage }: { canManage: boolean }) {
  const todayStr = isoDay(new Date());
  const weekAgo = isoDay(new Date(Date.now() - 6 * 86400000));

  const [from, setFrom] = useState(weekAgo);
  const [to, setTo] = useState(todayStr);
  const [sessions, setSessions] = useState<ApiUserSession[]>([]);
  const [days, setDays] = useState<ApiDerivedDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!isApiEnabled()) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      apiGetSessions({ from, to }).catch(() => [] as ApiUserSession[]),
      apiPreviewDerivedAttendance(from, to).catch(() => [] as ApiDerivedDay[]),
    ]).then(([s, d]) => {
      if (cancelled) return;
      setSessions(Array.isArray(s) ? s : []);
      setDays(Array.isArray(d) ? d : []);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [from, to, refreshKey]);

  const openNow = useMemo(() => sessions.filter(s => s.endedBy === 'open').length, [sessions]);
  const toCreate = useMemo(() => days.filter(d => d.willCreate).length, [days]);

  const derive = async () => {
    setRunning(true);
    try {
      const res = await apiDeriveAttendance(from, to);
      toast.success(
        res.created === 0
          ? 'Nothing to add — every day was already recorded'
          : `${res.created} day${res.created === 1 ? '' : 's'} added to attendance`);
      setRefreshKey(k => k + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add those days');
    } finally {
      setRunning(false);
    }
  };

  if (!isApiEnabled()) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200/60 py-14 text-center">
        <LogIn className="h-9 w-9 text-zinc-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-zinc-700">Sign-in history needs the API</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* What this is and is not — stated before the data, not under it. */}
      <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
        <p className="text-sm text-zinc-600">
          When people signed in and out of the ERP. Useful as a record of presence for office
          staff — and it can propose attendance rows from those times.
        </p>
        <div className="flex items-start gap-2 mt-3 p-3 bg-amber-50/60 border border-amber-200/70 rounded-xl">
          <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-900">
            <span className="font-semibold">This does not decide anyone&apos;s pay.</span> Monthly staff
            are paid their salary whether or not they signed in. Contract workers are paid by the
            day and have no ERP login at all — their attendance comes from a site check-in, and
            nothing here will ever create or change it.
          </p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-zinc-200/60 p-4 flex items-end gap-3 flex-wrap">
        <label className="block">
          <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">From</span>
          <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)}
            className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm" />
        </label>
        <label className="block">
          <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">To</span>
          <input type="date" value={to} min={from} max={todayStr} onChange={e => setTo(e.target.value)}
            className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm" />
        </label>
        <div className="flex items-center gap-4 ml-auto text-sm">
          <span className="text-zinc-500">
            Signed in now: <span className="font-bold text-emerald-700 tabular-nums">{openNow}</span>
          </span>
          <span className="text-zinc-500">
            Sessions: <span className="font-bold text-zinc-900 tabular-nums">{sessions.length}</span>
          </span>
        </div>
      </div>

      {loading ? (
        <div className="bg-white rounded-2xl border border-zinc-200/60 py-14 flex justify-center">
          <Loader2 className="h-6 w-6 text-zinc-300 animate-spin" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* ── what happened ─────────────────────────────────────────── */}
          <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100">
              <h3 className="font-semibold text-zinc-900 flex items-center gap-2">
                <Clock className="h-4 w-4 text-zinc-400" /> Sign-in history
              </h3>
              <p className="text-xs text-zinc-500 mt-0.5">
                A session never signed out is counted only to the moment its token expired.
              </p>
            </div>
            {sessions.length === 0 ? (
              <div className="py-12 text-center text-sm text-zinc-400">No sign-ins in this range</div>
            ) : (
              <div className="divide-y divide-zinc-50 max-h-[26rem] overflow-y-auto">
                {sessions.map(s => (
                  <div key={s.id} className="px-5 py-2.5 flex items-center gap-3 flex-wrap">
                    <div className="flex-1 min-w-[140px]">
                      <p className="text-sm font-medium text-zinc-900">{s.userName || 'Unknown user'}</p>
                      <p className="text-[11px] text-zinc-400 tabular-nums">
                        {new Date(s.loginAt).toLocaleDateString()} · {hhmm(s.loginAt)} → {hhmm(s.logoutAt)}
                        {s.ip ? ` · ${s.ip}` : ''}
                      </p>
                    </div>
                    <span className="text-[11px] tabular-nums text-zinc-600">{hours(s.minutes)}</span>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                      ENDED_STYLE[s.endedBy] ?? 'bg-zinc-100 text-zinc-600'}`}>
                      {(s.endedBy ?? 'open').replace('_', ' ')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── what would be written ─────────────────────────────────── */}
          <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100 flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h3 className="font-semibold text-zinc-900 flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-zinc-400" /> Proposed attendance
                </h3>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Only staff who have an ERP account. A day already recorded is never overwritten.
                </p>
              </div>
              {canManage && toCreate > 0 && (
                <button onClick={derive} disabled={running}
                  className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 disabled:opacity-60">
                  {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarPlus className="h-3.5 w-3.5" />}
                  Add {toCreate} day{toCreate === 1 ? '' : 's'}
                </button>
              )}
            </div>
            {days.length === 0 ? (
              <div className="py-12 text-center text-sm text-zinc-400">
                Nothing to propose for this range
              </div>
            ) : (
              <div className="divide-y divide-zinc-50 max-h-[26rem] overflow-y-auto">
                {days.map(d => (
                  <div key={`${d.employeeId}-${d.date}`} className="px-5 py-2.5">
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex-1 min-w-[140px]">
                        <p className="text-sm font-medium text-zinc-900">{d.employeeName}</p>
                        <p className="text-[11px] text-zinc-400 tabular-nums">
                          {d.date} · {d.firstLogin} → {d.lastLogout} · {d.sessions} session{d.sessions === 1 ? '' : 's'}
                        </p>
                      </div>
                      <span className="text-[11px] tabular-nums text-zinc-600">{hours(d.minutes)}</span>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        d.willCreate ? 'bg-indigo-50 text-indigo-700' : 'bg-zinc-100 text-zinc-500'}`}>
                        {d.willCreate ? 'will add' : 'already recorded'}
                      </span>
                    </div>
                    {d.reason && <p className="text-[11px] text-zinc-400 mt-1">{d.reason}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
