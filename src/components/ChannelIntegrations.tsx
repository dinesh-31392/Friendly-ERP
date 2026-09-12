import { useState, useEffect } from 'react';
import {
  Loader2, Copy, KeyRound, PhoneCall, CreditCard, CheckCircle2, AlertTriangle, Power,
} from 'lucide-react';
import {
  isApiEnabled, apiGetLeadSources, apiCreateLeadSource, apiSetLeadSourceActive,
  apiGetTelephonySettings, apiSaveTelephonySettings, apiGetGatewayEvents,
} from '../services/apiClient';
import type {
  ApiLeadSource, ApiTelephonySettings, ApiGatewayEvent,
} from '../services/apiClient';
import { formatCurrency } from '../utils/format';
import toast from 'react-hot-toast';

/**
 * The three channels that talk to the outside world: portal lead feeds, cloud
 * telephony, and the payment gateway.
 *
 * All three share a shape — a credential this workspace holds, and a state that
 * is either configured or not. Grouping them means "is this connected?" is one
 * screen rather than three places to look.
 */

const PORTAL_LABELS: Record<string, string> = {
  '99acres': '99acres',
  magicbricks: 'MagicBricks',
  housing: 'Housing.com',
  website: 'Website form',
  landing_page: 'Landing page',
  custom: 'Custom feed',
};

export default function ChannelIntegrations({ currency = 'INR' }: { currency?: string }) {
  const [sources, setSources] = useState<ApiLeadSource[]>([]);
  const [available, setAvailable] = useState<string[]>([]);
  const [telephony, setTelephony] = useState<ApiTelephonySettings | null>(null);
  const [telephonyCreds, setTelephonyCreds] = useState(false);
  const [events, setEvents] = useState<ApiGatewayEvent[]>([]);
  const [gatewayOn, setGatewayOn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  /** A minted token, shown once and never again. */
  const [minted, setMinted] = useState<{ key: string; secret: string; url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [accountSid, setAccountSid] = useState('');
  const [callerId, setCallerId] = useState('');
  const [recordCalls, setRecordCalls] = useState(false);
  const [telSecret, setTelSecret] = useState<string | null>(null);

  useEffect(() => {
    if (!isApiEnabled()) { setLoading(false); return; }
    let cancelled = false;
    Promise.all([
      apiGetLeadSources().catch(() => ({ sources: [], available: [] })),
      apiGetTelephonySettings().catch(() => null),
      apiGetGatewayEvents().catch(() => ({ events: [], configured: false })),
    ]).then(([ls, tel, gw]) => {
      if (cancelled) return;
      // `.catch` handles a rejection; it does NOT handle a response that
      // resolved with the wrong shape, which is what a partial payload or a
      // changed backend actually looks like.
      setSources(Array.isArray(ls?.sources) ? ls.sources : []);
      setAvailable(Array.isArray(ls?.available) ? ls.available : []);
      if (tel?.settings) {
        setTelephony(tel.settings);
        setTelephonyCreds(!!tel.credentialsConfigured);
        setAccountSid(tel.settings.accountSid ?? '');
        setCallerId(tel.settings.callerId ?? '');
        setRecordCalls(!!tel.settings.recordCalls);
      }
      setEvents(Array.isArray(gw?.events) ? gw.events : []);
      setGatewayOn(!!gw?.configured);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const copy = (text: string, what: string) => {
    navigator.clipboard?.writeText(text)
      .then(() => toast.success(`${what} copied`))
      .catch(() => toast.error('Could not copy'));
  };

  const mint = async (key: string) => {
    setBusy(key);
    try {
      const r = await apiCreateLeadSource(key);
      // Shown once. A token silently lost is a rotation nobody realises they
      // need to do, so it is put on screen with the URL beside it.
      setMinted({ key, secret: r.secret, url: r.ingestUrl });
      toast.success(`${PORTAL_LABELS[key] ?? key} connected`);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the feed');
    } finally {
      setBusy(null);
    }
  };

  const saveTelephony = async (rotate = false) => {
    if (!accountSid.trim() || !callerId.trim()) {
      toast.error('An account and a caller id are both needed');
      return;
    }
    setBusy('telephony');
    try {
      const r = await apiSaveTelephonySettings({
        accountSid: accountSid.trim(), callerId: callerId.trim(),
        recordCalls, active: true, rotateSecret: rotate,
      });
      if (r.callbackSecret) setTelSecret(r.callbackUrl ?? r.callbackSecret);
      if (r.recordingNotice) toast(r.recordingNotice, { icon: '⚠️', duration: 8000 });
      toast.success('Telephony saved');
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  };

  if (!isApiEnabled()) return null;
  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200/60 py-12 flex justify-center">
        <Loader2 className="h-6 w-6 text-zinc-300 animate-spin" />
      </div>
    );
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div className="space-y-5">
      {/* ── Portal lead feeds ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100">
          <h3 className="font-semibold text-zinc-900 flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-indigo-500" /> Portal lead feeds
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Each portal gets its own URL and secret, so a leaked one is revoked without taking the
            others down. Paste them into the portal's own dashboard.
          </p>
        </div>

        <div className="divide-y divide-zinc-50">
          {available.map(key => {
            const existing = sources.find(s => s.sourceKey === key);
            return (
              <div key={key} className="px-5 py-3 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-[160px]">
                  <p className="text-sm font-medium text-zinc-900">{PORTAL_LABELS[key] ?? key}</p>
                  {existing ? (
                    <p className="text-[11px] text-zinc-400">
                      {existing.receivedCount} lead(s)
                      {existing.lastSeenAt
                        ? ` · last ${String(existing.lastSeenAt).slice(0, 10)}`
                        : ' · nothing received yet'}
                    </p>
                  ) : (
                    <p className="text-[11px] text-zinc-400">Not connected</p>
                  )}
                </div>

                {existing && (
                  <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${
                    existing.active ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-500'}`}>
                    {existing.active ? 'active' : 'off'}
                  </span>
                )}

                <div className="flex items-center gap-1.5">
                  {existing && (
                    <button
                      onClick={async () => {
                        try {
                          await apiSetLeadSourceActive(existing.id, !existing.active);
                          refresh();
                        } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not change it'); }
                      }}
                      className="flex items-center gap-1 px-2.5 py-1.5 border border-zinc-200 rounded-lg text-[11px] font-semibold text-zinc-600 hover:bg-zinc-50">
                      <Power className="h-3 w-3" /> {existing.active ? 'Turn off' : 'Turn on'}
                    </button>
                  )}
                  <button onClick={() => mint(key)} disabled={busy === key}
                    className="px-2.5 py-1.5 bg-indigo-600 text-white rounded-lg text-[11px] font-semibold hover:bg-indigo-700 disabled:opacity-60">
                    {busy === key ? 'Working…' : existing ? 'Rotate secret' : 'Connect'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {minted && (
          <div className="px-5 py-4 border-t border-zinc-100 bg-indigo-50/40">
            <p className="text-xs font-semibold text-indigo-900 mb-1">
              {PORTAL_LABELS[minted.key] ?? minted.key} — copy this now
            </p>
            <p className="text-[11px] text-zinc-600 mb-2">
              The secret is stored only as a digest and cannot be shown again. Rotating replaces it
              and stops the old one immediately.
            </p>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <code className="flex-1 text-[11px] bg-white border border-zinc-200 rounded-lg px-2 py-1.5 overflow-x-auto whitespace-nowrap">
                  {origin}{minted.url}
                </code>
                <button onClick={() => copy(`${origin}${minted.url}`, 'URL')}
                  className="p-1.5 rounded-lg border border-zinc-200 hover:bg-white"><Copy className="h-3.5 w-3.5 text-zinc-500" /></button>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-[11px] bg-white border border-zinc-200 rounded-lg px-2 py-1.5 overflow-x-auto whitespace-nowrap">
                  x-lead-source-secret: {minted.secret}
                </code>
                <button onClick={() => copy(minted.secret, 'Secret')}
                  className="p-1.5 rounded-lg border border-zinc-200 hover:bg-white"><Copy className="h-3.5 w-3.5 text-zinc-500" /></button>
              </div>
            </div>
            <button onClick={() => setMinted(null)} className="mt-2 text-[11px] text-indigo-700 hover:underline">
              I have copied it
            </button>
          </div>
        )}
      </div>

      {/* ── Telephony ─────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="font-semibold text-zinc-900 flex items-center gap-2">
              <PhoneCall className="h-4 w-4 text-indigo-500" /> Click-to-call
            </h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              Rings the rep first, then the customer — who only ever sees the workspace number,
              never the rep's own.
            </p>
          </div>
          {telephonyCreds
            ? <span className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700">
                <CheckCircle2 className="h-3 w-3" /> credentials present
              </span>
            : <span className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-amber-50 text-amber-700">
                <AlertTriangle className="h-3 w-3" /> no API credentials
              </span>}
        </div>

        {!telephonyCreds && (
          <div className="px-5 py-3 bg-amber-50/40 border-b border-zinc-100">
            <p className="text-xs text-amber-800">
              Set <code>EXOTEL_API_KEY</code> and <code>EXOTEL_API_TOKEN</code> in the server
              environment. They place calls this workspace is billed for, so they never live in the
              database where a settings page could read them back.
            </p>
          </div>
        )}

        <div className="px-5 py-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Exotel account SID</label>
            <input value={accountSid} onChange={e => setAccountSid(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm" />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Caller id (ExoPhone)</label>
            <input value={callerId} onChange={e => setCallerId(e.target.value)} placeholder="+91 22 4888 9999"
              className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm" />
            <p className="text-[10px] text-zinc-400 mt-0.5">The number your customers will see.</p>
          </div>
          <label className="flex items-start gap-2 text-xs text-zinc-600 sm:col-span-2">
            <input type="checkbox" checked={recordCalls} onChange={e => setRecordCalls(e.target.checked)} className="mt-0.5" />
            <span>
              Record calls
              {/* Off by default because turning it on has a legal consequence,
                  and nobody should inherit that from a default. */}
              <span className="block text-[10px] text-zinc-400">
                India requires the caller to be told. Configure the announcement on the ExoPhone too —
                ticking this alone is not notice.
              </span>
            </span>
          </label>
          <div className="sm:col-span-2 flex gap-2">
            <button onClick={() => saveTelephony(false)} disabled={busy === 'telephony'}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60">
              {busy === 'telephony' && <Loader2 className="h-4 w-4 animate-spin" />}Save
            </button>
            {telephony?.callbackConfigured && (
              <button onClick={() => saveTelephony(true)} disabled={busy === 'telephony'}
                className="px-4 py-2 border border-zinc-200 rounded-xl text-sm font-semibold text-zinc-600 hover:bg-zinc-50">
                Rotate callback secret
              </button>
            )}
          </div>
        </div>

        {telSecret && (
          <div className="px-5 pb-4">
            <div className="bg-indigo-50/40 border border-indigo-100 rounded-xl p-3">
              <p className="text-xs font-semibold text-indigo-900 mb-1">Callback URL — copy this now</p>
              <p className="text-[11px] text-zinc-600 mb-2">
                Paste it into Exotel as the status callback. Stored only as a digest; it cannot be
                shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-[11px] bg-white border border-zinc-200 rounded-lg px-2 py-1.5 overflow-x-auto whitespace-nowrap">
                  {origin}{telSecret}
                </code>
                <button onClick={() => copy(`${origin}${telSecret}`, 'Callback URL')}
                  className="p-1.5 rounded-lg border border-zinc-200 hover:bg-white"><Copy className="h-3.5 w-3.5 text-zinc-500" /></button>
              </div>
              <button onClick={() => setTelSecret(null)} className="mt-2 text-[11px] text-indigo-700 hover:underline">
                I have copied it
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Payment gateway ───────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="font-semibold text-zinc-900 flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-indigo-500" /> Payment gateway
            </h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              Razorpay. A payment is recorded only when the gateway's own signed webhook arrives —
              never because a browser said so.
            </p>
          </div>
          {gatewayOn
            ? <span className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700">
                <CheckCircle2 className="h-3 w-3" /> configured
              </span>
            : <span className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-amber-50 text-amber-700">
                <AlertTriangle className="h-3 w-3" /> not configured
              </span>}
        </div>

        {!gatewayOn ? (
          <div className="px-5 py-3">
            <p className="text-xs text-zinc-600">
              Set <code>RAZORPAY_KEY_ID</code>, <code>RAZORPAY_KEY_SECRET</code> and
              {' '}<code>RAZORPAY_WEBHOOK_SECRET</code> in the server environment, then point the
              Razorpay dashboard webhook at:
            </p>
            <code className="mt-2 block text-[11px] bg-zinc-50 border border-zinc-200 rounded-lg px-2 py-1.5 overflow-x-auto whitespace-nowrap">
              {origin}/api/webhooks/razorpay
            </code>
            <p className="text-[11px] text-zinc-400 mt-1">
              Subscribe to <code>payment.captured</code> and <code>payment.failed</code>.
            </p>
          </div>
        ) : events.length === 0 ? (
          <div className="py-10 text-center text-sm text-zinc-400">No gateway events yet</div>
        ) : (
          <div className="divide-y divide-zinc-50">
            {events.slice(0, 10).map(ev => (
              <div key={ev.id} className="px-5 py-2.5 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-[160px]">
                  <p className="text-sm text-zinc-900">{ev.eventType || 'event'}</p>
                  <p className="text-[11px] text-zinc-400 tabular-nums">
                    {String(ev.receivedAt).slice(0, 19).replace('T', ' ')}
                    {ev.paymentRef && ` · ${ev.paymentRef}`}
                  </p>
                </div>
                {ev.amount > 0 && (
                  <span className="text-sm tabular-nums text-zinc-700">{formatCurrency(ev.amount, currency)}</span>
                )}
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                  ev.appliedAt ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-500'}`}>
                  {ev.appliedAt ? 'applied' : 'received'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
