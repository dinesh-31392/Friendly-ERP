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
  // A missing figure renders as a zero, not as a white screen. The types say
  // this cannot happen; an API payload that omits a field says otherwise, and
  // it happened — the partner portal died on `undefined.toLocaleString()` and
  // took the whole page with it. A money formatter is called from hundreds of
  // render paths, and none of them are worth crashing over a hole in the data.
  if (typeof amount !== 'number' || !Number.isFinite(amount)) amount = 0;
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
  if (typeof amount !== 'number' || !Number.isFinite(amount)) amount = 0;   // see formatCurrency
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

/**
 * A calendar date as the USER sees it — `YYYY-MM-DD` in local time.
 *
 * `new Date().toISOString().slice(0, 10)` is UTC, and every date input, receipt
 * date and bill date in the app used it. East of Greenwich that is yesterday
 * for the first hours of every day: in IST (+5:30) a payment recorded at 01:00
 * on the 5th defaults to the 4th, silently posting it to the wrong day — and,
 * at a month boundary, the wrong month's books.
 *
 * Built from local components rather than a locale string, so it cannot be
 * changed by the browser's locale settings.
 */
export function toLocalISODate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today, local, as `YYYY-MM-DD`. */
export function todayISO(): string {
  return toLocalISODate();
}

/** `YYYY-MM-DD`, local, `days` from now — for due dates and validity windows. */
export function isoInDays(days: number): string {
  return toLocalISODate(new Date(Date.now() + days * 86400000));
}

/**
 * Add whole months to a `YYYY-MM-DD` date, clamping to the end of the target
 * month — the same rule PostgreSQL applies to `date + interval '1 month'`.
 *
 * `Date.prototype.setMonth` does NOT clamp, it overflows: 31 Jan + 1 month is
 * asked for "31 February" and JavaScript rolls it forward to 3 March. On a
 * recurring schedule that is not an off-by-a-few-days, it is a skipped period —
 * a monthly filing due on the 31st jumped February entirely, and because the
 * next due date is computed from the last one it then drifted to the 3rd of
 * every month thereafter. Loan EMIs had the same hole.
 *
 * Deliberately UTC throughout: the callers parse `YYYY-MM-DD` (which JS reads
 * as UTC midnight) and format with toISOString, so mixing in local getters
 * would shift the result by a day in any non-UTC zone.
 */
export function addMonthsISO(from: string, months: number): string {
  const d = new Date(from);
  if (Number.isNaN(d.getTime())) return from;
  const day = d.getUTCDate();
  // Move to the 1st BEFORE changing the month, or the overflow happens here.
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDayOfTarget = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTarget));
  return d.toISOString().slice(0, 10);
}
