import type { ApiLeadActivity } from './apiClient';

/**
 * Shared model for the WhatsApp conversation view.
 *
 * The thread IS `lead_activities` (type='whatsapp'). The webhook and the send
 * route write a direction prefix into `notes` — `[sent via …]`, `[received]`,
 * `[sent from phone]` — and this module is the single place that contract is
 * parsed, so the lead drawer and the Messages inbox can never drift apart.
 */

export interface Bubble {
  id: string;
  mine: boolean;
  text: string;
  at: string;                                   // ISO timestamp
  via?: 'phone';                                // typed on the rep's device
  state?: 'sending' | 'failed';                 // optimistic-send lifecycle
  fallbackLink?: string;                        // offered when a send fails
}

const PREFIX = /^\[(sent via [^\]]+|sent from phone|received)\]\s?([\s\S]*)$/;

/** lead_activities note → bubble. Returns null for rows that aren't chat. */
export function parseNote(id: string, notes: string, at: string): Bubble | null {
  const m = notes.match(PREFIX);
  if (!m) return null;
  const dir = m[1];
  return {
    id, at,
    mine: dir !== 'received',
    via: dir === 'sent from phone' ? 'phone' : undefined,
    text: m[2],
  };
}

/** Strip the direction prefix for a one-line preview (inbox list). */
export function previewText(notes: string): string {
  return notes.match(PREFIX)?.[2] ?? notes;
}

export function activitiesToBubbles(acts: ApiLeadActivity[]): Bubble[] {
  return acts
    .map(a => parseNote(a.id, a.notes, a.createdAt))
    .filter((b): b is Bubble => !!b)
    .sort((a, b) => a.at.localeCompare(b.at));
}

export const dayLabel = (iso: string): string => {
  const d = new Date(iso); const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, y)) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

export const timeLabel = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

/** Compact "when" for the inbox list: time today, weekday this week, else date. */
export const inboxStamp = (iso: string): string => {
  const d = new Date(iso);
  const label = dayLabel(iso);
  if (label === 'Today') return timeLabel(iso);
  if (label === 'Yesterday') return 'Yesterday';
  const ageDays = (Date.now() - d.getTime()) / 86_400_000;
  if (ageDays < 7) return d.toLocaleDateString('en-IN', { weekday: 'short' });
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

/** Group consecutive bubbles under their calendar-day heading. */
export function groupByDay(bubbles: Bubble[]): { day: string; items: Bubble[] }[] {
  const groups: { day: string; items: Bubble[] }[] = [];
  for (const b of bubbles) {
    const day = dayLabel(b.at);
    if (groups.at(-1)?.day === day) groups.at(-1)!.items.push(b);
    else groups.push({ day, items: [b] });
  }
  return groups;
}
