import PDFDocument from 'pdfkit';

/**
 * PDF rendering for documents that leave the building.
 *
 * A demand letter is not a screen — it is served on a buyer, quoted back in a
 * dispute, and in India attached to proceedings under RERA. Until now the
 * product could raise one and show it in a table, and that was all: there was
 * no rendering library anywhere in the codebase, so the one artefact the
 * customer actually receives could not be produced by the system that computed
 * it. Collections was retyping numbers into Word.
 *
 * pdfkit rather than a headless browser: this deploys as one Node process, and
 * a Chromium per PDF is 300 MB of RSS and a security surface for a page we
 * already control the content of. The trade-off is that layout is written, not
 * styled — which is why the helpers below exist.
 */

/** A4 at 72 dpi, and a margin wide enough for a window envelope. */
const PAGE = { size: 'A4' as const, margin: 56 };
const RULE = '#d4d4d8';
const INK = '#18181b';
const MUTED = '#71717a';

/**
 * Money, in a form the built-in fonts can actually draw.
 *
 * pdfkit's standard fonts are WinAnsi-encoded and have no ₹ (U+20B9) — the
 * glyph the entire Indian product uses. Embedding a Unicode font would fix the
 * symbol and add a megabyte of TTF to every deployment. The currency CODE is
 * the better answer: "INR 12,34,567.00" is what formal Indian invoices and
 * legal notices print anyway, it is unambiguous across the currencies this
 * product supports, and it needs no font at all.
 *
 * The locale still matters: Indian grouping is 12,34,567 rather than
 * 1,234,567, and getting that wrong on a payment demand looks like a typo in a
 * number the buyer is being asked to pay.
 */
export function pdfMoney(amount: number, currency = 'INR', locale = 'en-IN'): string {
  const n = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency, currencyDisplay: 'code',
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(n).replace(/ /g, ' ');
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

/** A date a lawyer would accept: unambiguous, no numeric month order to guess. */
export function pdfDate(value: string | Date | null | undefined, locale = 'en-IN'): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Strip anything the standard fonts cannot draw.
 *
 * Tenant names, project names and customer names are user data and may contain
 * Devanagari, a curly quote pasted from Word, or an emoji. pdfkit throws on a
 * glyph WinAnsi has no code for, which would turn one unusual customer name
 * into a 500 on a document the builder is legally required to serve. Losing a
 * character is bad; failing to produce the letter at all is worse.
 */
function winAnsi(text: string): string {
  return (text ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/₹/g, 'INR ')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x09\x0a\x20-\x7e\xa0-\xff]/g, '');
}

export interface DocRow { label: string; value: string; strong?: boolean }

export interface LetterSpec {
  /** Masthead — who is sending this. */
  from: { name: string; address?: string; email?: string; phone?: string };
  title: string;
  /** "Letter No. 14 · 26 Aug 2026" — the reference a reply will quote. */
  reference: string;
  to: { name: string; lines?: string[] };
  /** Paragraphs before the figures. */
  intro: string[];
  /** The figures, as label/value pairs. `strong` marks the amount due. */
  rows: DocRow[];
  /** Paragraphs after the figures — terms, consequences, how to pay. */
  outro: string[];
  footer?: string;
}

/**
 * Render a formal letter and resolve with the finished bytes.
 *
 * Buffered rather than piped to the reply: a PDF's cross-reference table is
 * written last, so a stream that fails midway produces a file that opens to an
 * error rather than nothing. Buffering also lets the route set Content-Length,
 * which is what makes the browser show a progress bar instead of a spinner.
 * These documents are two pages; the memory is not the constraint.
 */
export function renderLetter(spec: LetterSpec): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ ...PAGE, info: { Title: spec.title, Author: spec.from.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // ── Masthead ────────────────────────────────────────────────────────────
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(winAnsi(spec.from.name), left, doc.y);
    const contact = [spec.from.address, [spec.from.email, spec.from.phone].filter(Boolean).join('  ·  ')]
      .filter(Boolean).join('\n');
    if (contact) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(winAnsi(contact), { width });
    doc.moveDown(0.8);
    doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(1).strokeColor(RULE).stroke();
    doc.moveDown(1.2);

    // ── Title and reference ─────────────────────────────────────────────────
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(winAnsi(spec.title), { width });
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(winAnsi(spec.reference), { width });
    doc.moveDown(1);

    // ── Addressee ───────────────────────────────────────────────────────────
    doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold').text('TO', { width });
    doc.fillColor(INK).fontSize(10.5).font('Helvetica-Bold').text(winAnsi(spec.to.name), { width });
    for (const line of spec.to.lines ?? []) {
      doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(winAnsi(line), { width });
    }
    doc.moveDown(1);

    // ── Body ────────────────────────────────────────────────────────────────
    doc.fillColor(INK).font('Helvetica').fontSize(10.5);
    for (const p of spec.intro) { doc.text(winAnsi(p), { width, align: 'justify' }); doc.moveDown(0.6); }

    // ── Figures ─────────────────────────────────────────────────────────────
    // A two-column block rather than a table: the values are the point, and a
    // ruled grid around six numbers reads as a spreadsheet, not a demand.
    doc.moveDown(0.3);
    const labelW = width * 0.58;
    for (const row of spec.rows) {
      const y = doc.y;
      doc.font(row.strong ? 'Helvetica-Bold' : 'Helvetica')
         .fontSize(row.strong ? 11 : 10)
         .fillColor(row.strong ? INK : MUTED)
         .text(winAnsi(row.label), left, y, { width: labelW });
      doc.font(row.strong ? 'Helvetica-Bold' : 'Helvetica')
         .fillColor(INK)
         .text(winAnsi(row.value), left + labelW, y, { width: width - labelW, align: 'right' });
      doc.moveDown(0.45);
      if (row.strong) {
        doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.8).strokeColor(RULE).stroke();
        doc.moveDown(0.5);
      }
    }
    doc.moveDown(0.8);

    // ── Terms ───────────────────────────────────────────────────────────────
    doc.font('Helvetica').fontSize(10.5).fillColor(INK);
    for (const p of spec.outro) { doc.text(winAnsi(p), left, doc.y, { width, align: 'justify' }); doc.moveDown(0.6); }

    doc.moveDown(1.5);
    doc.font('Helvetica').fontSize(10.5).fillColor(INK).text('For ' + winAnsi(spec.from.name), { width });
    doc.moveDown(2.2);
    doc.fontSize(9).fillColor(MUTED).text('Authorised Signatory', { width });

    if (spec.footer) {
      doc.moveDown(1.5);
      doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).strokeColor(RULE).stroke();
      doc.moveDown(0.5);
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(winAnsi(spec.footer), { width, align: 'center' });
    }

    doc.end();
  });
}
