/**
 * What a person is paid, and what reaches their bank.
 *
 * The product computed one number — gross — and called it payroll. Between
 * gross and net an Indian construction payroll has to answer for overtime,
 * provident fund, state insurance, professional tax and whatever the worker
 * already drew as an advance. This module does that arithmetic and nothing
 * else: no database, no permissions, no HTTP. It is pure so it can be tested
 * against worked examples, which is the only way anyone will ever trust it.
 *
 * TWO KINDS OF PEOPLE, PAID TWO WAYS
 *
 *   staff             a monthly salary. Days present do not change it; that
 *                     is what a salary means. Unpaid leave does.
 *   contract_worker   days present × daily wage. Attendance IS the pay, and
 *                     a day not marked is a day not paid.
 *
 * ROUNDING
 *
 * Every money figure is rounded to whole rupees at the point it is computed,
 * not at the end. Payroll is paid in rupees, statutory returns are filed in
 * rupees, and carrying paise through six operations produces a net that does
 * not equal gross minus the printed deductions — which is the one thing a
 * payslip must never do.
 */

/** Whole rupees. Half-up, because that is what a payslip does. */
export const rupees = (n: number): number =>
  Math.round((Number.isFinite(n) ? n : 0) + Number.EPSILON);

export interface StatutoryRates {
  pfEmployeePct: number;
  pfEmployerPct: number;
  pfWageCeiling: number;
  esiEmployeePct: number;
  esiEmployerPct: number;
  esiWageCeiling: number;
  overtimeMultiple: number;
}

export const DEFAULT_RATES: StatutoryRates = {
  pfEmployeePct: 12, pfEmployerPct: 12, pfWageCeiling: 15000,
  esiEmployeePct: 0.75, esiEmployerPct: 3.25, esiWageCeiling: 21000,
  overtimeMultiple: 2,
};

export interface PayrollEmployee {
  id: string;
  name: string;
  designation?: string;
  type: 'staff' | 'contract_worker' | string;
  monthlySalary?: number | null;
  dailyWage?: number | null;
  /** Opted out of PF. Rare, and only lawful above the wage ceiling. */
  pfOpted?: boolean;
  /** Professional tax for this person's state, per month. */
  ptMonthly?: number | null;
  projectId?: string | null;
}

export interface PayrollInputs {
  daysPresent: number;
  /** Working days in the month — the denominator for a staff member's
   *  per-day rate. Never zero: a month with no working days would make the
   *  rate infinite and the deduction meaningless. */
  workingDays: number;
  overtimeHours: number;
  /** Unpaid-leave days. Deducted from a salary; irrelevant to a day rate,
   *  where an absent day is simply a day not counted. */
  unpaidLeaveDays: number;
  /** Outstanding advance recoverable THIS month. Already capped by the
   *  caller to what is actually outstanding. */
  advanceRecovery: number;
}

export interface PayrollLine {
  employeeId: string;
  name: string;
  designation: string;
  empType: string;
  projectId: string | null;
  /** Plain English: how gross was arrived at. It goes on the payslip. */
  basis: string;
  daysPresent: number;
  overtimeHours: number;

  basic: number;
  overtimePay: number;
  gross: number;

  pfEmployee: number;
  esiEmployee: number;
  professionalTax: number;
  advanceRecovery: number;
  unpaidLeaveDeduction: number;
  deductions: number;

  net: number;

  /** The employer's own liability. Never appears on a payslip, and is real
   *  money leaving the company. */
  pfEmployer: number;
  esiEmployer: number;
  employerCost: number;
}

/**
 * PF is levied on basic wage, capped at the statutory ceiling unless the
 * member has opted for the higher figure. Somebody on ₹65,000 contributes on
 * ₹15,000 — ₹1,800 — not on the whole salary. Getting this wrong overstates
 * the deduction by a factor of four on a senior salary.
 */
export function pfOn(basic: number, rates: StatutoryRates, opted: boolean): number {
  if (!opted) return 0;
  return rupees(Math.min(basic, rates.pfWageCeiling) * rates.pfEmployeePct / 100);
}

/**
 * ESI is a CLIFF, not a taper: at ₹21,000 gross it applies to the whole
 * amount, at ₹21,001 it does not apply at all. Treating it as a slab would
 * quietly deduct from every senior salary in the workspace.
 */
export function esiOn(gross: number, pct: number, rates: StatutoryRates): number {
  if (gross > rates.esiWageCeiling) return 0;
  return rupees(gross * pct / 100);
}

export function computeLine(
  emp: PayrollEmployee,
  inp: PayrollInputs,
  rates: StatutoryRates = DEFAULT_RATES,
): PayrollLine {
  const isWorker = emp.type === 'contract_worker';
  const workingDays = inp.workingDays > 0 ? inp.workingDays : 26;
  const daysPresent = Math.max(0, inp.daysPresent);
  const otHours = Math.max(0, inp.overtimeHours);

  // The per-hour rate overtime is a multiple of. An eight-hour day is the
  // basis in both cases — the Factories Act computes overtime on ordinary
  // hourly wages, and a monthly salary has to be reduced to a day and then an
  // hour before it can be one.
  let basic: number;
  let hourly: number;
  let basis: string;
  let unpaidLeaveDeduction = 0;

  if (isWorker) {
    const wage = emp.dailyWage ?? 0;
    basic = rupees(daysPresent * wage);
    hourly = wage / 8;
    basis = `${daysPresent} day${daysPresent === 1 ? '' : 's'} × ${wage}`;
  } else {
    const salary = emp.monthlySalary ?? 0;
    const perDay = salary / workingDays;
    // Unpaid leave is the only thing that moves a salary. Present days do not:
    // deducting for them would turn every salaried employee into a day worker.
    unpaidLeaveDeduction = rupees(Math.max(0, inp.unpaidLeaveDays) * perDay);
    basic = rupees(salary);
    hourly = perDay / 8;
    basis = inp.unpaidLeaveDays > 0
      ? `Monthly salary less ${inp.unpaidLeaveDays} unpaid day${inp.unpaidLeaveDays === 1 ? '' : 's'}`
      : 'Monthly salary';
  }

  const overtimePay = rupees(otHours * hourly * rates.overtimeMultiple);
  if (otHours > 0) basis += ` + ${otHours}h overtime`;

  // Gross is what was earned before anything is taken off — overtime included,
  // unpaid leave already removed, because a day not worked was never earned.
  const gross = Math.max(0, rupees(basic + overtimePay - unpaidLeaveDeduction));

  const pfEmployee = pfOn(basic - unpaidLeaveDeduction, rates, emp.pfOpted !== false);
  const pfEmployer = emp.pfOpted !== false
    ? rupees(Math.min(basic - unpaidLeaveDeduction, rates.pfWageCeiling) * rates.pfEmployerPct / 100)
    : 0;

  const esiEmployee = esiOn(gross, rates.esiEmployeePct, rates);
  const esiEmployer = esiOn(gross, rates.esiEmployerPct, rates);

  const professionalTax = rupees(emp.ptMonthly ?? 0);

  // An advance can only be recovered out of what is left. Recovering more
  // than the pay would produce a negative net — the company invoicing an
  // employee for having worked — so it is capped and the remainder stays
  // outstanding for next month.
  const beforeAdvance = gross - pfEmployee - esiEmployee - professionalTax;
  const advanceRecovery = rupees(
    Math.max(0, Math.min(Math.max(0, inp.advanceRecovery), Math.max(0, beforeAdvance))));

  const deductions = rupees(pfEmployee + esiEmployee + professionalTax + advanceRecovery);
  const net = Math.max(0, rupees(gross - deductions));

  return {
    employeeId: emp.id,
    name: emp.name,
    designation: emp.designation ?? '',
    empType: emp.type,
    projectId: emp.projectId ?? null,
    basis,
    daysPresent,
    overtimeHours: otHours,
    basic: rupees(basic - unpaidLeaveDeduction),
    overtimePay,
    gross,
    pfEmployee,
    esiEmployee,
    professionalTax,
    advanceRecovery,
    unpaidLeaveDeduction,
    deductions,
    net,
    pfEmployer,
    esiEmployer,
    employerCost: rupees(gross + pfEmployer + esiEmployer),
  };
}

export interface PayrollTotals {
  gross: number;
  deductions: number;
  net: number;
  employerCost: number;
  headcount: number;
}

export function totalsOf(lines: PayrollLine[]): PayrollTotals {
  return lines.reduce<PayrollTotals>((t, l) => ({
    gross: t.gross + l.gross,
    deductions: t.deductions + l.deductions,
    net: t.net + l.net,
    employerCost: t.employerCost + l.employerCost,
    headcount: t.headcount + 1,
  }), { gross: 0, deductions: 0, net: 0, employerCost: 0, headcount: 0 });
}

/**
 * Working days in a month, Sundays excluded.
 *
 * A default, not a policy: a builder with a six-day week and a floating
 * holiday list needs their own figure, and the route accepts one. What this
 * must never be is a hardcoded 30, which would under-state every salaried
 * per-day rate by a sixth and quietly under-deduct every unpaid day.
 */
export function workingDaysIn(month: string): number {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return 26;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let count = 0;
  for (let d = 1; d <= days; d++) {
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== 0) count++;
  }
  return count;
}
