/**
 * GST: the tax split, and the two returns a builder actually files.
 *
 * `tax_postings` recorded that some tax existed. Nothing computed a return, and
 * nothing could have — see migration 056 for why an invoice that does not know
 * its own tax cannot produce a GSTR-1.
 *
 * Everything here is pure. A return is arithmetic over a period's invoices, and
 * arithmetic that reaches a government should be testable without a database.
 */

const CP = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Is this a real GSTIN?
 *
 * Fifteen characters: two-digit state code, ten-character PAN, one entity
 * number, a literal Z, and a checksum. The checksum is the part worth
 * computing — a typo in a customer's GSTIN passes a regex happily, lands in
 * the B2B table of the return, and fails at GSTN weeks later with a rejection
 * naming an invoice nobody remembers raising.
 *
 * The algorithm is GSTN's own: weight each of the first fourteen characters
 * alternately by 2 and 1 from the right, fold each product into base 36, and
 * the check character is what brings the total to a multiple of 36.
 */
export function isValidGstin(gstin: string): boolean {
  const g = String(gstin ?? '').trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return false;

  let factor = 2;
  let sum = 0;
  for (let i = 13; i >= 0; i--) {
    const code = CP.indexOf(g[i]);
    if (code < 0) return false;
    let digit = factor * code;
    factor = factor === 2 ? 1 : 2;
    digit = Math.floor(digit / 36) + (digit % 36);
    sum += digit;
  }
  return CP[(36 - (sum % 36)) % 36] === g[14];
}

/** The state a GSTIN belongs to — its first two digits. */
export function stateOfGstin(gstin: string): string {
  return String(gstin ?? '').trim().slice(0, 2);
}

const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

export interface TaxSplit { cgst: number; sgst: number; igst: number; interState: boolean }

/**
 * Split a rate into the heads that actually get paid.
 *
 * Intra-state: half to the centre, half to the state. Inter-state: the whole
 * rate as IGST. The comparison is the supplier's state against the PLACE OF
 * SUPPLY — for immovable property that is where the property is, never where
 * the buyer lives, which is the mistake that puts the money in the wrong
 * state's account.
 *
 * The halves are computed from the rounded total rather than each from the
 * rate, so CGST and SGST are always exactly equal — the invariant the schema
 * enforces. Halving 5% of 1,00,001 twice independently gives 2500.03 and
 * 2500.02, which the CHECK constraint would reject.
 */
export function splitTax(
  taxableValue: number,
  ratePct: number,
  supplierState: string,
  placeOfSupply: string,
): TaxSplit {
  const total = round2(Number(taxableValue) * Number(ratePct) / 100);
  const interState = String(supplierState ?? '').trim() !== String(placeOfSupply ?? '').trim();
  if (interState) return { cgst: 0, sgst: 0, igst: total, interState: true };
  // Half, rounded down, taken twice — then the remainder folded into both is
  // impossible, so a stray paisa stays with the total rather than splitting
  // unequally. In practice a rate is even and this never bites.
  const half = round2(Math.floor(total * 50) / 100);
  return { cgst: half, sgst: half, igst: 0, interState: false };
}

export interface GstInvoice {
  invoiceNo: string;
  issueDate: string;          // YYYY-MM-DD
  customerName: string;
  customerGstin: string;      // '' for B2C
  placeOfSupply: string;
  taxableValue: number;
  gstRate: number;
  cgst: number;
  sgst: number;
  igst: number;
  hsnSac: string;
  postCompletion: boolean;
}

/** MMYYYY, the format GSTN uses. */
export function periodOf(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(String(isoDate ?? ''));
  return m ? `${m[2]}${m[1]}` : '';
}

const invoiceValue = (i: GstInvoice) =>
  round2(Number(i.taxableValue) + Number(i.cgst) + Number(i.sgst) + Number(i.igst));

/**
 * GSTR-1 — outward supplies, invoice by invoice.
 *
 * The tables are not a stylistic choice; GSTN wants each supply in exactly one
 * of them, and which one is decided by two facts:
 *
 *   B2B    the recipient has a GSTIN. Reported invoice-by-invoice, because
 *          this is what feeds their input credit — an error here is the
 *          recipient's problem before it is yours.
 *   B2CL   no GSTIN, INTER-state, and invoice value above ₹2,50,000. Still
 *          invoice-by-invoice.
 *   B2CS   everything else, summarised by state and rate. Individually
 *          invisible, which is why the threshold above matters.
 *
 * NIL/exempt supplies are separated out. A completed unit is outside the levy
 * altogether, and reporting it as a taxable supply at 0% overstates turnover
 * against which credit is later apportioned.
 */
export function buildGstr1(invoices: GstInvoice[], supplierGstin: string) {
  const b2b: Record<string, unknown>[] = [];
  const b2cl: Record<string, unknown>[] = [];
  const b2csMap = new Map<string, { pos: string; rate: number; taxable: number; cgst: number; sgst: number; igst: number }>();
  const nil: GstInvoice[] = [];
  // Invoices nobody has recorded tax on. Counted, never reported as a supply.
  const unrecorded: GstInvoice[] = [];
  const hsnMap = new Map<string, { hsn: string; rate: number; taxable: number; cgst: number; sgst: number; igst: number; count: number }>();

  for (const inv of invoices) {
    const value = invoiceValue(inv);

    // Three states, and collapsing any two of them misreports the return.
    //
    //   nothing recorded — no taxable value and not a completed unit. Somebody
    //     has not got to this invoice yet. It belongs in NEITHER table: putting
    //     it in nil/exempt reports an exempt supply that was never exempt, and
    //     putting it in the taxable tables reports a supply at zero tax. It is
    //     surfaced by the preview's `untaxed` list instead, while there is
    //     still time to fix it.
    //   outside the levy — a completed unit, immovable property under
    //     Schedule III.
    //   genuinely nil-rated — a real taxable value at a zero rate, which is a
    //     different thing again and does belong in the exempt table.
    if (Number(inv.taxableValue) === 0 && !inv.postCompletion) {
      unrecorded.push(inv);
      continue;
    }
    if (inv.postCompletion || Number(inv.gstRate) === 0) {
      nil.push(inv);
      continue;
    }

    const h = `${inv.hsnSac}|${inv.gstRate}`;
    const hsn = hsnMap.get(h) ?? { hsn: inv.hsnSac, rate: Number(inv.gstRate), taxable: 0, cgst: 0, sgst: 0, igst: 0, count: 0 };
    hsn.taxable = round2(hsn.taxable + Number(inv.taxableValue));
    hsn.cgst = round2(hsn.cgst + Number(inv.cgst));
    hsn.sgst = round2(hsn.sgst + Number(inv.sgst));
    hsn.igst = round2(hsn.igst + Number(inv.igst));
    hsn.count += 1;
    hsnMap.set(h, hsn);

    if (inv.customerGstin) {
      b2b.push({
        ctin: inv.customerGstin,
        inum: inv.invoiceNo,
        idt: inv.issueDate,
        val: value,
        pos: inv.placeOfSupply,
        rt: Number(inv.gstRate),
        txval: Number(inv.taxableValue),
        camt: Number(inv.cgst), samt: Number(inv.sgst), iamt: Number(inv.igst),
      });
      continue;
    }

    const interState = Number(inv.igst) > 0;
    if (interState && value > 250000) {
      b2cl.push({
        inum: inv.invoiceNo, idt: inv.issueDate, val: value,
        pos: inv.placeOfSupply, rt: Number(inv.gstRate),
        txval: Number(inv.taxableValue), iamt: Number(inv.igst),
      });
      continue;
    }

    const key = `${inv.placeOfSupply}|${inv.gstRate}`;
    const row = b2csMap.get(key)
      ?? { pos: inv.placeOfSupply, rate: Number(inv.gstRate), taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    row.taxable = round2(row.taxable + Number(inv.taxableValue));
    row.cgst = round2(row.cgst + Number(inv.cgst));
    row.sgst = round2(row.sgst + Number(inv.sgst));
    row.igst = round2(row.igst + Number(inv.igst));
    b2csMap.set(key, row);
  }

  const totals = invoices.reduce((t, i) => ({
    taxableValue: round2(t.taxableValue + Number(i.taxableValue)),
    cgst: round2(t.cgst + Number(i.cgst)),
    sgst: round2(t.sgst + Number(i.sgst)),
    igst: round2(t.igst + Number(i.igst)),
  }), { taxableValue: 0, cgst: 0, sgst: 0, igst: 0 });

  return {
    gstin: supplierGstin,
    b2b,
    b2cl,
    b2cs: [...b2csMap.values()].map(r => ({
      sply_ty: r.igst > 0 ? 'INTER' : 'INTRA',
      pos: r.pos, typ: 'OE', rt: r.rate,
      txval: r.taxable, camt: r.cgst, samt: r.sgst, iamt: r.igst,
    })),
    // GSTN calls this hsn.data; the shape is what its offline tool ingests.
    hsn: [...hsnMap.values()].map(h => ({
      hsn_sc: h.hsn, rt: h.rate, txval: h.taxable,
      camt: h.cgst, samt: h.sgst, iamt: h.igst, num: h.count,
    })),
    nil: {
      count: nil.length,
      value: round2(nil.reduce((s, i) => s + invoiceValue(i), 0)),
      note: 'Completed units (outside the levy under Schedule III) and genuinely nil-rated supplies.',
    },
    // Named rather than folded into a table. A return that quietly reports an
    // untouched invoice as exempt is worse than one that leaves it out and says so.
    unrecorded: {
      count: unrecorded.length,
      invoiceNos: unrecorded.map(i => i.invoiceNo),
      note: 'No tax recorded. Excluded from every table — record the tax, then prepare again.',
    },
    totals,
    invoiceCount: invoices.length,
  };
}

/**
 * GSTR-3B — the summary return, and the one that carries the payment.
 *
 * Only table 3.1(a) is computed here: outward taxable supplies other than
 * zero-rated, nil-rated and exempt. Input tax credit (table 4) is deliberately
 * absent — it comes from purchases this system does not hold, and a 3B that
 * guessed at credit would understate the cash payable, which is the one number
 * on this form that leaves a bank account.
 */
export function buildGstr3b(invoices: GstInvoice[], supplierGstin: string) {
  const taxable = invoices.filter(i => !i.postCompletion && Number(i.gstRate) > 0);
  const outward = taxable.reduce((t, i) => ({
    txval: round2(t.txval + Number(i.taxableValue)),
    camt: round2(t.camt + Number(i.cgst)),
    samt: round2(t.samt + Number(i.sgst)),
    iamt: round2(t.iamt + Number(i.igst)),
  }), { txval: 0, camt: 0, samt: 0, iamt: 0 });

  // Same three-way distinction as GSTR-1: an invoice with nothing recorded is
  // not an exempt supply, and reporting it as one overstates exempt turnover
  // against which credit is later apportioned.
  const exempt = invoices.filter(i =>
    i.postCompletion || (Number(i.gstRate) === 0 && Number(i.taxableValue) > 0));
  const unrecorded = invoices.filter(i => Number(i.taxableValue) === 0 && !i.postCompletion);

  return {
    gstin: supplierGstin,
    sup_details: {
      // 3.1(a) — outward taxable supplies.
      osup_det: { ...outward, csamt: 0 },
      // 3.1(c) — other outward supplies: nil rated and exempt.
      osup_nil_exmp: {
        txval: round2(exempt.reduce((s, i) => s + Number(i.taxableValue), 0)),
      },
    },
    // 3.2 — of the inter-state supplies above, those made to unregistered
    // persons, broken down by state. GSTN cross-checks this against 3.1.
    inter_sup: {
      unreg_details: [...taxable
        .filter(i => Number(i.igst) > 0 && !i.customerGstin)
        .reduce((m, i) => {
          const r = m.get(i.placeOfSupply) ?? { pos: i.placeOfSupply, txval: 0, iamt: 0 };
          r.txval = round2(r.txval + Number(i.taxableValue));
          r.iamt = round2(r.iamt + Number(i.igst));
          return m.set(i.placeOfSupply, r);
        }, new Map<string, { pos: string; txval: number; iamt: number }>())
        .values()],
    },
    unrecordedCount: unrecorded.length,
    itc_elg: null,
    itcNote: 'Input tax credit is not computed: it comes from purchase records this system does not hold. '
           + 'Complete table 4 from your purchase register before filing.',
    totals: {
      taxableValue: outward.txval,
      cgst: outward.camt, sgst: outward.samt, igst: outward.iamt,
    },
    invoiceCount: invoices.length,
  };
}
