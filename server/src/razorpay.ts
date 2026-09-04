import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay.
 *
 * The one rule that shapes all of this: THE CLIENT NEVER SAYS A PAYMENT
 * SUCCEEDED. A browser can be told anything, and a determined buyer can tell
 * the browser anything. The only evidence a payment happened is a signed
 * message from Razorpay — either the checkout handler's signature, or a
 * webhook. Both are verified here, and nothing else is trusted.
 *
 * CREDENTIALS LIVE IN THE ENVIRONMENT
 *
 * Never in the database, never in a tenant settings row, never logged. The key
 * secret signs money movement; a workspace admin should not be able to read it
 * out of a settings page, and a database dump should not contain it.
 */

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

/** Present only when the deployment has been configured. Everything that needs
 *  it returns a clear "not configured" rather than half-working. */
export function razorpayConfig(): RazorpayConfig | null {
  const keyId = process.env.RAZORPAY_KEY_ID ?? '';
  const keySecret = process.env.RAZORPAY_KEY_SECRET ?? '';
  // Falls back to the key secret because that is what Razorpay's dashboard
  // defaults to when no separate webhook secret is set — but a real deployment
  // should set both.
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || keySecret;
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret, webhookSecret };
}

/**
 * Rupees → paise.
 *
 * Razorpay works entirely in the smallest currency unit. ₹100 is 10000, and
 * getting this wrong is not a rounding error — it charges a buyer a hundred
 * times too much or too little, and it is the single most common mistake made
 * against this API.
 *
 * Rounded rather than truncated: 0.1 + 0.2 in floating point is
 * 0.30000000000000004, and `Math.trunc(x * 100)` on a computed instalment
 * silently loses a paisa on values that look exact.
 */
export function toPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) throw new Error('amount is not a number');
  const paise = Math.round(rupees * 100);
  if (paise <= 0) throw new Error('amount must be positive');
  // Razorpay rejects anything above this, and an overflow here would otherwise
  // surface as an opaque gateway error.
  if (paise > 1_000_000_000_00) throw new Error('amount exceeds the gateway limit');
  return paise;
}

/** Paise → rupees, for reading an amount back out of a gateway payload. */
export function fromPaise(paise: number): number {
  return Math.round(Number(paise ?? 0)) / 100;
}

/**
 * Constant-time comparison of two hex digests.
 *
 * `a === b` on a signature leaks its content through timing: an attacker who
 * can measure the difference between a first-byte mismatch and a
 * thirty-second-byte mismatch can recover a valid signature byte by byte.
 * timingSafeEqual needs equal lengths, and throws otherwise — so the length
 * check happens first, and returning false for a wrong length is safe because
 * the length of a SHA-256 hex digest is not a secret.
 */
function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Verify a webhook.
 *
 * The signature is over the RAW REQUEST BODY, byte for byte. Re-serialising the
 * parsed JSON produces a different string — different key order, different
 * whitespace, different unicode escaping — and the signature will never match.
 * That is why the caller has to hand in the raw buffer rather than the object,
 * and why the route registers its own content-type parser to keep one.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string,
  webhookSecret: string,
): boolean {
  if (!webhookSecret || !signatureHeader) return false;
  const expected = createHmac('sha256', webhookSecret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');
  return safeEqualHex(expected, signatureHeader);
}

/**
 * Verify a checkout handler's signature.
 *
 * Razorpay signs `order_id|payment_id` with the KEY SECRET here, not the
 * webhook secret — a different key over a different string, which is easy to
 * get wrong and produces a verification that never passes.
 *
 * This is the belt to the webhook's braces: it lets the page confirm
 * immediately, while the webhook remains the thing that actually records the
 * money. A payment is not lost if the browser closes before this runs.
 */
export function verifyCheckoutSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string,
): boolean {
  if (!orderId || !paymentId || !signature || !keySecret) return false;
  const expected = createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return safeEqualHex(expected, signature);
}

export interface RazorpayOrder {
  id: string;
  amount: number;     // paise
  currency: string;
  status: string;
}

/**
 * Create an order at Razorpay.
 *
 * The amount is computed by the caller from the milestone, never taken from a
 * request body — a client that can name its own amount can pay ₹1 for a ₹10
 * lakh instalment.
 *
 * `receipt` carries our own schedule id so a payment can always be traced back
 * to what it was for, even from the Razorpay dashboard by someone who has never
 * seen this system.
 */
export async function createOrder(
  cfg: RazorpayConfig,
  input: { amountRupees: number; receipt: string; notes?: Record<string, string> },
): Promise<RazorpayOrder> {
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64'),
    },
    body: JSON.stringify({
      amount: toPaise(input.amountRupees),
      currency: 'INR',
      receipt: input.receipt.slice(0, 40),
      notes: input.notes ?? {},
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // The gateway's message is included because "order creation failed" with
    // no reason is unactionable, but it is truncated: the response can echo
    // request content, and this string ends up in logs.
    throw new Error(`Razorpay order creation failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return await res.json() as RazorpayOrder;
}

/**
 * The fields worth pulling out of a `payment.captured` webhook.
 *
 * Razorpay nests the payment two levels down and the shape differs by event
 * type, so a missing field is normal rather than exceptional — this returns
 * nulls instead of throwing, and the caller decides what it can do without.
 */
export function readPaymentEvent(payload: unknown): {
  eventId: string; eventType: string; orderId: string; paymentId: string; amountRupees: number;
} {
  const p = (payload ?? {}) as Record<string, unknown>;
  const entity = (((p.payload as Record<string, unknown>)?.payment as Record<string, unknown>)
    ?.entity ?? {}) as Record<string, unknown>;
  return {
    // `id` on the envelope is absent on some event versions; the x-razorpay
    // event id header is the reliable one and the caller passes it in when
    // this comes back empty.
    eventId: String(p.id ?? ''),
    eventType: String(p.event ?? ''),
    orderId: String(entity.order_id ?? ''),
    paymentId: String(entity.id ?? ''),
    amountRupees: fromPaise(Number(entity.amount ?? 0)),
  };
}
