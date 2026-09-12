/**
 * PAN — the Permanent Account Number, and what it is needed for here.
 *
 * TDS under section 194-IA is already computed and shown on the cost sheet:
 * 1% of the consideration, deducted BY THE BUYER and remitted to the Income
 * Tax Department. What was missing is the identifier that duty is discharged
 * against. Form 26QB — the challan-cum-statement the buyer files — requires
 * the PAN of both parties, so the deduction the ERP calculates could not
 * actually be filed from what the ERP stored.
 *
 * `cancellationRoutes` already reasons about "TDS remitted against the buyer's
 * PAN" in prose. This is the field that makes that sentence true.
 *
 * WHY THERE IS NO CHECKSUM HERE
 *
 * A GSTIN ends in a check digit with a published algorithm, so `isValidGstin`
 * can prove a number is well-formed. PAN's tenth character is also a check
 * character, but the Income Tax Department has never published how it is
 * derived. Anything claiming to verify it is guessing.
 *
 * So this validates STRUCTURE only, and says so rather than implying more
 * assurance than it has: five letters, four digits, a letter, and a fourth
 * character that is one of the ten defined holder types. That catches
 * transpositions and junk; it cannot catch a plausible number that was never
 * issued. Only the department's own verification API can do that.
 */

/**
 * The fourth character encodes what kind of holder the PAN belongs to. It is
 * the one part of the number that carries meaning worth checking against the
 * context — a builder's own PAN should be a company, firm or trust, never an
 * individual's, and a mismatch there usually means somebody pasted the wrong
 * number.
 */
export const PAN_HOLDER_TYPES: Record<string, string> = {
  P: 'Individual',
  C: 'Company',
  H: 'Hindu Undivided Family',
  A: 'Association of Persons',
  B: 'Body of Individuals',
  G: 'Government agency',
  J: 'Artificial juridical person',
  L: 'Local authority',
  F: 'Firm or LLP',
  T: 'Trust',
};

const PAN_SHAPE = /^[A-Z]{3}[ABCFGHJLPT][A-Z]\d{4}[A-Z]$/;

export function normalisePan(pan: string): string {
  return String(pan ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

/** Structurally valid — see the note above on why that is the honest ceiling. */
export function isValidPan(pan: string): boolean {
  return PAN_SHAPE.test(normalisePan(pan));
}

/** What kind of holder the number claims to belong to, or '' if unreadable. */
export function panHolderType(pan: string): string {
  const p = normalisePan(pan);
  return PAN_SHAPE.test(p) ? (PAN_HOLDER_TYPES[p[3]] ?? '') : '';
}

/**
 * A GSTIN contains its holder's PAN: two state digits, then the ten PAN
 * characters, then an entity code, 'Z', and the check digit.
 *
 * So a GST-registered builder never has to type their PAN twice, and if they
 * do, the two can be checked against each other — a workspace whose PAN
 * disagrees with its own GSTIN has one of them wrong, and both feed statutory
 * filings.
 */
export function panFromGstin(gstin: string): string {
  const g = normalisePan(gstin);
  return g.length === 15 ? g.slice(2, 12) : '';
}

export interface PanCheck { ok: boolean; reason: string }

/**
 * Validate a PAN, optionally against the GSTIN it should be embedded in.
 *
 * Empty is allowed and reported as ok: PAN is required to FILE 26QB, not to
 * exist as a customer, and refusing to save a buyer because their PAN has not
 * been collected yet would make the field harder to adopt than to skip.
 * Whether it is present is a question for the point of filing, not of entry.
 */
export function checkPan(pan: string, gstin?: string): PanCheck {
  const p = normalisePan(pan);
  if (!p) return { ok: true, reason: '' };

  if (!PAN_SHAPE.test(p)) {
    return {
      ok: false,
      reason: 'That PAN is not the right shape — five letters, four digits, then a letter (AAAPL1234C).',
    };
  }

  if (gstin) {
    const embedded = panFromGstin(gstin);
    if (embedded && embedded !== p) {
      return {
        ok: false,
        reason: `That PAN does not match the one inside this GSTIN (${embedded}). One of the two is wrong, and both are filed.`,
      };
    }
  }

  return { ok: true, reason: '' };
}

/**
 * Masked for display. PAN is personal data under the DPDP Act and identifies
 * its holder to the tax department, so a screen that lists customers should
 * not print it in full for everyone who can see the list.
 *
 * The last four characters are kept because that is what people check against
 * a document in front of them; the first six are what identify the person.
 */
export function maskPan(pan: string): string {
  const p = normalisePan(pan);
  if (!p) return '';
  if (p.length <= 4) return '••••';
  return `${'•'.repeat(p.length - 4)}${p.slice(-4)}`;
}
