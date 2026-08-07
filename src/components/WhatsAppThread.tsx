import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, ExternalLink, AlertTriangle, Paperclip } from 'lucide-react';
import { isApiEnabled, apiGetLeadActivities, apiSendWhatsApp, apiSendWhatsAppMedia } from '../services/apiClient';
import { getByTenant } from '../services/db';
import { whatsappHref } from '../utils/contact';
import { activitiesToBubbles, groupByDay, timeLabel, type Bubble } from '../services/whatsappThread';
import type { Activity } from '../types';
import toast from 'react-hot-toast';

/**
 * The conversation itself — message list + composer — for one lead. Used by
 * both the lead drawer (LeadWhatsAppChat) and the Messages inbox, so the two
 * can never render the same conversation differently.
 *
 * Sends go through /api/whatsapp/send, which dispatches from the CALLER's own
 * linked number. Polls every 5s while mounted; that poll is what makes the
 * customer's replies (webhook → lead_activities) appear without a refresh.
 */
export default function WhatsAppThread({ leadId, phone, tenantId, onActivity }: {
  leadId: string;
  phone: string;
  tenantId: string;
  /** Fired after a successful send so a parent list can re-sort/refresh. */
  onActivity?: () => void;
}) {
  const api = isApiEnabled();
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const optimisticSeq = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (api) {
      const acts = await apiGetLeadActivities(leadId, 'whatsapp').catch(() => null);
      if (!acts) return;   // transient poll failure — keep what's on screen
      const parsed = activitiesToBubbles(acts);
      setBubbles(prev => {
        // Keep optimistic bubbles the server hasn't logged yet; drop the ones
        // whose text has since arrived as a real row.
        const pending = prev.filter(p => p.state && !parsed.some(s => s.mine && s.text === p.text));
        return [...parsed, ...pending];
      });
    } else {
      // Demo store logs event descriptions, not message bodies — show them as
      // a neutral feed so the panel stays honest in demo mode.
      const acts = getByTenant<Activity>('activities', tenantId)
        .filter(a => a.leadId === leadId && a.type === 'whatsapp')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      setBubbles(acts.map(a => ({ id: a.id, mine: true, text: a.description, at: a.createdAt })));
    }
  }, [api, leadId, tenantId]);

  // Reset when the selected conversation changes, then poll.
  useEffect(() => { setBubbles([]); setDraft(''); }, [leadId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bubbles.length, leadId]);

  const sendDraft = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft('');

    if (!api) {
      window.open(whatsappHref(phone, text), '_blank', 'noopener');
      return;
    }

    const tempId = `optimistic-${++optimisticSeq.current}`;
    setBubbles(prev => [...prev, { id: tempId, mine: true, text, at: new Date().toISOString(), state: 'sending' }]);
    setSending(true);
    try {
      const out = await apiSendWhatsApp(phone, text, leadId);
      if (out.delivered) {
        setBubbles(prev => prev.map(b => b.id === tempId ? { ...b, state: undefined } : b));
        load();
        onActivity?.();
      } else {
        // Session not connected — the server handed back a click-to-chat link.
        setBubbles(prev => prev.map(b => b.id === tempId
          ? { ...b, state: 'failed', fallbackLink: out.link } : b));
      }
    } catch (err) {
      const link = (err as { fallbackLink?: string })?.fallbackLink ?? whatsappHref(phone, text);
      setBubbles(prev => prev.map(b => b.id === tempId ? { ...b, state: 'failed', fallbackLink: link } : b));
    } finally {
      setSending(false);
    }
  };

  /** Attachment picker → base64 → /send-media. Sends immediately; a caption is
   *  whatever is already typed in the composer. */
  const MAX_MB = 10;
  const sendFile = async (file: File) => {
    if (!api) { toast.error('Attachments need the live workspace'); return; }
    if (file.size > MAX_MB * 1024 * 1024) { toast.error(`Files must be under ${MAX_MB} MB`); return; }

    const mediatype: 'image' | 'video' | 'audio' | 'document' =
      file.type.startsWith('image/') ? 'image'
      : file.type.startsWith('video/') ? 'video'
      : file.type.startsWith('audio/') ? 'audio' : 'document';
    const icon = mediatype === 'image' ? '📷' : mediatype === 'video' ? '🎥' : mediatype === 'audio' ? '🎵' : '📄';
    const caption = draft.trim();
    setDraft('');

    const tempId = `optimistic-${++optimisticSeq.current}`;
    setBubbles(prev => [...prev, {
      id: tempId, mine: true, at: new Date().toISOString(), state: 'sending',
      text: `${icon} ${file.name}${caption ? ` — ${caption}` : ''}`,
    }]);
    setSending(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).replace(/^data:[^;]+;base64,/, ''));
        r.onerror = () => reject(new Error('Could not read that file'));
        r.readAsDataURL(file);
      });
      await apiSendWhatsAppMedia({
        to: phone, leadId, mediatype, mimetype: file.type || 'application/octet-stream',
        fileName: file.name, caption: caption || undefined, base64,
      });
      setBubbles(prev => prev.map(b => b.id === tempId ? { ...b, state: undefined } : b));
      load();
      onActivity?.();
    } catch (err) {
      setBubbles(prev => prev.map(b => b.id === tempId ? { ...b, state: 'failed' } : b));
      toast.error(err instanceof Error ? err.message : 'Could not send the attachment');
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 space-y-2 bg-[#efeae2]">
        {bubbles.length === 0 && (
          <p className="text-center text-xs text-zinc-500 bg-white/70 rounded-xl px-3 py-2 w-fit mx-auto">
            No messages yet — say hello 👋
          </p>
        )}
        {groupByDay(bubbles).map(g => (
          <div key={g.day}>
            <p className="text-center my-2">
              <span className="text-[10px] font-medium text-zinc-500 bg-white/80 rounded-lg px-2.5 py-1">{g.day}</span>
            </p>
            <div className="space-y-1.5">
              {g.items.map(b => (
                <div key={b.id} className={`flex ${b.mine ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-xl px-3 py-2 shadow-sm text-sm whitespace-pre-wrap break-words ${
                    b.mine ? 'bg-[#d9fdd3] text-zinc-900' : 'bg-white text-zinc-900'
                  } ${b.state === 'failed' ? 'opacity-70 border border-red-300' : ''}`}>
                    {b.text}
                    <span className="block text-right text-[10px] text-zinc-500 mt-0.5">
                      {b.via === 'phone' && <span title="Typed on your phone">📱 </span>}
                      {b.state === 'sending' ? 'sending…' : b.state === 'failed' ? 'not sent' : timeLabel(b.at)}
                    </span>
                    {b.state === 'failed' && b.fallbackLink && (
                      <a href={b.fallbackLink} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[11px] text-emerald-700 font-semibold mt-1">
                        <ExternalLink className="h-3 w-3" /> Send from WhatsApp instead
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="bg-[#f0f2f5] px-3 py-2.5 shrink-0">
        {!api && (
          <p className="flex items-center gap-1.5 text-[11px] text-zinc-500 mb-1.5">
            <AlertTriangle className="h-3 w-3" /> Demo mode — sending opens WhatsApp with your text prefilled.
          </p>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileRef} type="file" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) sendFile(f); e.target.value = ''; }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={!api || sending}
            title={api ? 'Attach a photo or document' : 'Attachments need the live workspace'}
            className="h-10 w-10 shrink-0 rounded-full text-zinc-500 hover:bg-zinc-200 flex items-center justify-center disabled:opacity-40"
            aria-label="Attach a file"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDraft(); } }}
            placeholder="Type a message"
            rows={1}
            className="flex-1 resize-none max-h-28 px-3.5 py-2.5 bg-white rounded-xl text-sm focus:outline-none"
          />
          <button
            onClick={sendDraft}
            disabled={!draft.trim() || sending}
            className="h-10 w-10 shrink-0 rounded-full bg-emerald-600 text-white flex items-center justify-center hover:bg-emerald-700 disabled:opacity-40"
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </>
  );
}
