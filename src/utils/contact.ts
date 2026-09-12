// Deep links that open the device's native apps (dialer / WhatsApp / mail).
// On mobile these launch the actual app; on desktop they open the default
// handler (e.g. WhatsApp Web, mail client).

// Every helper here takes a value straight off an API row, and phone and email
// are both nullable in the schema. These run inline while a list renders, so an
// absent number does not degrade one row — it throws mid-render and replaces the
// whole page with an error boundary. Each one accepts an absent value and
// returns a link that simply does nothing.
export function telHref(phone?: string | null): string {
  return `tel:${(phone ?? '').replace(/[^+\d]/g, '')}`;
}

/**
 * A number you can act on but not write down: 9820000006 → 982000XXXX.
 *
 * Shown wherever leads appear as a LIST — the table, the kanban cards, the
 * grid — because those views put every number in the workspace on one screen,
 * which is the shape a leaked customer list is copied from. Open a lead and
 * the drawer shows it in full: reading one number is the job, harvesting
 * hundreds is not.
 *
 * Masks the last four DIGITS while leaving separators alone, so a formatted
 * number keeps its shape (+91 98200 00006 → +91 98200 0XXXX).
 *
 * This is a display control, not a security boundary. The API returns the full
 * number to anyone entitled to the lead, tel: and WhatsApp links still carry
 * it — deliberately, so click-to-call keeps working — and the CSV export writes
 * it in full. It raises the effort of casual copying; it does not stop a
 * determined user who can already read the record.
 */
export function maskPhone(phone?: string | null, visibleFromEnd = 4): string {
  if (!phone) return '';
  const chars = [...phone];
  let masked = 0;
  for (let i = chars.length - 1; i >= 0 && masked < visibleFromEnd; i--) {
    if (/\d/.test(chars[i])) { chars[i] = 'X'; masked++; }
  }
  return chars.join('');
}

export function whatsappHref(phone?: string | null, text?: string): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export function mailtoHref(email?: string | null, subject?: string, body?: string): string {
  // The recipient is attacker-controllable (a lead's email arrives from the
  // public microsite), so encode it — a raw value like
  // `a@b.com?cc=attacker@x.com` would otherwise inject extra mailto headers.
  // encodeURIComponent turns the `?` into %3F so it can't start a new query;
  // `@`→%40 stays valid for mail clients.
  const to = encodeURIComponent((email ?? '').trim());
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (body) params.set('body', body);
  const q = params.toString();
  return `mailto:${to}${q ? `?${q}` : ''}`;
}
