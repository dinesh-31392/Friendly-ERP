import { describe, it, expect } from 'vitest';
import { formatCurrency, formatCurrencyFull, sinceArrival, receivedOn } from './format';

/**
 * formatCurrency is called from hundreds of render paths. When the partner
 * portal's overview payload turned out to be missing `bookingValue`, this
 * function was handed undefined, threw on `.toLocaleString()`, and took the
 * whole page down behind a successful login. The types said it could not
 * happen; an API payload with a hole in it said otherwise.
 */
describe('formatCurrency', () => {
  it('renders a missing figure as zero instead of throwing', () => {
    expect(() => formatCurrency(undefined as unknown as number)).not.toThrow();
    expect(formatCurrency(undefined as unknown as number)).toBe('₹0');
    expect(formatCurrency(null as unknown as number)).toBe('₹0');
    expect(formatCurrency(NaN)).toBe('₹0');
  });

  it('uses the Indian lakh/crore convention for INR', () => {
    expect(formatCurrency(6_800_000)).toBe('₹68.0 L');
    expect(formatCurrency(17_000_000)).toBe('₹1.7 Cr');
    expect(formatCurrency(5_000)).toBe('₹5,000');
  });

  it('uses K/M/B for everything else', () => {
    expect(formatCurrency(5_000, 'USD')).toBe('$5.0K');
    expect(formatCurrency(2_500_000, 'USD')).toBe('$2.5M');
  });

  it('handles negatives without losing the magnitude bucket', () => {
    // Math.abs picks the bucket; the sign must survive into the output.
    expect(formatCurrency(-6_800_000)).toBe('₹-68.0 L');
  });
});

describe('formatCurrencyFull', () => {
  it('is equally safe with a missing figure', () => {
    expect(() => formatCurrencyFull(undefined as unknown as number)).not.toThrow();
  });

  it('writes the whole number, not a compact one', () => {
    expect(formatCurrencyFull(182_000)).toMatch(/1,82,000/);
  });
});

describe('sinceArrival', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it('describes the coarse buckets people think in', () => {
    expect(sinceArrival(ago(30_000))).toBe('just now');
    expect(sinceArrival(ago(5 * 60_000))).toBe('5m ago');
    expect(sinceArrival(ago(3 * 3_600_000))).toBe('3h ago');
    expect(sinceArrival(ago(2 * 86_400_000))).toBe('2d ago');
  });

  it('reads a future timestamp as now rather than negative', () => {
    // Server and browser clocks disagree by seconds routinely; "-1m ago" is
    // never the right thing to show a user.
    expect(sinceArrival(new Date(Date.now() + 60_000).toISOString())).toBe('just now');
  });

  it('says nothing when there is no date', () => {
    expect(sinceArrival('')).toBe('');
  });
});

describe('receivedOn', () => {
  it('renders a plain calendar date without shifting the day', () => {
    // DATE columns arrive as 'YYYY-MM-DD'. node-pg used to parse them into a
    // Date at local midnight, which serialised back in UTC and moved the day
    // BACKWARDS east of Greenwich — attendance marked today read as yesterday.
    // db.ts now returns them unparsed; this pins the display half.
    expect(receivedOn('2026-08-25T10:30:00.000Z')).toMatch(/25 Aug 26/);
  });

  it('shows an em dash for a missing or unparseable date', () => {
    expect(receivedOn('')).toBe('—');
    expect(receivedOn('not-a-date')).toBe('—');
  });
});
