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
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (body) params.set('body', body);
  const q = params.toString();
  return `mailto:${email}${q ? `?${q}` : ''}`;
}
