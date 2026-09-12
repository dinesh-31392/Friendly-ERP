import { createHash, randomBytes } from 'node:crypto';

/**
 * Inbound leads from portals and web forms.
 *
 * 99acres, MagicBricks and Housing all push leads server-to-server. Each one
 * has its own idea of what a lead looks like, none of them will change it for
 * you, and all of them will send the same lead twice when their retry fires.
 *
 * The shape of the problem:
 *
 *   Different field names for the same thing. One sends `mobile`, another
 *   `phone`, a third `contact_number`. There is no negotiating this.
 *
 *   Different envelopes. Some post the lead at the top level, others wrap it
 *   in `lead` or `data` or an array of one.
 *
 *   Duplicates, constantly. The same enquiry arrives from the portal's retry,
 *   and the same buyer enquires on two portals about the same project. The
 *   first is noise; the second is a real signal a salesperson wants to see.
 *
 * So: normalise to one shape, dedupe on the phone number, and keep the source
 * on the row so a builder can tell which portal is worth paying for.
 */

export type SourceKey = '99acres' | 'magicbricks' | 'housing' | 'website' | 'landing_page' | 'custom';

export const SOURCE_KEYS: SourceKey[] = [
  '99acres', 'magicbricks', 'housing', 'website', 'landing_page', 'custom',
];

/** Display names, for the row a salesperson reads. */
export const SOURCE_LABELS: Record<SourceKey, string> = {
  '99acres': '99acres',
  magicbricks: 'MagicBricks',
  housing: 'Housing.com',
  website: 'Website',
  landing_page: 'Landing Page',
  custom: 'Custom Feed',
};

export interface NormalisedLead {
  name: string;
  phone: string;
  email: string;
  project: string;
  configuration: string;
  budget: number;
  message: string;
  /** Anything the portal sent that we did not map, kept verbatim. A field that
   *  turns out to matter is then already in the record rather than lost. */
  extra: Record<string, string>;
}

/**
 * A token for a portal to present, and the digest we store.
 *
 * 32 bytes of randomness — a machine credential with no brute-force surface
 * worth defending, which is why the digest is SHA-256 rather than argon2. It is
 * presented on every inbound lead, and a password hash there would cost 100ms
 * of CPU per lead to protect against an attack that cannot happen.
 */
export function mintSourceSecret(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashSourceSecret(token) };
}

export function hashSourceSecret(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** First non-empty value among a set of candidate keys, case-insensitively. */
function pick(src: Record<string, unknown>, keys: string[]): string {
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) lower[k.toLowerCase().replace(/[\s_-]/g, '')] = v;
  for (const key of keys) {
    const v = lower[key.toLowerCase().replace(/[\s_-]/g, '')];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** Money as sent by a portal: "₹ 45,00,000", "45 Lakh", "4500000". */
function parseBudget(raw: string): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[,\s₹]/g, '').toLowerCase();
  const n = Number(cleaned.replace(/[a-z].*$/, ''));
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Portals write budgets in words as often as in digits, and a lead recorded
  // at ₹45 instead of ₹45,00,000 sorts to the bottom of every list.
  if (/cr|crore/.test(cleaned)) return Math.round(n * 10_000_000);
  if (/l|lac|lakh/.test(cleaned)) return Math.round(n * 100_000);
  return Math.round(n);
}

/**
 * An Indian mobile number reduced to something two records can be compared on.
 *
 * The same buyer is "+91 98200 00006" to one portal, "09820000006" to another
 * and "9820000006" to a web form. Dedupe has to see one number, so this keeps
 * the last ten digits — which is the mobile number itself, with country code,
 * trunk prefix and formatting all discarded.
 */
export function normalisePhone(raw: string): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length < 10) return digits;
  return digits.slice(-10);
}

/**
 * Unwrap whatever the portal wrapped the lead in.
 *
 * They variously post the fields at the top level, inside `lead`, inside
 * `data`, or as a single-element array. Guessing is unavoidable; the
 * alternative is a per-portal parser that breaks the first time one of them
 * adds a wrapper.
 */
function unwrap(body: unknown): Record<string, unknown> {
  let node: unknown = body;
  for (let depth = 0; depth < 4; depth++) {
    if (Array.isArray(node)) { node = node[0]; continue; }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      const inner = obj.lead ?? obj.data ?? obj.Lead ?? obj.query ?? obj.enquiry;
      if (inner && typeof inner === 'object') { node = inner; continue; }
      return obj;
    }
    break;
  }
  return (node && typeof node === 'object' ? node : {}) as Record<string, unknown>;
}

/**
 * Field aliases, per portal.
 *
 * Written out rather than inferred. Each list came from what that portal
 * actually sends, and a generic "find something that looks like a phone
 * number" heuristic silently maps an alternate contact into the primary field.
 */
const FIELD_MAP: Record<SourceKey, Record<keyof Omit<NormalisedLead, 'extra'>, string[]>> = {
  '99acres': {
    name: ['name', 'sender_name', 'cust_name', 'senderName'],
    phone: ['phone', 'mobile', 'sender_phone', 'cust_phone', 'senderPhone'],
    email: ['email', 'sender_email', 'cust_email', 'senderEmail'],
    project: ['project', 'project_name', 'property_name', 'prj_name'],
    configuration: ['configuration', 'bhk', 'property_type', 'unit_type'],
    budget: ['budget', 'price', 'expected_price', 'min_budget'],
    message: ['message', 'comments', 'query', 'requirement'],
  },
  magicbricks: {
    name: ['name', 'client_name', 'contact_name', 'clientName'],
    phone: ['phone', 'mobile', 'contact_number', 'client_mobile', 'contactNumber'],
    email: ['email', 'client_email', 'contact_email', 'clientEmail'],
    project: ['project', 'project_name', 'property', 'psmname'],
    configuration: ['configuration', 'bhk', 'propertytype', 'property_type'],
    budget: ['budget', 'budget_range', 'price'],
    message: ['message', 'comments', 'remarks', 'requirement'],
  },
  housing: {
    name: ['name', 'user_name', 'lead_name', 'userName'],
    phone: ['phone', 'mobile', 'user_phone', 'phone_number', 'userPhone'],
    email: ['email', 'user_email', 'userEmail'],
    project: ['project', 'project_name', 'listing_name'],
    configuration: ['configuration', 'bhk', 'apartment_type'],
    budget: ['budget', 'price', 'budget_max'],
    message: ['message', 'comments', 'note'],
  },
  website: {
    name: ['name', 'full_name', 'fullname'],
    phone: ['phone', 'mobile', 'tel', 'contact'],
    email: ['email', 'e_mail'],
    project: ['project', 'interested_in', 'property'],
    configuration: ['configuration', 'bhk', 'unit_type'],
    budget: ['budget', 'price_range'],
    message: ['message', 'comments', 'enquiry'],
  },
  landing_page: {
    name: ['name', 'full_name', 'lead_name'],
    phone: ['phone', 'mobile', 'contact', 'whatsapp'],
    email: ['email'],
    project: ['project', 'campaign', 'utm_campaign'],
    configuration: ['configuration', 'bhk'],
    budget: ['budget'],
    message: ['message', 'comments'],
  },
  custom: {
    name: ['name'],
    phone: ['phone', 'mobile'],
    email: ['email'],
    project: ['project'],
    configuration: ['configuration', 'bhk'],
    budget: ['budget'],
    message: ['message', 'comments'],
  },
};

/** Every alias, so `extra` can hold what was NOT mapped. */
function mappedAliases(source: SourceKey): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(FIELD_MAP[source])) {
    for (const alias of list) out.add(alias.toLowerCase().replace(/[\s_-]/g, ''));
  }
  return out;
}

/**
 * Turn whatever arrived into the one shape this system stores.
 *
 * Pure, so the mapping can be tested against a real portal payload without a
 * database or a network.
 */
export function normaliseLead(source: SourceKey, body: unknown): NormalisedLead {
  const raw = unwrap(body);
  const map = FIELD_MAP[source] ?? FIELD_MAP.custom;

  const extra: Record<string, string> = {};
  const known = mappedAliases(source);
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    if (known.has(k.toLowerCase().replace(/[\s_-]/g, ''))) continue;
    extra[k.slice(0, 60)] = String(v).slice(0, 500);
  }

  return {
    name: pick(raw, map.name).slice(0, 120),
    phone: pick(raw, map.phone).slice(0, 32),
    email: pick(raw, map.email).slice(0, 160),
    project: pick(raw, map.project).slice(0, 160),
    configuration: pick(raw, map.configuration).slice(0, 40),
    budget: parseBudget(pick(raw, map.budget)),
    message: pick(raw, map.message).slice(0, 2000),
    extra,
  };
}
