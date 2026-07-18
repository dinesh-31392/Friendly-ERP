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
