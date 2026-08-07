import { useState, useEffect, useCallback } from 'react';
import { MessageCircle, QrCode, Unplug, RefreshCw, CheckCircle2 } from 'lucide-react';
import { isApiEnabled, apiWhatsappSession, apiWhatsappConnect, apiWhatsappDisconnect, type WhatsAppSession } from '../services/apiClient';
import toast from 'react-hot-toast';

/**
 * "My WhatsApp" — each sales rep links their OWN personal / WhatsApp Business
 * number by scanning a QR. Live chats and drips then go out from that rep's
 * number via the tenant's self-hosted Evolution gateway.
 *
 * API mode only: the QR handshake needs the server + gateway. In demo mode the
 * card explains the feature instead of pretending to connect — a fake
 * "connected" chip would be a lie the demo can't back up with real sends.
 */
export default function MyWhatsAppCard() {
  const api = isApiEnabled();
  const [session, setSession] = useState<WhatsAppSession | null>(null);
  const [qr, setQr] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) return;
    try { setSession(await apiWhatsappSession()); } catch { /* keep last known */ }
  }, [api]);

  useEffect(() => { refresh(); }, [refresh]);

  // While the QR is on screen, poll until the phone-side scan flips us to
  // connected (the webhook updates the row; we just re-read it).
  useEffect(() => {
    if (!qr || session?.status === 'connected') return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [qr, session?.status, refresh]);

  useEffect(() => {
    if (session?.status === 'connected' && qr) {
      setQr(''); setPairingCode('');
      toast.success('WhatsApp linked — your chats and drips now send from your own number');
    }
  }, [session?.status, qr]);

  const connect = async () => {
    setBusy(true);
    try {
      const res = await apiWhatsappConnect();
      setSession(res.session);
      setQr(res.qrcode); setPairingCode(res.pairingCode);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reach the WhatsApp gateway');
    } finally { setBusy(false); }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      setSession(await apiWhatsappDisconnect());
      setQr(''); setPairingCode('');
      toast.success('WhatsApp unlinked');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect');
    } finally { setBusy(false); }
  };

  const status = session?.status ?? 'disconnected';
  const chip = status === 'connected'
    ? 'bg-emerald-50 text-emerald-700'
    : status === 'connecting' ? 'bg-amber-50 text-amber-700' : 'bg-zinc-100 text-zinc-500';

  return (
    <div className="bg-white rounded-2xl border border-zinc-200/60 p-5">
      <div className="flex items-center gap-3 mb-1">
        <div className="h-9 w-9 rounded-xl bg-emerald-50 flex items-center justify-center">
          <MessageCircle className="h-5 w-5 text-emerald-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-zinc-900">My WhatsApp</p>
          <p className="text-xs text-zinc-500">Link your own number — your chats and drip messages send from it</p>
        </div>
        <span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold capitalize ${chip}`}>
          {status}{session?.phone ? ` · ${session.phone}` : ''}
        </span>
      </div>

      {!api ? (
        <p className="text-xs text-zinc-400 mt-3">
          Available when connected to the server — the QR handshake runs through your workspace's self-hosted WhatsApp gateway.
        </p>
      ) : status === 'connected' ? (
        <div className="flex items-center gap-2 mt-4">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          <p className="text-xs text-zinc-500 flex-1">Messages you send from the ERP go out from this number, and incoming replies are logged to the lead's timeline.</p>
          <button onClick={disconnect} disabled={busy}
            className="flex items-center gap-1.5 px-3 py-2 bg-zinc-100 text-zinc-700 rounded-xl text-xs font-semibold hover:bg-zinc-200 disabled:opacity-50">
            <Unplug className="h-3.5 w-3.5" /> Disconnect
          </button>
        </div>
      ) : qr ? (
        <div className="mt-4 flex flex-col items-center gap-3">
          <img src={qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`} alt="WhatsApp QR"
            className="h-52 w-52 rounded-xl border border-zinc-200" />
          <p className="text-xs text-zinc-500 text-center">
            WhatsApp → Settings → Linked devices → <b>Link a device</b>, then scan.
            {pairingCode && <> Or enter code <b className="font-mono">{pairingCode}</b>.</>}
          </p>
          <button onClick={connect} disabled={busy}
            className="flex items-center gap-1.5 px-3 py-2 bg-zinc-100 text-zinc-700 rounded-xl text-xs font-semibold hover:bg-zinc-200 disabled:opacity-50">
            <RefreshCw className="h-3.5 w-3.5" /> New QR
          </button>
        </div>
      ) : (
        <button onClick={connect} disabled={busy}
          className="mt-4 flex items-center gap-2 px-4 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50">
          <QrCode className="h-4 w-4" /> {busy ? 'Requesting QR…' : 'Link WhatsApp'}
        </button>
      )}
    </div>
  );
}
