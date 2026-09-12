/**
 * GST state codes — the first two digits of every GSTIN, and the value the
 * place-of-supply field carries.
 *
 * This is a statutory list, not a geography one. It decides whether a supply
 * splits into CGST+SGST or goes out as IGST, so the codes matter more than the
 * names: 27 is Maharashtra whatever the invoice calls it.
 *
 * For immovable property the place of supply is where the PROPERTY is — never
 * where the buyer lives. A Pune flat sold to a Bengaluru buyer is 27, and the
 * money belongs to Maharashtra.
 *
 * Two codes are deliberately absent from the picker because they are retired,
 * and offering them would let someone file against a state that no longer
 * exists for GST purposes:
 *   25  Daman & Diu — merged into 26 on 26 Jan 2020.
 *   28  Andhra Pradesh (pre-bifurcation) — current AP is 37.
 * Both are still recognised when they arrive on historical rows; `stateName`
 * resolves them rather than showing a bare number.
 */

export interface GstState { code: string; name: string }

/** Selectable places of supply, in code order — which is how GSTN lists them. */
export const GST_STATES: GstState[] = [
  { code: '01', name: 'Jammu & Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra & Nagar Haveli and Daman & Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman & Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
  { code: '97', name: 'Other Territory' },
];

/** Retired codes, kept only so historical rows read as a place and not a number. */
const RETIRED: Record<string, string> = {
  '25': 'Daman & Diu (retired 2020)',
  '28': 'Andhra Pradesh (pre-2014 code)',
  '99': 'Centre Jurisdiction',
};

export function stateName(code: string): string {
  const c = String(code ?? '').trim();
  return GST_STATES.find(s => s.code === c)?.name ?? RETIRED[c] ?? c ?? '';
}

/**
 * The rates that actually appear on a builder's invoice.
 *
 * 1% and 5% are the post-2019 residential rates and both come WITHOUT input
 * tax credit; 12% and 18% are the with-ITC and works-contract/service rates.
 * The list is deliberately short — a free-text rate box is how 0.5% typos and
 * 50% fat-fingers reach a return.
 */
export const GST_RATES: { rate: number; label: string }[] = [
  { rate: 1, label: '1% — affordable residential (no ITC)' },
  { rate: 5, label: '5% — other residential (no ITC)' },
  { rate: 12, label: '12% — with ITC' },
  { rate: 18, label: '18% — works contract / services' },
];

/** Construction of a residential complex. The default, and right most of the time. */
export const DEFAULT_SAC = '9954';
