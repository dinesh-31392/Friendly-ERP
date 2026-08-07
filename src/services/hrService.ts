import { getByTenant } from './db';
import type { Employee, AttendanceRecord, LeaveRequest, PayrollItem } from '../types';

/** Local YYYY-MM-DD (not UTC — a 7am IST check-in must not land on yesterday). */
export function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function monthKey(d = new Date()): string {
  return todayKey(d).slice(0, 7);
}

export function attendanceFor(tenantId: string, date: string): AttendanceRecord[] {
  return getByTenant<AttendanceRecord>('attendance', tenantId).filter(a => a.date === date);
}

/** Days with a check-in during YYYY-MM `month` — drives contract-worker pay. */
export function presentDays(tenantId: string, employeeId: string, month: string): number {
  const seen = new Set(
    getByTenant<AttendanceRecord>('attendance', tenantId)
      .filter(a => a.employeeId === employeeId && a.date.startsWith(month))
      .map(a => a.date)
  );
  return seen.size;
}

export function pendingLeaves(tenantId: string): LeaveRequest[] {
  return getByTenant<LeaveRequest>('leaveRequests', tenantId).filter(l => l.status === 'pending');
}

/** Employees with an approved leave spanning `date`. */
export function onLeave(tenantId: string, date: string): Set<string> {
  return new Set(
    getByTenant<LeaveRequest>('leaveRequests', tenantId)
      .filter(l => l.status === 'approved' && l.from <= date && date <= l.to)
      .map(l => l.employeeId)
  );
}

/** Inclusive calendar days between two YYYY-MM-DD dates (min 1). */
export function leaveDays(from: string, to: string): number {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

/**
 * Gross pay lines for a month, from first principles the whole team can
 * verify: staff get their monthly salary; contract workers get daily wage ×
 * days present (from the attendance register). Inactive employees and anyone
 * with no pay basis are skipped.
 */
export function buildPayrollItems(tenantId: string, month: string): PayrollItem[] {
  return buildPayrollItemsFrom(
    getByTenant<Employee>('employees', tenantId),
    getByTenant<AttendanceRecord>('attendance', tenantId),
    month,
  );
}

/** Pure variant over in-memory arrays — used in API mode, where the page holds
 *  server-fetched employees/attendance instead of localStorage. */
export function buildPayrollItemsFrom(employees: Employee[], attendance: AttendanceRecord[], month: string): PayrollItem[] {
  const daysFor = (employeeId: string) =>
    new Set(attendance.filter(a => a.employeeId === employeeId && a.date.startsWith(month)).map(a => a.date)).size;
  return employees
    .filter(e => e.active)
    .map((e): PayrollItem | null => {
      if (e.type === 'staff' && e.monthlySalary && e.monthlySalary > 0) {
        return {
          employeeId: e.id, name: e.name, designation: e.designation, empType: e.type,
          basis: 'Monthly salary', gross: e.monthlySalary,
        };
      }
      if (e.type === 'contract_worker' && e.dailyWage && e.dailyWage > 0) {
        const days = daysFor(e.id);
        return {
          employeeId: e.id, name: e.name, designation: e.designation, empType: e.type,
          basis: `${days} day${days === 1 ? '' : 's'} × ${e.dailyWage}/day`,
          daysPresent: days, gross: days * e.dailyWage,
        };
      }
      return null;
    })
    .filter((x): x is PayrollItem => x !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}
