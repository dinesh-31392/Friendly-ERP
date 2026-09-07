import { useState, useEffect } from 'react';
import { Loader2, CreditCard, ShieldCheck, AlertTriangle, Copy, Check, Unplug } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  isApiEnabled, apiGetGatewayCredentials, apiSaveGatewayCredentials,
  apiDisconnectGateway, type ApiGatewayCredentials,
} from '../services/apiClient';
import LoadFailed from './LoadFailed';

/**
 * Connect this builder's own Razorpay account.
 *
 * WHY A BUILDER SHOULD CARE
 *
 * Until they connect one, their buyers' payments land in the PLATFORM
 * operator's merchant account and have to be passed on by hand. That is the
 * uncomfortable fact this panel leads with, because a builder who does not
 * know it cannot decide anything about it.
 *
 * WRITE-ONLY, AND THE SCREEN SAYS SO
 *
 * A stored key can be replaced but never read back — not by this panel, not by
 * any route. So the fields never render a value: they are always empty, with
 * the stored state shown as a badge beside them rather than as dots in a box
 * pretending to be a password. Dots would imply the value could come back, and
 * would leave somebody wondering whether an empty save wipes it.
 */

export default function PaymentAccountPanel() {
  const [state, setState] = useState<ApiGatewayCredentials | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({ keyId: '', keySecret: '', webhookSecret: '' });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!isApiEnabled()) { setLoading(false); return; }
    let cancelled = false;
    apiGetGatewayCredentials()
      .then(s => { if (!cancelled) setState(s); })
      .catch(() => { if (!cancelled) setState(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const patch: Record<string, string> = {};
    // Only what was typed. An untouched field must not clear a stored key.
    for (const k of ['keyId', 'keySecret', 'webhookSecret'] as const) {
      if (form[k].trim()) patch[k] = form[k].trim();
    }
    if (Object.keys(patch).length === 0) { toast('Nothing to save'); return; }
    setSaving(true);
    try {
      const r = await apiSaveGatewayCredentials(patch);
      toast.success(r.connected ? 'Your Razorpay account is connected' : 'Saved');
      if (r.note) toast(r.note, { duration: 6000 });
      setForm({ keyId: '', keySecret: '', webhookSecret: '' });
      setRefreshKey(k => k + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save those credentials');
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setSaving(true);
    try {
      await apiDisconnectGateway();
      toast.success('Disconnected');
      setRefreshKey(k => k + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect');
    } finally {
      setSaving(false);
    }
  };

  if (!isApiEnabled()) return null;
  if (loading) {
    return <div className="py-10 flex justify-center"><Loader2 className="h-5 w-5 text-zinc-300 animate-spin" /></div>;
  }
  // Was `return null`, so a failed fetch made the whole panel disappear — a
  // builder looking for where to connect their payment account found nothing
  // and no reason why.
  if (!state) return <LoadFailed what="your payment settings" onRetry={() => { setLoading(true); setRefreshKey(k => k + 1); }} />;

  const label = 'block text-[11px] font-semibold text-zinc-500 uppercase mb-1';
  const input = 'w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm font-mono';
  const has = (k: string) => state.keysPresent.includes(k);

  return (
    <div className="pt-5 border-t border-zinc-100 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
          <CreditCard className="h-4 w-4 text-zinc-400" /> Your Payment Account
        </h3>
        <p className="text-xs text-zinc-500 mt-0.5 max-w-2xl">
          Where money from “Pay online” actually lands.
        </p>
      </div>

      {/* The lead. A builder on the platform account needs to know it. */}
      {state.source === 'workspace' ? (
        <div className="bg-emerald-50/60 border border-emerald-200/60 rounded-xl px-4 py-3 flex items-start gap-2.5">
          <ShieldCheck className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
          <p className="text-xs text-emerald-900">
            <strong>Connected to your own Razorpay account.</strong> Buyers pay you directly.
          </p>
        </div>
      ) : state.source === 'platform' ? (
        <div className="bg-amber-50/60 border border-amber-200/60 rounded-xl px-4 py-3 flex items-start gap-2.5">
          <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-900">
            <strong>Using the platform’s account.</strong> Your buyers’ payments land with the
            platform operator and must be passed on to you separately. Connect your own
            account below to collect directly.
          </p>
        </div>
      ) : (
        <div className="bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-3">
          <p className="text-xs text-zinc-600">
            Online payments are not configured. Buyers can still be invoiced and receipts
            recorded by hand.
          </p>
        </div>
      )}

      {!state.canStore ? (
        <p className="text-xs text-zinc-500">
          This deployment cannot store payment credentials yet — the operator needs to set
          <span className="font-mono"> KMS_KEY</span> on the server first.
        </p>
      ) : (
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label}>
                Key Id {has('key_id') && <span className="ml-1 text-emerald-600 normal-case">· stored</span>}
              </label>
              <input
                value={form.keyId} onChange={e => setForm(f => ({ ...f, keyId: e.target.value }))}
                className={input} placeholder="rzp_live_xxxxxxxxxxxx" autoComplete="off"
              />
            </div>
            <div>
              <label className={label}>
                Key Secret {has('key_secret') && <span className="ml-1 text-emerald-600 normal-case">· stored</span>}
              </label>
              <input
                type="password" value={form.keySecret}
                onChange={e => setForm(f => ({ ...f, keySecret: e.target.value }))}
                className={input} placeholder="leave blank to keep the stored one" autoComplete="off"
              />
            </div>
            <div className="sm:col-span-2">
              <label className={label}>
                Webhook Secret {has('webhook_secret') && <span className="ml-1 text-emerald-600 normal-case">· stored</span>}
              </label>
              <input
                type="password" value={form.webhookSecret}
                onChange={e => setForm(f => ({ ...f, webhookSecret: e.target.value }))}
                className={input} placeholder="from Razorpay → Settings → Webhooks" autoComplete="off"
              />
              <p className="text-[10px] text-zinc-400 mt-1">
                Optional. Without it the key secret is used to verify webhooks — Razorpay’s
                own default, but a separate one is safer.
              </p>
            </div>
          </div>

          {/* Nothing is ever rendered back into these fields, so say why. */}
          <p className="text-[11px] text-zinc-400 flex items-start gap-1.5">
            <ShieldCheck className="h-3 w-3 shrink-0 mt-0.5" />
            Stored encrypted, and never shown again — not here, not through any API. Replace
            a key by typing a new one; a blank field leaves the stored value alone.
          </p>

          <div className="flex gap-2 flex-wrap">
            <button type="submit" disabled={saving}
              className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {state.connected ? 'Update' : 'Connect account'}
            </button>
            {state.connected && (
              <button type="button" onClick={disconnect} disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2.5 bg-zinc-100 text-zinc-700 rounded-xl text-sm font-semibold hover:bg-zinc-200 disabled:opacity-50">
                <Unplug className="h-3.5 w-3.5" /> Disconnect
              </button>
            )}
          </div>
        </form>
      )}

      {/* The half of the setup that happens in Razorpay's dashboard, not here.
          Without it a payment succeeds at the gateway and is never recorded. */}
      {state.webhookUrl && (
        <div className="bg-zinc-50/60 border border-zinc-200 rounded-xl px-4 py-3">
          <p className="text-[11px] font-semibold text-zinc-600 uppercase mb-1.5">
            Register this webhook in Razorpay
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-xs bg-white border border-zinc-200 rounded-lg px-2.5 py-1.5 font-mono text-zinc-700 break-all">
              {state.webhookUrl}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(state.webhookUrl).then(() => {
                  setCopied(true); setTimeout(() => setCopied(false), 1500);
                }).catch(() => toast.error('Could not copy'));
              }}
              className="p-1.5 rounded-lg hover:bg-zinc-200 text-zinc-500"
              title="Copy webhook URL"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
          <p className="text-[10px] text-zinc-400 mt-1.5">
            Subscribe to <span className="font-mono">payment.captured</span>. A payment is only
            recorded when this webhook arrives — that is deliberate, because a browser can be
            told anything.
          </p>
        </div>
      )}
    </div>
  );
}
