/**
 * HR write dispatcher + API-shape mappers. Same pattern as leadWrites: with the
 * API flag on, every mutation goes to the Fastify/Postgres backend (RLS+RBAC);
 * demo mode keeps the exact localStorage behavior. Readers use the mappers to
 * fold server rows into the SPA's Employee/AttendanceRecord/etc shapes.
 */
import { create, update, remove } from './db';
import type { Employee, AttendanceRecord, LeaveRequest, PayrollRun, PayrollItem } from '../types';
import {
  isApiEnabled,
  apiGetEmployees, apiCreateEmployee, apiUpdateEmployee, apiDeleteEmployee,
  apiGetAttendance, apiMarkAttendance, apiDeleteAttendance,
  apiGetLeaveRequests, apiCreateLeaveRequest, apiDecideLeaveRequest,
  apiGetPayrollRuns, apiCreatePayrollRun, apiProcessPayrollRun,
  type ApiEmployee, type ApiAttendance, type ApiLeaveRequest, type ApiPayrollRun,
} from './apiClient';

const day = (v: unknown) => String(v ?? '').slice(0, 10);

// ── Server row → SPA shape ───────────────────────────────────────────────────

export function mapEmployee(r: ApiEmployee, tenantId: string): Employee {
  return {
    id: r.id, tenantId, name: r.name, phone: r.phone, email: r.email || undefined,
    designation: r.designation, department: r.department, type: r.type as Employee['type'],
    projectId: r.projectId || undefined,
    monthlySalary: r.monthlySalary ?? undefined, dailyWage: r.dailyWage ?? undefined,
    joinDate: day(r.joinDate), active: r.active, userId: r.userId || undefined,
    createdAt: new Date().toISOString(),
    // Carried through, not dropped: without it the screen cannot tell a salary
    // it may not see from one that was never set.
    payHidden: r.payHidden,
  };
}

export function mapAttendance(r: ApiAttendance, tenantId: string): AttendanceRecord {
  return {
    id: r.id, tenantId, employeeId: r.employeeId, date: day(r.date),
    checkIn: r.checkIn, checkOut: r.checkOut || undefined,
    projectId: r.projectId || undefined, lat: r.lat ?? undefined, lng: r.lng ?? undefined,
    method: (r.method as AttendanceRecord['method']) || 'manual',
    createdAt: new Date().toISOString(),
  };
}

export function mapLeave(r: ApiLeaveRequest, tenantId: string): LeaveRequest {
  return {
    id: r.id, tenantId, employeeId: r.employeeId, type: r.type as LeaveRequest['type'],
    from: day(r.from), to: day(r.to), days: r.days, reason: r.reason || undefined,
    status: r.status as LeaveRequest['status'],
    decidedBy: r.decidedBy || undefined, decidedAt: r.decidedAt || undefined,
    createdAt: new Date().toISOString(),
    reasonHidden: r.reasonHidden,
  };
}

export function mapPayrollRun(r: ApiPayrollRun, tenantId: string): PayrollRun {
  return {
    id: r.id, tenantId, month: r.month, status: r.status as PayrollRun['status'],
    items: (r.items as PayrollItem[]) || [],
    processedBy: r.processedBy || undefined, processedAt: r.processedAt || undefined,
    createdAt: new Date().toISOString(),
    itemsHidden: r.itemsHidden,
    // Falls back to the array length so the demo path, which has no flags,
    // keeps counting the way it always did.
    itemCount: r.itemCount ?? ((r.items as PayrollItem[]) || []).length,
  };
}

/** API mode: one round of all four HR datasets, mapped to SPA shapes. */
export async function fetchHrData(tenantId: string): Promise<{
  employees: Employee[]; attendance: AttendanceRecord[]; leaves: LeaveRequest[]; payrollRuns: PayrollRun[];
} | null> {
  if (!isApiEnabled()) return null;
  const [emp, att, lv, pr] = await Promise.all([
    apiGetEmployees(), apiGetAttendance(), apiGetLeaveRequests(), apiGetPayrollRuns(),
  ]);
  return {
    employees: emp.map(e => mapEmployee(e, tenantId)),
    attendance: att.map(a => mapAttendance(a, tenantId)),
    leaves: lv.map(l => mapLeave(l, tenantId)),
    payrollRuns: pr.map(p => mapPayrollRun(p, tenantId)),
  };
}

// ── Mutations ────────────────────────────────────────────────────────────────

export async function createEmployee(data: Employee): Promise<Employee> {
  if (isApiEnabled()) {
    const r = await apiCreateEmployee({
      name: data.name, phone: data.phone, email: data.email || undefined,
      designation: data.designation, department: data.department, type: data.type,
      projectId: data.projectId, monthlySalary: data.monthlySalary, dailyWage: data.dailyWage,
      joinDate: data.joinDate,
    });
    return mapEmployee(r, data.tenantId);
  }
  return create<Employee>('employees', data);
}

export async function setEmployeeActive(emp: Employee, active: boolean): Promise<void> {
  if (isApiEnabled()) { await apiUpdateEmployee(emp.id, { active }); return; }
  update<Employee>('employees', emp.id, { active });
}

export async function deleteEmployee(emp: Employee): Promise<void> {
  if (isApiEnabled()) { await apiDeleteEmployee(emp.id); return; }
  remove('employees', emp.id);
}

export async function markAttendance(rec: AttendanceRecord): Promise<void> {
  if (isApiEnabled()) {
    await apiMarkAttendance({
      employeeId: rec.employeeId, date: rec.date, checkIn: rec.checkIn,
      projectId: rec.projectId, lat: rec.lat, lng: rec.lng, method: rec.method,
    });
    return;
  }
  create<AttendanceRecord>('attendance', rec);
}

export async function checkOutAttendance(rec: AttendanceRecord, checkOut: string): Promise<void> {
  if (isApiEnabled()) {
    // The server upserts per employee/day — resend check-in so it survives.
    await apiMarkAttendance({
      employeeId: rec.employeeId, date: rec.date, checkIn: rec.checkIn, checkOut,
      projectId: rec.projectId, lat: rec.lat, lng: rec.lng, method: rec.method,
    });
    return;
  }
  update<AttendanceRecord>('attendance', rec.id, { checkOut });
}

export async function removeAttendance(rec: AttendanceRecord): Promise<void> {
  if (isApiEnabled()) { await apiDeleteAttendance(rec.id); return; }
  remove('attendance', rec.id);
}

export async function createLeave(data: LeaveRequest): Promise<LeaveRequest> {
  if (isApiEnabled()) {
    const r = await apiCreateLeaveRequest({
      employeeId: data.employeeId, type: data.type, from: data.from, to: data.to,
      days: data.days, reason: data.reason,
    });
    return mapLeave(r, data.tenantId);
  }
  return create<LeaveRequest>('leaveRequests', data);
}

export async function decideLeave(req: LeaveRequest, approved: boolean, userId: string): Promise<void> {
  if (isApiEnabled()) { await apiDecideLeaveRequest(req.id, approved ? 'approved' : 'rejected'); return; }
  update<LeaveRequest>('leaveRequests', req.id, {
    status: approved ? 'approved' : 'rejected',
    decidedBy: userId, decidedAt: new Date().toISOString(),
  });
}

/** Upsert the month's draft (server ON CONFLICT keeps one run per month). */
export async function savePayrollDraft(tenantId: string, month: string, items: PayrollItem[], existing?: PayrollRun): Promise<void> {
  if (isApiEnabled()) { await apiCreatePayrollRun(month, items); return; }
  if (existing) update<PayrollRun>('payrollRuns', existing.id, { items });
  else create<PayrollRun>('payrollRuns', { id: '', tenantId, month, status: 'draft', items, createdAt: new Date().toISOString() });
}

export async function processPayrollRun(run: PayrollRun, userId: string): Promise<void> {
  if (isApiEnabled()) { await apiProcessPayrollRun(run.id); return; }
  update<PayrollRun>('payrollRuns', run.id, {
    status: 'processed', processedBy: userId, processedAt: new Date().toISOString(),
  });
}
