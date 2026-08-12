export type CurrencyCode = 'INR' | 'USD' | 'EUR' | 'GBP' | 'AED' | 'SGD' | 'AUD';

export const CURRENCIES: { code: CurrencyCode; symbol: string; label: string }[] = [
  { code: 'INR', symbol: '₹', label: 'Indian Rupee (₹)' },
  { code: 'USD', symbol: '$', label: 'US Dollar ($)' },
  { code: 'EUR', symbol: '€', label: 'Euro (€)' },
  { code: 'GBP', symbol: '£', label: 'British Pound (£)' },
  { code: 'AED', symbol: 'AED ', label: 'UAE Dirham (AED)' },
  { code: 'SGD', symbol: 'S$', label: 'Singapore Dollar (S$)' },
  { code: 'AUD', symbol: 'A$', label: 'Australian Dollar (A$)' },
];

export const COUNTRIES: { name: string; currency: CurrencyCode }[] = [
  { name: 'India', currency: 'INR' },
  { name: 'United States', currency: 'USD' },
  { name: 'United Arab Emirates', currency: 'AED' },
  { name: 'United Kingdom', currency: 'GBP' },
  { name: 'Singapore', currency: 'SGD' },
  { name: 'Australia', currency: 'AUD' },
  { name: 'Germany', currency: 'EUR' },
  { name: 'France', currency: 'EUR' },
  { name: 'Other', currency: 'USD' },
];

export function currencySymbol(currency: string): string {
  return CURRENCIES.find(c => c.code === currency)?.symbol ?? `${currency} `;
}

/** Date/time locale for a tenant — Indian formatting for INR workspaces,
 *  international otherwise. Pass to toLocaleDateString/toLocaleTimeString. */
export function localeFor(currency?: string): string {
  return (currency || 'INR') === 'INR' ? 'en-IN' : 'en-US';
}

/**
 * Compact money display. INR uses the Indian L (lakh) / Cr (crore)
 * convention; every other currency uses K / M / B.
 */
export function formatCurrency(amount: number, currency: string = 'INR'): string {
  const sym = currencySymbol(currency);
  const abs = Math.abs(amount);
  if (currency === 'INR') {
    if (abs >= 1e7) return `${sym}${(amount / 1e7).toFixed(1)} Cr`;
    if (abs >= 1e5) return `${sym}${(amount / 1e5).toFixed(1)} L`;
    return `${sym}${amount.toLocaleString('en-IN')}`;
  }
  if (abs >= 1e9) return `${sym}${(amount / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sym}${(amount / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sym}${(amount / 1e3).toFixed(1)}K`;
  return `${sym}${amount.toLocaleString()}`;
}

/** Full (non-compact) money display, e.g. for invoices: ₹4,50,000 / $450,000 */
export function formatCurrencyFull(amount: number, currency: string = 'INR'): string {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency', currency, maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currencySymbol(currency)}${amount.toLocaleString()}`;
  }
}

/**
 * When a lead arrived, as a date and a clock time.
 *
 * Both matter and for different reasons: the date is what people file by, the
 * time is what tells a sales manager whether an enquiry that came in at 9pm was
 * answered the same evening or left overnight. Showing only the date hides the
 * response-time question entirely.
 */
export function receivedOn(iso: string, locale = 'en-IN'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(locale, {
    day: 'numeric', month: 'short', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * How long ago, in the coarse buckets people actually think in.
 *
 * "3h ago" is what makes an unanswered enquiry jump out of a list; an absolute
 * timestamp does not, because reading it means doing the subtraction yourself.
 */
export function sinceArrival(iso: string, now: Date = new Date()): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((now.getTime() - then) / 60000);
  if (mins < 0) return 'just now';        // clock skew between server and browser
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 31) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}
