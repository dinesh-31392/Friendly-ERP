/**
 * Structured real-estate cost-sheet engine.
 *
 * Competitors (LeadRat, Sell.Do, In4Velocity) auto-generate a full cost sheet
 * from the unit + a rate card, instead of free-typing charges. This does the
 * same: Basic Sale Price (the unit price) + auto floor-rise + PLC + amenity
 * charges + IFMS, then GST on the construction value and stamp duty +
 * registration on the agreement value.
 *
 * The output is a plain QuotationCharge[] (label + amount), so it flows into
 * the existing quotation → booking → payment-schedule pipeline with no schema
 * change; the unit price stays the "base" and every computed line is a charge.
 *
 * Rates are per tenant (localStorage in demo mode; the same shape maps to a
 * server table later).
 */
import type { Unit, QuotationCharge } from '../types';

export interface CostSheetConfig {
  /** Floor-rise ₹/sqft applied per floor level (× unit area × floor number). */
  floorRiseRatePerSqft: number;
  /** Preferred-location charge ₹/sqft (× unit area) when the unit qualifies. */
  plcPerSqft: number;
  /** One-time amenity charges (flat). */
  carParkCharge: number;
  clubMembership: number;
  /** Interest-free maintenance security ₹/sqft (× unit area). */
  ifmsPerSqft: number;
  /** GST % on the construction value (BSP + floor rise + PLC). */
  gstPercent: number;
  /** Stamp duty % on the agreement value. */
  stampDutyPercent: number;
  /** Registration % on the agreement value. */
  registrationPercent: number;
}

export function defaultCostSheetConfig(): CostSheetConfig {
  return {
    floorRiseRatePerSqft: 50,
    plcPerSqft: 100,
    carParkCharge: 300000,
    clubMembership: 100000,
    ifmsPerSqft: 50,
    gstPercent: 5,
    stampDutyPercent: 6,
    registrationPercent: 1,
  };
}

const KEY = (tenantId: string) => `friendly_crm_costsheet_${tenantId}`;

export function getCostSheetConfig(tenantId: string): CostSheetConfig {
  if (!tenantId) return defaultCostSheetConfig();
  try {
    const raw = localStorage.getItem(KEY(tenantId));
    return raw ? { ...defaultCostSheetConfig(), ...JSON.parse(raw) } : defaultCostSheetConfig();
  } catch {
    return defaultCostSheetConfig();
  }
}

export function saveCostSheetConfig(tenantId: string, cfg: CostSheetConfig): void {
  if (tenantId) localStorage.setItem(KEY(tenantId), JSON.stringify(cfg));
}

export interface CostSheet {
  base: number;                 // Basic Sale Price (unit price)
  lines: QuotationCharge[];     // every non-base line (floor rise → registration)
  agreementValue: number;       // base + floor rise + PLC (the taxable/registrable value)
  gst: number;                  // output GST alone (statutory liability slice)
  taxes: number;                // GST + stamp + registration
  total: number;                // base + Σ lines
}

const r = (n: number) => Math.round(n);

/**
 * Build a structured cost sheet for a unit. `applyPlc` toggles the preferred-
 * location charge (a corner/park-facing unit); everything else is automatic
 * from the unit's area and floor.
 */
export function computeCostSheet(unit: Unit, cfg: CostSheetConfig, opts: { applyPlc?: boolean } = {}): CostSheet {
  const area = unit.area || 0;
  const base = unit.price || 0;

  const floorRise = r(cfg.floorRiseRatePerSqft * area * Math.max(0, unit.floorNumber));
  const plc = opts.applyPlc ? r(cfg.plcPerSqft * area) : 0;
  const ifms = r(cfg.ifmsPerSqft * area);

  // GST + stamp + registration apply to the construction/agreement value
  // (BSP + floor rise + PLC), not to amenity/IFMS lines.
  const agreementValue = base + floorRise + plc;
  const gst = r(agreementValue * cfg.gstPercent / 100);
  const stamp = r(agreementValue * cfg.stampDutyPercent / 100);
  const registration = r(agreementValue * cfg.registrationPercent / 100);

  const lines: QuotationCharge[] = [];
  if (floorRise > 0) lines.push({ label: `Floor rise (${unit.floorNumber} × ₹${cfg.floorRiseRatePerSqft}/sqft)`, amount: floorRise });
  if (plc > 0) lines.push({ label: `PLC — preferred location (₹${cfg.plcPerSqft}/sqft)`, amount: plc });
  if (cfg.carParkCharge > 0) lines.push({ label: 'Car parking', amount: cfg.carParkCharge });
  if (cfg.clubMembership > 0) lines.push({ label: 'Club membership', amount: cfg.clubMembership });
  if (ifms > 0) lines.push({ label: `IFMS (₹${cfg.ifmsPerSqft}/sqft)`, amount: ifms });
  if (gst > 0) lines.push({ label: `GST @ ${cfg.gstPercent}%`, amount: gst });
  if (stamp > 0) lines.push({ label: `Stamp duty @ ${cfg.stampDutyPercent}%`, amount: stamp });
  if (registration > 0) lines.push({ label: `Registration @ ${cfg.registrationPercent}%`, amount: registration });

  const total = base + lines.reduce((s, l) => s + l.amount, 0);
  return { base, lines, agreementValue, gst, taxes: gst + stamp + registration, total };
}
