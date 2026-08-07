import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Send, MessageCircle, ExternalLink, AlertTriangle } from 'lucide-react';
import { isApiEnabled, apiGetLeadActivities, apiSendWhatsApp } from '../services/apiClient';
import { getByTenant } from '../services/db';
import { whatsappHref } from '../utils/contact';
import type { Lead, Activity } from '../types';

/**
 * WhatsApp-style chat thread for one lead, layered on the plumbing that
 * already exists: messages live in lead_activities (type='whatsapp', notes
 * prefixed [sent via …] / [sent from phone] / [received]) and sends go through
 * /api/whatsapp/send, which dispatches from the CALLER's own linked number.
 *
 * API mode: real thread + composer, polling every 5s while open (matches the
 * app's existing patterns — no websockets). Demo mode: renders the local
 * activity entries and the composer opens a click-to-chat link, exactly the
 * demo behavior the one-shot button has always had.
 */

interface Bubble {
  id: string;
  mine: boolean;
  text: string;
  at: string;                                   // ISO timestamp
  via?: string;                                 // 'phone' when typed on the device
  state?: 'sending' | 'failed';                 // optimistic-send lifecycle
  fallbackLink?: string;                        // offered when a send fails
}

/** lead_activities note → bubble. Returns null for non-chat rows. */
function parseNote(id: string, notes: string, at: string): Bubble | null {
  const m = notes.match(/^\[(sent via [^\]]+|sent from phone|received)\]\s?([\s\S]*)$/);
  if (!m) return null;
  const dir = m[1];
  return {
    id, at,
    mine: dir !== 'received',
    via: dir === 'sent from phone' ? 'phone' : undefined,
    text: m[2],
  };
}

const dayLabel = (iso: string) => {
  const d = new Date(iso); const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, y)) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

export default function LeadWhatsAppChat({ lead, tenantId, onClose }: {
  lead: Lead; tenantId: string; onClose: () => void;
}) {
  const api = isApiEnabled();
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const optimisticSeq = useRef(0);

  const load = useCallback(async () => {
    if (api) {
      const acts = await apiGetLeadActivities(lead.id, 'whatsapp').catch(() => null);
      if (!acts) return;   // transient poll failure — keep what's on screen
      const parsed = acts
        .map(a => parseNote(a.id, a.notes, a.createdAt))
        .filter((b): b is Bubble => !!b)
        .sort((a, b) => a.at.localeCompare(b.at));
      setBubbles(prev => {
        // Keep optimistic bubbles that the server hasn't logged yet; drop the
        // ones whose text has since arrived as a real row.
        const pending = prev.filter(p => p.state && !parsed.some(s => s.mine && s.text === p.text));
        return [...parsed, ...pending];
      });
    } else {
      // Demo store logs event descriptions, not message bodies — show them as
      // a neutral system feed so the drawer stays honest in demo mode.
      const acts = getByTenant<Activity>('activities', tenantId)
        .filter(a => a.leadId === lead.id && a.type === 'whatsapp')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      setBubbles(acts.map(a => ({ id: a.id, mine: true, text: a.description, at: a.createdAt })));
    }
  }, [api, lead.id, tenantId]);

  // Initial load + 5s poll while the drawer is open. The poll is what makes
  // the customer's replies (webhook → lead_activities) appear live.
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // Stick to the bottom as messages arrive.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bubbles.length]);

  const sendDraft = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft('');

    if (!api) {
      // Demo: same free path as always — open the chat with the text prefilled.
      window.open(whatsappHref(lead.phone, text), '_blank', 'noopener');
      return;
    }

    const tempId = `optimistic-${++optimisticSeq.current}`;
    setBubbles(prev => [...prev, { id: tempId, mine: true, text, at: new Date().toISOString(), state: 'sending' }]);
    setSending(true);
    try {
      const out = await apiSendWhatsApp(lead.phone, text, lead.id);
      if (out.delivered) {
        setBubbles(prev => prev.map(b => b.id === tempId ? { ...b, state: undefined } : b));
        load();   // pull the server-logged row so the optimistic one reconciles
      } else {
        // Rep's session not connected — the server handed back a wa.me link.
        setBubbles(prev => prev.map(b => b.id === tempId
          ? { ...b, state: 'failed', fallbackLink: out.link } : b));
      }
    } catch (err) {
      const link = (err as { fallbackLink?: string })?.fallbackLink ?? whatsappHref(lead.phone, text);
      setBubbles(prev => prev.map(b => b.id === tempId ? { ...b, state: 'failed', fallbackLink: link } : b));
    } finally {
      setSending(false);
    }
  };

  // Group bubbles by calendar day for the date separators.
  const groups: { day: string; items: Bubble[] }[] = [];
  for (const b of bubbles) {
    const day = dayLabel(b.at);
    if (groups.at(-1)?.day === day) groups.at(-1)!.items.push(b);
    else groups.push({ day, items: [b] });
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-label={`WhatsApp chat with ${lead.name}`}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-md h-full bg-[#efeae2] flex flex-col shadow-2xl">
        {/* header */}
        <div className="bg-emerald-700 text-white px-4 py-3 flex items-center gap-3">
          <div className="h-9 w-9 rounded-full bg-white/20 flex items-center justify-center font-semibold">
            {lead.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{lead.name}</p>
            <p className="text-[11px] text-emerald-100 truncate">{lead.phone}{lead.project ? ` · ${lead.project}` : ''}</p>
          </div>
          <MessageCircle className="h-4 w-4 text-emerald-200" />
          <button onClick={onClose} className="p-1.5 hover:bg-white/10 rounded-lg" aria-label="Close chat">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* thread */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 space-y-2">
          {bubbles.length === 0 && (
            <p className="text-center text-xs text-zinc-500 bg-white/70 rounded-xl px-3 py-2 w-fit mx-auto">
              No messages yet — say hello 👋
            </p>
          )}
          {groups.map(g => (
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

        {/* composer */}
        <div className="bg-[#f0f2f5] px-3 py-2.5">
          {!api && (
            <p className="flex items-center gap-1.5 text-[11px] text-zinc-500 mb-1.5">
              <AlertTriangle className="h-3 w-3" /> Demo mode — sending opens WhatsApp with your text prefilled.
            </p>
          )}
          <div className="flex items-end gap-2">
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
      </div>
    </div>
  );
}
