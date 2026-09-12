import { createHash } from 'node:crypto';
import { isValidGstin, stateOfGstin, type GstInvoice } from './gst.js';

/**
 * E-invoicing — the IRN, and the payload the IRP wants.
 *
 * What this is: since October 2020, invoices above a turnover threshold must be
 * registered with the Invoice Registration Portal BEFORE they are issued. The
 * IRP returns an Invoice Reference Number, an acknowledgement, and a digitally
 * signed QR code. An invoice in scope that has no IRN is not a valid tax
 * invoice, and the buyer cannot claim input credit against it.
 *
 * What this is NOT: a connection to the IRP. Registering requires credentials
 * from a GST Suvidha Provider, and those are the builder's to hold. This module
 * does the two things that do not need them — build the INV-01 payload, and
 * compute the IRN so the number that comes back can be checked rather than
 * trusted. Same shape as the GST returns module beside it: prepare here, file
 * through the tool that holds the credentials, record what came back.
 *
 * Scope is the part people get wrong. E-invoicing covers B2B, SEZ, exports and
 * deemed exports. It does NOT cover B2C — a flat sold to an individual with no
 * GSTIN never gets an IRN, however large. Generating one for a B2C supply is
 * not a harmless extra; it is a registration the portal will reject.
 */

/** Document types the IRP accepts. Credit and debit notes get their own IRN. */
export type DocType = 'INV' | 'CRN' | 'DBN';

/**
 * The financial year an invoice belongs to, as the IRP writes it: 2026-27.
 *
 * India's year turns on 1 April, so a January invoice belongs to the year that
 * began the previous April. Getting this wrong changes the IRN, and the portal
 * rejects the mismatch rather than explaining it.
 */
export function financialYear(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(String(isoDate ?? ''));
  if (!m) return '';
  const year = Number(m[1]);
  const month = Number(m[2]);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * The IRN: SHA-256 over supplier GSTIN, financial year, document type and
 * document number, concatenated in that order with no separator.
 *
 * The IRP computes this itself and returns it. Computing it here as well is the
 * point — it makes the returned value checkable, so a response that got crossed
 * with another invoice is caught here rather than at the buyer's credit claim
 * months later.
 */
export function computeIrn(
  supplierGstin: string, docType: DocType, docNo: string, issueDate: string,
): string {
  const fy = financialYear(issueDate);
  // The GSTIN is uppercase by definition, so normalising it is safe. The
  // DOCUMENT NUMBER is not: it is whatever the builder issued, and the portal
  // hashes it as issued. Upper-casing it here would produce an IRN that never
  // matches the one that comes back for any invoice numbered in lower case —
  // which would break the only thing deriving it is for.
  const basis = `${String(supplierGstin).toUpperCase()}${fy}${docType}${String(docNo)}`;
  return createHash('sha256').update(basis, 'utf8').digest('hex');
}

export interface EinvoiceCheck { ok: boolean; reasons: string[] }

/**
 * Whether this invoice may be registered at all.
 *
 * Every reason is a rejection the portal would issue anyway; the difference is
 * that here it arrives before the submission, naming the field, rather than as
 * an error code against a document already sent.
 */
export function validateForEinvoice(
  inv: GstInvoice, supplierGstin: string,
): EinvoiceCheck {
  const reasons: string[] = [];

  if (!supplierGstin) {
    reasons.push('This workspace has no GSTIN. The IRP identifies the supplier by it.');
  } else if (!isValidGstin(supplierGstin)) {
    reasons.push('The workspace GSTIN fails its check digit.');
  }

  // The scope rule, and the one worth stating plainly: no buyer GSTIN means a
  // B2C supply, and B2C is outside e-invoicing entirely.
  if (!inv.customerGstin) {
    reasons.push('No buyer GSTIN — this is a B2C supply, which e-invoicing does not cover.');
  } else if (!isValidGstin(inv.customerGstin)) {
    reasons.push('The buyer GSTIN fails its check digit.');
  }

  if (!inv.invoiceNo) {
    reasons.push('The invoice has no number. The IRN is derived from it, so it cannot be blank.');
  } else if (inv.invoiceNo.length > 16) {
    // A real limit, and a surprising one: the IRP caps document numbers at 16
    // characters. A longer number is rejected outright.
    reasons.push('Invoice numbers longer than 16 characters are rejected by the IRP.');
  }

  if (!/^\d{4}-\d{2}-\d{2}/.test(inv.issueDate)) {
    reasons.push('The issue date is not a valid date.');
  }

  if (Number(inv.taxableValue) <= 0) {
    reasons.push('The invoice has no taxable value recorded. Record its tax first.');
  }

  // Outside the levy — a completed unit is immovable property, not a supply.
  // There is no tax invoice to register.
  if (inv.postCompletion) {
    reasons.push('Sold after completion, so outside GST — there is no supply to register.');
  }

  if (!inv.placeOfSupply) {
    reasons.push('No place of supply, so the IRP cannot tell an intra-state supply from an inter-state one.');
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * The seller block the IRP requires, separately from the invoice itself.
 *
 * Kept apart from `validateForEinvoice` because it is a workspace setting
 * rather than an invoice problem: every invoice in the workspace fails for the
 * same reason until someone fills these in once, and saying so per-invoice
 * would bury the one action that fixes all of them.
 */
export function validateSeller(seller: EinvoiceParty): EinvoiceCheck {
  const reasons: string[] = [];
  if (!seller.legalName) reasons.push('The workspace has no legal name for the seller block.');
  if (!seller.address1) reasons.push('The workspace has no address.');
  if (!seller.location) reasons.push('The workspace has no city, which the IRP requires as Loc.');
  if (!seller.pincode || !/^[1-9]\d{5}$/.test(String(seller.pincode))) {
    reasons.push('The workspace has no valid 6-digit pincode, which the IRP requires as Pin.');
  }
  if (!seller.stateCode) reasons.push('The workspace has no state code.');
  return { ok: reasons.length === 0, reasons };
}

const round2 = (n: number) => Math.round((Number.isFinite(Number(n)) ? Number(n) : 0) * 100) / 100;

export interface EinvoiceParty {
  gstin: string;
  legalName: string;
  address1: string;
  location: string;
  pincode: number;
  stateCode: string;
}

/**
 * The INV-01 payload, version 1.1 — the schema the IRP validates against.
 *
 * Only the mandatory blocks are emitted. An optional block filled with empty
 * strings is not neutral: the portal validates what is present, so sending
 * `Addr2: ""` fails where omitting it passes.
 */
export function buildEinvoicePayload(
  inv: GstInvoice, seller: EinvoiceParty, buyer: EinvoiceParty, docType: DocType = 'INV',
) {
  const interState = stateOfGstin(seller.gstin) !== inv.placeOfSupply;
  const total = round2(
    Number(inv.taxableValue) + Number(inv.cgst) + Number(inv.sgst) + Number(inv.igst));

  return {
    Version: '1.1',
    TranDtls: {
      TaxSch: 'GST',
      // Regular supply. Reverse charge and e-commerce operators change this,
      // and neither applies to a builder selling its own units.
      SupTyp: 'B2B',
      RegRev: 'N',
      IgstOnIntra: 'N',
    },
    DocDtls: {
      Typ: docType,
      No: inv.invoiceNo,
      // The IRP wants DD/MM/YYYY, not the ISO date everything else here uses.
      Dt: inv.issueDate.slice(0, 10).split('-').reverse().join('/'),
    },
    SellerDtls: {
      Gstin: seller.gstin,
      LglNm: seller.legalName,
      Addr1: seller.address1,
      Loc: seller.location,
      Pin: seller.pincode,
      Stcd: seller.stateCode,
    },
    BuyerDtls: {
      Gstin: buyer.gstin,
      LglNm: buyer.legalName,
      // Where the supply is taxed — for immovable property, where the property
      // is, which is why this comes off the invoice and not off the buyer.
      Pos: inv.placeOfSupply,
      Addr1: buyer.address1,
      Loc: buyer.location,
      Pin: buyer.pincode,
      Stcd: buyer.stateCode,
    },
    ItemList: [{
      SlNo: '1',
      PrdDesc: inv.customerName ? `Consideration — ${inv.customerName}` : 'Consideration',
      IsServc: 'Y',
      HsnCd: inv.hsnSac || '9954',
      Qty: 1,
      Unit: 'OTH',
      UnitPrice: round2(inv.taxableValue),
      TotAmt: round2(inv.taxableValue),
      AssAmt: round2(inv.taxableValue),
      GstRt: Number(inv.gstRate),
      IgstAmt: round2(inv.igst),
      CgstAmt: round2(inv.cgst),
      SgstAmt: round2(inv.sgst),
      TotItemVal: total,
    }],
    ValDtls: {
      AssVal: round2(inv.taxableValue),
      CgstVal: round2(inv.cgst),
      SgstVal: round2(inv.sgst),
      IgstVal: round2(inv.igst),
      TotInvVal: total,
    },
    // Not part of the schema — carried alongside so a caller can check the IRN
    // the portal returns against the one derivable from the document itself.
    _derived: {
      irn: computeIrn(seller.gstin, docType, inv.invoiceNo, inv.issueDate),
      financialYear: financialYear(inv.issueDate),
      interState,
    },
  };
}

/**
 * Whether a registered invoice can still be cancelled at the portal.
 *
 * The window is 24 hours from acknowledgement, and it is hard: after it closes
 * the IRP will not accept a cancellation, and the only remedy is a credit note.
 * Reporting that honestly matters more than offering a button that fails.
 */
export function canCancel(ackDateIso: string, nowIso: string): boolean {
  const ack = Date.parse(ackDateIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(ack) || !Number.isFinite(now)) return false;
  return now - ack < 24 * 60 * 60 * 1000 && now >= ack;
}
