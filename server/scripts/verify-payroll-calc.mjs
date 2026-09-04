/**
 * The arithmetic between gross and net.
 *
 * WHAT THIS IS FOR
 *
 * Payroll produced one number — gross — and called it done. Between gross and
 * what leaves the bank account sit provident fund, state insurance,
 * professional tax and whatever the worker already drew as an advance. Each
 * has a rule that is easy to state and easy to get subtly wrong, and every
 * one of those mistakes lands on a real person's payslip.
 *
 * The three that would go wrong first, and do here:
 *
 *   PF is capped.   12% of basic, but on ₹15,000 at most. A senior on ₹65,000
 *                   contributes ₹1,800, not ₹7,800. Missing the ceiling
 *                   overstates the deduction more than fourfold.
 *   ESI is a cliff. At ₹21,000 gross it applies to the whole amount; at
 *                   ₹21,001 it does not apply at all. Treating it as a taper
 *                   quietly deducts from every salary in the workspace.
 *   A salary is a salary. Days present do not change it — that is what the
 *                   word means. Only unpaid leave does. Reducing a salaried
 *                   person by attendance turns them into a day worker.
 *
 * These run against the pure module, with no database and no HTTP, because a
 * rounding rule that is only exercised through five layers is a rule nobody
 * can check.
 */
import { computeLine, workingDaysIn, rupees, DEFAULT_RATES } from '../src/payroll.ts';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const NO_INPUT = { daysPresent: 0, workingDays: 26, overtimeHours: 0, unpaidLeaveDays: 0, advanceRecovery: 0 };
const staff = (salary, extra = {}) => ({ id: 'e1', name: 'Staffer', type: 'staff', monthlySalary: salary, ptMonthly: 0, ...extra });
const worker = (wage, extra = {}) => ({ id: 'e2', name: 'Mason', type: 'contract_worker', dailyWage: wage, ptMonthly: 0, ...extra });

// ── the PF ceiling ─────────────────────────────────────────────────────────
console.log('\n=== PF IS CAPPED AT THE STATUTORY WAGE, NOT THE SALARY ===');
const senior = computeLine(staff(65000), { ...NO_INPUT, daysPresent: 26 });
ok('a ₹65,000 salary contributes on ₹15,000, not on ₹65,000',
  senior.pfEmployee === 1800, String(senior.pfEmployee));
ok('and the employer matches the same capped figure',
  senior.pfEmployer === 1800, String(senior.pfEmployer));

const junior = computeLine(staff(12000), { ...NO_INPUT, daysPresent: 26 });
ok('below the ceiling it is 12% of the whole salary',
  junior.pfEmployee === 1440, String(junior.pfEmployee));

const optedOut = computeLine(staff(65000, { pfOpted: false }), { ...NO_INPUT, daysPresent: 26 });
ok('opting out removes both sides, not just the employee’s',
  optedOut.pfEmployee === 0 && optedOut.pfEmployer === 0,
  `${optedOut.pfEmployee}/${optedOut.pfEmployer}`);

// ── the ESI cliff ──────────────────────────────────────────────────────────
console.log('\n=== ESI IS A CLIFF, NOT A TAPER ===');
const under = computeLine(staff(21000), { ...NO_INPUT, daysPresent: 26 });
ok('at exactly ₹21,000 it applies to the whole gross',
  under.esiEmployee === rupees(21000 * 0.75 / 100), String(under.esiEmployee));
ok('and the employer pays 3.25% of the same',
  under.esiEmployer === rupees(21000 * 3.25 / 100), String(under.esiEmployer));

const over = computeLine(staff(21001), { ...NO_INPUT, daysPresent: 26 });
ok('one rupee above the ceiling it vanishes entirely — not tapers',
  over.esiEmployee === 0 && over.esiEmployer === 0,
  `${over.esiEmployee}/${over.esiEmployer}`);

// ── a salary is a salary ───────────────────────────────────────────────────
console.log('\n=== ATTENDANCE DOES NOT MOVE A SALARY. UNPAID LEAVE DOES ===');
const present20 = computeLine(staff(52000), { ...NO_INPUT, daysPresent: 20 });
const present26 = computeLine(staff(52000), { ...NO_INPUT, daysPresent: 26 });
ok('twenty days present and twenty-six pay the same salary',
  present20.gross === present26.gross && present20.gross === 52000,
  `${present20.gross} vs ${present26.gross}`);

const twoUnpaid = computeLine(staff(52000), { ...NO_INPUT, daysPresent: 24, unpaidLeaveDays: 2 });
ok('two unpaid days come off at the per-working-day rate',
  twoUnpaid.gross === 52000 - rupees(2 * 52000 / 26), String(twoUnpaid.gross));
ok('and the payslip says why',
  /2 unpaid days/.test(twoUnpaid.basis), twoUnpaid.basis);

// ── a day worker is paid for days ──────────────────────────────────────────
console.log('\n=== A CONTRACT WORKER IS PAID FOR DAYS WORKED ===');
const mason = computeLine(worker(800), { ...NO_INPUT, daysPresent: 22 });
ok('22 days × ₹800', mason.gross === 17600, String(mason.gross));
ok('and the basis reads as a person would write it',
  mason.basis === '22 days × 800', mason.basis);
const absent = computeLine(worker(800), { ...NO_INPUT, daysPresent: 0 });
ok('no days marked is no pay — attendance IS the wage here',
  absent.gross === 0, String(absent.gross));

// ── overtime ───────────────────────────────────────────────────────────────
console.log('\n=== OVERTIME IS PAID AT TWICE THE ORDINARY HOURLY RATE ===');
const ot = computeLine(worker(800), { ...NO_INPUT, daysPresent: 22, overtimeHours: 10 });
ok('₹800 a day is ₹100 an hour, so ten hours at 2× is ₹2,000',
  ot.overtimePay === 2000, String(ot.overtimePay));
ok('and it is added to gross', ot.gross === 17600 + 2000, String(ot.gross));
ok('the basis mentions it', /10h overtime/.test(ot.basis), ot.basis);

const otStaff = computeLine(staff(52000), { ...NO_INPUT, daysPresent: 26, overtimeHours: 4 });
ok('a salaried person’s hourly rate comes from the working month',
  otStaff.overtimePay === rupees(4 * (52000 / 26 / 8) * 2), String(otStaff.overtimePay));

// ── advances ───────────────────────────────────────────────────────────────
console.log('\n=== AN ADVANCE COMES OFF THE PAY, AND NEVER MORE THAN THE PAY ===');
const withAdv = computeLine(worker(800), { ...NO_INPUT, daysPresent: 22, advanceRecovery: 5000 });
ok('₹5,000 drawn is ₹5,000 recovered', withAdv.advanceRecovery === 5000, String(withAdv.advanceRecovery));
ok('and net is gross less every deduction',
  withAdv.net === withAdv.gross - withAdv.deductions,
  `${withAdv.net} vs ${withAdv.gross} - ${withAdv.deductions}`);

const huge = computeLine(worker(800), { ...NO_INPUT, daysPresent: 2, advanceRecovery: 50000 });
ok('an advance larger than the month’s pay is capped, not carried negative',
  huge.net === 0, String(huge.net));
ok('and never invoices the worker for having worked', huge.net >= 0, String(huge.net));
ok('recovering only what the pay could bear',
  huge.advanceRecovery <= huge.gross, `${huge.advanceRecovery} of ${huge.gross}`);

// ── the identity that must always hold ─────────────────────────────────────
console.log('\n=== NET ALWAYS EQUALS GROSS MINUS THE PRINTED DEDUCTIONS ===');
const cases = [
  computeLine(staff(65000, { ptMonthly: 200 }), { ...NO_INPUT, daysPresent: 26, overtimeHours: 3, advanceRecovery: 1200 }),
  computeLine(worker(950, { ptMonthly: 175 }), { ...NO_INPUT, daysPresent: 19, overtimeHours: 7, advanceRecovery: 3000 }),
  computeLine(staff(18500, { ptMonthly: 150 }), { ...NO_INPUT, daysPresent: 24, unpaidLeaveDays: 2, advanceRecovery: 900 }),
];
cases.forEach((c, i) => {
  const parts = c.pfEmployee + c.esiEmployee + c.professionalTax + c.advanceRecovery;
  ok(`case ${i + 1}: the four deductions add to the printed total`,
    parts === c.deductions, `${parts} vs ${c.deductions}`);
  ok(`case ${i + 1}: gross − deductions = net, to the rupee`,
    c.gross - c.deductions === c.net, `${c.gross} - ${c.deductions} = ${c.net}`);
  ok(`case ${i + 1}: every figure is a whole rupee`,
    [c.gross, c.net, c.deductions, c.pfEmployee, c.esiEmployee, c.employerCost].every(Number.isInteger),
    JSON.stringify([c.gross, c.net, c.deductions]));
});

console.log('\n=== THE EMPLOYER PAYS MORE THAN THE WORKFORCE RECEIVES ===');
const cost = computeLine(staff(18000), { ...NO_INPUT, daysPresent: 26 });
ok('employer cost is gross plus the employer’s own PF and ESI',
  cost.employerCost === cost.gross + cost.pfEmployer + cost.esiEmployer,
  `${cost.employerCost} vs ${cost.gross}+${cost.pfEmployer}+${cost.esiEmployer}`);
ok('which is strictly more than net', cost.employerCost > cost.net,
  `${cost.employerCost} vs ${cost.net}`);

// ── working days ───────────────────────────────────────────────────────────
console.log('\n=== A WORKING MONTH IS NOT THIRTY DAYS ===');
ok('February 2026 has 24 non-Sundays', workingDaysIn('2026-02') === 24, String(workingDaysIn('2026-02')));
ok('March 2026 has 26', workingDaysIn('2026-03') === 26, String(workingDaysIn('2026-03')));
ok('a leap February is counted as one', workingDaysIn('2024-02') === 25, String(workingDaysIn('2024-02')));
ok('nonsense falls back to 26 rather than dividing by zero',
  workingDaysIn('not-a-month') === 26, String(workingDaysIn('not-a-month')));

console.log('\n=== A ZERO DENOMINATOR CANNOT REACH THE ARITHMETIC ===');
const zeroDays = computeLine(staff(52000), { ...NO_INPUT, workingDays: 0, unpaidLeaveDays: 1 });
ok('workingDays 0 does not produce Infinity',
  Number.isFinite(zeroDays.gross) && zeroDays.gross > 0, String(zeroDays.gross));

console.log('\n=== THE DEFAULT RATES ARE THE STATUTORY ONES ===');
ok('PF 12%, ceiling ₹15,000',
  DEFAULT_RATES.pfEmployeePct === 12 && DEFAULT_RATES.pfWageCeiling === 15000);
ok('ESI 0.75/3.25, ceiling ₹21,000',
  DEFAULT_RATES.esiEmployeePct === 0.75 && DEFAULT_RATES.esiEmployerPct === 3.25
  && DEFAULT_RATES.esiWageCeiling === 21000);
ok('overtime at 2×', DEFAULT_RATES.overtimeMultiple === 2);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
