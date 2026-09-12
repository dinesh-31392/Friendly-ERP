import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Cloud telephony — click-to-call.
 *
 * Exotel, because it is what Indian sales desks run and its connect API is two
 * numbers and a caller id. The provider-specific parts are the two functions at
 * the bottom; everything above them is the shape any provider would need, so a
 * second one is an implementation rather than a rewrite.
 *
 * THE POINT IS THE NUMBER THE CUSTOMER SEES
 *
 * A rep calling from their own SIM hands a stranger their personal mobile
 * permanently, and when they leave the builder the customer keeps ringing them.
 * A connect call dials the AGENT first and the customer second, and the
 * customer only ever sees the builder's own line.
 *
 * That ordering is not an implementation detail. Dialling the customer first
 * means their phone rings while nobody is there — which is how a lead learns to
 * stop answering.
 */

export type CallStatus =
  | 'ringing' | 'in_progress' | 'connected' | 'no_answer' | 'busy'
  | 'failed' | 'wrong_number' | 'callback_requested';

export interface TelephonyConfig {
  accountSid: string;
  apiKey: string;
  apiToken: string;
  callerId: string;
  recordCalls: boolean;
}

/**
 * Credentials come from the environment, the account and number from the row.
 *
 * The API token places calls that a builder is billed for, so it never lives in
 * the database where a workspace admin could read it out of a settings page.
 * `account_sid` and `caller_id` are per tenant because each builder has their
 * own Exotel account and their own ExoPhone.
 */
export function telephonyConfig(row: { account_sid?: string; caller_id?: string; record_calls?: boolean } | null): TelephonyConfig | null {
  const apiKey = process.env.EXOTEL_API_KEY ?? '';
  const apiToken = process.env.EXOTEL_API_TOKEN ?? '';
  if (!apiKey || !apiToken) return null;
  const accountSid = row?.account_sid || process.env.EXOTEL_ACCOUNT_SID || '';
  const callerId = row?.caller_id || process.env.EXOTEL_CALLER_ID || '';
  if (!accountSid || !callerId) return null;
  return { accountSid, apiKey, apiToken, callerId, recordCalls: !!row?.record_calls };
}

/** A secret for the provider to present on its callbacks, and its digest. */
export function mintCallbackSecret(): { token: string; hash: string } {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: hashCallbackSecret(token) };
}

export function hashCallbackSecret(token: string): string {
  return createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

/** Constant-time digest comparison — see razorpay.ts for why `===` leaks. */
export function secretMatches(presented: string, storedHash: string): boolean {
  if (!presented || !storedHash) return false;
  const a = Buffer.from(hashCallbackSecret(presented), 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

/**
 * An Indian mobile number in the form a provider will accept.
 *
 * Exotel wants the country code. A ten-digit number gets +91; anything already
 * carrying a code is left alone. A number that cannot be made sense of is
 * returned empty so the caller refuses the call rather than dialling something
 * arbitrary — placing a call to a wrong number is worse than not placing one.
 */
export function dialable(raw: string): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return '';
}

/**
 * Exotel's call statuses mapped onto ours.
 *
 * `no-answer` and `busy` are distinct outcomes a sales desk acts on
 * differently — busy means try again in ten minutes, no-answer means try
 * tomorrow — so they are not collapsed. Anything unrecognised becomes `failed`
 * rather than `connected`: a call whose outcome we do not understand must not
 * be recorded as a conversation that happened.
 */
export function mapExotelStatus(raw: string): CallStatus {
  switch (String(raw ?? '').toLowerCase().replace(/_/g, '-')) {
    case 'in-progress': return 'in_progress';
    case 'ringing':     return 'ringing';
    case 'completed':   return 'connected';
    case 'no-answer':   return 'no_answer';
    case 'busy':        return 'busy';
    case 'failed':
    case 'canceled':
    case 'cancelled':   return 'failed';
    default:            return 'failed';
  }
}

export interface PlacedCall {
  providerCallId: string;
  status: CallStatus;
}

/**
 * Place a connect call: agent first, then customer.
 *
 * `From` is the agent and `To` is the customer — Exotel rings From, and only
 * once that leg answers does it dial To. Reversing them rings the customer
 * while nobody is there.
 */
export async function placeCall(
  cfg: TelephonyConfig,
  input: { agentNumber: string; customerNumber: string; callbackUrl?: string },
): Promise<PlacedCall> {
  const from = dialable(input.agentNumber);
  const to = dialable(input.customerNumber);
  if (!from || !to) throw new Error('A number could not be dialled');

  const body = new URLSearchParams({
    From: from,
    To: to,
    CallerId: cfg.callerId,
    CallType: 'trans',
    TimeLimit: '3600',
    Record: cfg.recordCalls ? 'true' : 'false',
  });
  if (input.callbackUrl) body.set('StatusCallback', input.callbackUrl);

  const auth = Buffer.from(`${cfg.apiKey}:${cfg.apiToken}`).toString('base64');
  const res = await fetch(
    `https://api.exotel.com/v1/Accounts/${encodeURIComponent(cfg.accountSid)}/Calls/connect.json`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
      body,
    });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Truncated: the response can echo the request, and this string reaches
    // logs that hold no numbers today.
    throw new Error(`Exotel refused the call (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = await res.json() as { Call?: { Sid?: string; Status?: string } };
  return {
    providerCallId: String(json?.Call?.Sid ?? ''),
    status: mapExotelStatus(json?.Call?.Status ?? 'ringing'),
  };
}

/**
 * The fields worth pulling out of an Exotel callback.
 *
 * Field names arrive in several casings depending on which callback fired, so
 * each is looked up case-insensitively rather than assumed.
 */
export function readCallEvent(payload: Record<string, unknown>) {
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload ?? {})) lower[k.toLowerCase()] = v;
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = lower[k.toLowerCase()];
      if (v !== undefined && v !== null && String(v) !== '') return String(v);
    }
    return '';
  };
  return {
    providerCallId: pick('CallSid', 'Sid', 'callsid'),
    status: pick('Status', 'CallStatus', 'status'),
    durationSeconds: Number(pick('ConversationDuration', 'DialCallDuration', 'Duration') || 0),
    recordingUrl: pick('RecordingUrl', 'RecordingURL'),
    to: pick('To', 'CallTo'),
    from: pick('From', 'CallFrom'),
  };
}
