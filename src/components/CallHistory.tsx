import { useState, useEffect } from 'react';
import { PhoneCall, PhoneMissed, PhoneOff, Play, Loader2 } from 'lucide-react';
import { isApiEnabled, apiGetCallLogs, type ApiCallLog } from '../services/apiClient';

/**
 * The call history for one lead.
 *
 * Every click-to-call writes a `call_logs` row when it is placed, and the
 * telephony webhook updates it when the call ends — duration, final status,
 * and a recording URL. `GET /api/call-logs` has served all of it, gated on
 * view_leads, with nothing anywhere in the product reading it. So the ERP
 * dialled the number, recorded what happened, and then showed none of it.
 *
 * This is deliberately NOT folded into the Activity Timeline beside it. A
 * timeline entry is what a rep chose to write down; a call log is what the
 * exchange observed. When those two disagree — "spoke to buyer, very keen"
 * against a 4-second failed call — the disagreement is the useful part, and
 * merging them into one list would hide it.
 */

const STATUS_ICON: Record<string, typeof PhoneCall> = {
  completed: PhoneCall,
  connected: PhoneCall,
  no_answer: PhoneMissed,
  busy: PhoneMissed,
  failed: PhoneOff,
  cancelled: PhoneOff,
};

const STATUS_STYLE: Record<string, string> = {
  completed: 'text-emerald-600',
  connected: 'text-emerald-600',
  no_answer: 'text-amber-600',
  busy:      'text-amber-600',
  failed:    'text-red-500',
  cancelled: 'text-zinc-400',
};

/** Seconds as a person says them. 0 is meaningful here — a call that never
 *  connected — so it is shown rather than hidden as a blank. */
function duration(seconds: number): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s === 0) return 'not connected';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

export default function CallHistory({ leadId }: { leadId: string }) {
  const [logs, setLogs] = useState<ApiCallLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isApiEnabled() || !leadId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    apiGetCallLogs(leadId)
      .then(rows => { if (!cancelled) setLogs(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setLogs([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [leadId]);

  // Telephony is optional, and a workspace without it has no logs and no
  // reason to see an empty section about calls it cannot place.
  if (!isApiEnabled() || (!loading && logs.length === 0)) return null;

  return (
    <div>
      <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Call history</h4>
      {loading ? (
        <div className="py-4 flex justify-center"><Loader2 className="h-4 w-4 text-zinc-300 animate-spin" /></div>
      ) : (
        <div className="space-y-1 max-h-56 overflow-y-auto">
          {logs.map(l => {
            const Icon = STATUS_ICON[l.status] ?? PhoneOff;
            return (
              <div key={l.id} className="flex items-start gap-3 py-2 border-b border-zinc-50 last:border-0">
                <div className="h-7 w-7 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0 mt-0.5">
                  <Icon className={`h-3.5 w-3.5 ${STATUS_STYLE[l.status] ?? 'text-zinc-500'}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-700">
                    <span className="capitalize">{(l.status ?? '').replace(/_/g, ' ')}</span>
                    <span className="text-zinc-400"> · {duration(l.durationSeconds)}</span>
                    {l.mode && <span className="text-zinc-400"> · {l.mode}</span>}
                  </p>
                  {l.notes && <p className="text-xs text-zinc-500 mt-0.5 break-words">{l.notes}</p>}
                  <p className="text-[11px] text-zinc-400 mt-0.5">
                    {new Date(l.createdAt).toLocaleDateString('en-IN', {
                      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                    })}
                  </p>
                </div>
                {l.recordingUrl && (
                  // Opened rather than embedded: the recording lives behind the
                  // provider's own auth, and an <audio> tag would show a broken
                  // player to anyone whose session there has expired.
                  <a
                    href={l.recordingUrl} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold text-indigo-600 hover:bg-indigo-50 shrink-0"
                  >
                    <Play className="h-3 w-3" /> Recording
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
