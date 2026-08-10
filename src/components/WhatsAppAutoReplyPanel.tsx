import { useState, useEffect, useCallback } from 'react';
import { Zap, Clock, ShieldAlert, X, CheckCircle2, AlertTriangle } from 'lucide-react';
import {
  isApiEnabled, apiGetWhatsAppInstance, apiSaveWhatsAppInstance,
  apiWhatsappQueue, apiWhatsappCancelQueued,
  type WhatsAppInstance, type WhatsAppQueueItem,
} from '../services/apiClient';
import toast from 'react-hot-toast';

/**
 * Settings → Auto-Reply. Two triggers with deliberately different risk, shown
 * as such rather than as one switch:
 *
 *   • Replying to an incoming message is answering someone who contacted you.
 *   • Greeting a brand-new lead is an OUTBOUND first contact — the pattern that
 *     actually gets numbers blocked. The UI says so, and it stays off until
 *     someone turns it on knowingly.
 */
export default function WhatsAppAutoReplyPanel() {
  const [cfg, setCfg] = useState<WhatsAppInstance | null>(null);
  const [queue, setQueue] = useState<WhatsAppQueueItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [newLeadTpl, setNewLeadTpl] = useState('');
  const [inboundTpl, setInboundTpl] = useState('');

  const load = useCallback(async () => {
    if (!isApiEnabled()) return;
    try {
      const c = await apiGetWhatsAppInstance();
      setCfg(c);
      setNewLeadTpl(c.autoNewLeadTemplate ?? '');
      setInboundTpl(c.autoInboundTemplate ?? '');
      setQueue(await apiWhatsappQueue().catch(() => []));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load auto-reply settings');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (patch: Partial<WhatsAppInstance>) => {
    setBusy(true);
    try {
      await apiSaveWhatsAppInstance({ provider: 'evolution', ...patch });
      toast.success('Saved');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally { setBusy(false); }
  };

  const cancel = async (id: string) => {
    try { await apiWhatsappCancelQueued(id); toast.success('Cancelled'); load(); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Too late — it already went out'); }
  };

  if (!isApiEnabled()) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200/60 p-8 text-center">
        <Zap className="h-10 w-10 text-zinc-300 mx-auto mb-3" />
        <h3 className="text-base font-semibold text-zinc-700">Auto-reply needs the live workspace</h3>
        <p className="text-sm text-zinc-500 mt-1">Automated messages send from your linked WhatsApp on the server.</p>
      </div>
    );
  }

  const inputCls = 'px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20';
  const pending = queue.filter(q => q.status === 'pending');
  const recent = queue.filter(q => q.status !== 'pending').slice(0, 8);

  return (
    <div className="space-y-4">
      {/* inbound — the safe one */}
      <div className="bg-white rounded-2xl border border-zinc-200/60 p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-[260px]">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <h3 className="text-base font-semibold text-zinc-900">Reply to incoming messages</h3>
            </div>
            <p className="text-sm text-zinc-500 mt-1">
              Acknowledge a customer who messages you, so nobody waits in silence. This is answering
              someone who contacted you first — the low-risk kind of automation.
            </p>
          </div>
          <button
            disabled={busy}
            onClick={() => save({ autoInboundEnabled: !cfg?.autoInboundEnabled })}
            className={`px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50 ${
              cfg?.autoInboundEnabled ? 'bg-emerald-600 text-white' : 'bg-white border border-zinc-200 text-zinc-600'
            }`}
          >
            {cfg?.autoInboundEnabled ? 'On' : 'Off'}
          </button>
        </div>
        <textarea
          value={inboundTpl} onChange={e => setInboundTpl(e.target.value)}
          onBlur={() => inboundTpl !== cfg?.autoInboundTemplate && save({ autoInboundTemplate: inboundTpl })}
          rows={2} className={`${inputCls} w-full mt-3`} placeholder="Message to send…"
        />
      </div>

      {/* new lead — the risky one */}
      <div className="bg-white rounded-2xl border border-amber-200 p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-[260px]">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-600" />
              <h3 className="text-base font-semibold text-zinc-900">Greet every new lead</h3>
            </div>
            <p className="text-sm text-zinc-500 mt-1">
              Message a lead the moment it arrives from any source — the website chatbot, a partner
              referral, or added by hand.
            </p>
            <p className="text-xs text-amber-800 mt-2 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              This is an <b>outbound first contact</b> to someone who hasn't messaged you — the pattern
              that actually gets numbers restricted. Keep it personal, keep the volume low, and never
              use it for lists you didn't collect yourself.
            </p>
          </div>
          <button
            disabled={busy}
            onClick={() => save({ autoNewLeadEnabled: !cfg?.autoNewLeadEnabled })}
            className={`px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50 ${
              cfg?.autoNewLeadEnabled ? 'bg-amber-600 text-white' : 'bg-white border border-zinc-200 text-zinc-600'
            }`}
          >
            {cfg?.autoNewLeadEnabled ? 'On' : 'Off'}
          </button>
        </div>
        <textarea
          value={newLeadTpl} onChange={e => setNewLeadTpl(e.target.value)}
          onBlur={() => newLeadTpl !== cfg?.autoNewLeadTemplate && save({ autoNewLeadTemplate: newLeadTpl })}
          rows={3} className={`${inputCls} w-full mt-3`}
        />
        <p className="text-[11px] text-zinc-400 mt-1">
          Placeholders: <code>{'{{name}}'}</code> <code>{'{{agent}}'}</code> <code>{'{{company}}'}</code> <code>{'{{project}}'}</code>
        </p>
      </div>

      {/* pacing */}
      <div className="bg-white rounded-2xl border border-zinc-200/60 p-6">
        <div className="flex items-center gap-2 mb-1">
          <Clock className="h-4 w-4 text-indigo-600" />
          <h3 className="text-base font-semibold text-zinc-900">Pacing &amp; limits</h3>
        </div>
        <p className="text-sm text-zinc-500 mb-4">
          Every automated message waits a random gap so activity doesn't look machine-timed, and stops
          entirely outside working hours.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {([
            { k: 'autoMinDelaySeconds' as const, label: 'Min delay (s)', min: 0, max: 3600 },
            { k: 'autoMaxDelaySeconds' as const, label: 'Max delay (s)', min: 0, max: 3600 },
            { k: 'autoDailyCap' as const, label: 'Max per day', min: 0, max: 1000 },
            { k: 'autoQuietFrom' as const, label: 'Quiet from (h)', min: 0, max: 23 },
            { k: 'autoQuietTo' as const, label: 'Quiet until (h)', min: 0, max: 23 },
          ]).map(f => (
            <div key={f.k}>
              <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">{f.label}</label>
              <input
                type="number" min={f.min} max={f.max} defaultValue={cfg?.[f.k] ?? 0}
                onBlur={e => {
                  const v = Number(e.target.value);
                  if (v !== cfg?.[f.k]) save({ [f.k]: v } as Partial<WhatsAppInstance>);
                }}
                className={`${inputCls} w-full`}
              />
            </div>
          ))}
        </div>
        <p className="text-[11px] text-zinc-400 mt-2">
          20–60 seconds is a sensible default. A rep who replies by hand first cancels the queued message automatically.
        </p>
      </div>

      {/* queue */}
      <div className="bg-white rounded-2xl border border-zinc-200/60 p-6">
        <h3 className="text-base font-semibold text-zinc-900 mb-1">
          Queue {pending.length > 0 && <span className="text-emerald-600">({pending.length} waiting)</span>}
        </h3>
        <p className="text-sm text-zinc-500 mb-4">
          Nothing sends instantly, so you can still stop it. Opening this page also moves the queue along.
        </p>
        {pending.length === 0 && recent.length === 0 && (
          <p className="text-sm text-zinc-400 py-4 text-center">Nothing queued or sent yet.</p>
        )}
        <div className="space-y-2">
          {pending.map(q => (
            <div key={q.id} className="flex items-center gap-3 p-3 bg-emerald-50/50 border border-emerald-100 rounded-xl">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-800 truncate">{q.leadName} · {q.phone}</p>
                <p className="text-xs text-zinc-500 truncate">{q.body}</p>
                <p className="text-[10px] text-zinc-400 mt-0.5">
                  {q.trigger === 'new_lead' ? 'New-lead greeting' : 'Reply to incoming'} · sends {new Date(q.sendAfter).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}
                </p>
              </div>
              <button onClick={() => cancel(q.id)}
                className="p-1.5 text-zinc-400 hover:text-red-600 hover:bg-red-50 rounded-lg shrink-0" title="Cancel">
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          {recent.map(q => (
            <div key={q.id} className="flex items-center gap-3 p-3 bg-zinc-50 rounded-xl">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-zinc-700 truncate">{q.leadName} · {q.body}</p>
                <p className="text-[10px] text-zinc-400">
                  {q.status}{q.error ? ` — ${q.error}` : ''}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
