// Deep links that open the device's native apps (dialer / WhatsApp / mail).
// On mobile these launch the actual app; on desktop they open the default
// handler (e.g. WhatsApp Web, mail client).

export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^+\d]/g, '')}`;
}

export function whatsappHref(phone: string, text?: string): string {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export function mailtoHref(email: string, subject?: string, body?: string): string {
  // The recipient is attacker-controllable (a lead's email arrives from the
  // public microsite), so encode it — a raw value like
  // `a@b.com?cc=attacker@x.com` would otherwise inject extra mailto headers.
  // encodeURIComponent turns the `?` into %3F so it can't start a new query;
  // `@`→%40 stays valid for mail clients.
  const to = encodeURIComponent(email.trim());
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (body) params.set('body', body);
  const q = params.toString();
  return `mailto:${to}${q ? `?${q}` : ''}`;
}
