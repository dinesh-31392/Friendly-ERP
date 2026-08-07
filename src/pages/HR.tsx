import { useState, useMemo, useEffect } from 'react';
import {
  UserCheck, Users, MapPin, CalendarDays, Wallet, Plus, X, Trash2,
  CheckCircle2, LogOut, Building2, AlertTriangle,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, logAudit } from '../services/db';
import { todayKey, monthKey, leaveDays, buildPayrollItemsFrom } from '../services/hrService';
import { isApiEnabled } from '../services/apiClient';
import * as hrWrites from '../services/hrWrites';
import { formatCurrency, formatCurrencyFull } from '../utils/format';
import type {
  Project, Employee, EmployeeType, AttendanceRecord, LeaveRequest, LeaveType,
  PayrollRun,
} from '../types';
import { DEPARTMENTS, LEAVE_TYPES } from '../types';
import toast from 'react-hot-toast';

type Tab = 'employees' | 'attendance' | 'leave' | 'payroll';

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'employees', label: 'Employees', icon: Users },
  { id: 'attendance', label: 'Attendance', icon: MapPin },
  { id: 'leave', label: 'Leave', icon: CalendarDays },
  { id: 'payroll', label: 'Payroll', icon: Wallet },
];

export default function HR() {
  const { user, tenant, hasPermission } = useAuth();
  const tenantId = tenant?.id || '';
  const currency = tenant?.currency || 'INR';
  const canManage = hasPermission('manage_hr');
  // Site engineers mark the crew register without holding full HR rights
  const canMark = canManage || hasPermission('manage_attendance');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  const [tab, setTab] = useState<Tab>('employees');
  const [showAddEmployee, setShowAddEmployee] = useState(false);
  const [showLeaveForm, setShowLeaveForm] = useState(false);
  const [attendanceDate, setAttendanceDate] = useState(todayKey());
  const [siteFilter, setSiteFilter] = useState('all');
  const [payrollMonth, setPayrollMonth] = useState(monthKey());
  const [checkingIn, setCheckingIn] = useState<string | null>(null);

  // API mode: the server is the source of truth for all four HR datasets;
  // localStorage stays the demo path AND the fallback if the API is down.
  const [apiData, setApiData] = useState<Awaited<ReturnType<typeof hrWrites.fetchHrData>>>(null);
  useEffect(() => {
    if (!isApiEnabled()) { setApiData(null); return; }
    let cancelled = false;
    hrWrites.fetchHrData(tenantId)
      .then(d => { if (!cancelled) setApiData(d); })
      .catch(() => {
        if (!cancelled) { setApiData(null); toast.error('API unreachable — showing local data', { id: 'api-fallback' }); }
      });
    return () => { cancelled = true; };
  }, [tenantId, refreshKey]);

  const employees = useMemo(
    () => (apiData?.employees ?? getByTenant<Employee>('employees', tenantId)).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [apiData, tenantId, refreshKey]
  );
  const projects = useMemo(() => getByTenant<Project>('projects', tenantId), [tenantId, refreshKey]);
  const allAttendance = useMemo(
    () => apiData?.attendance ?? getByTenant<AttendanceRecord>('attendance', tenantId),
    [apiData, tenantId, refreshKey]
  );
  const dayRecords = useMemo(() => allAttendance.filter(a => a.date === attendanceDate), [allAttendance, attendanceDate]);
  const leaves = useMemo(
    () => (apiData?.leaves ?? getByTenant<LeaveRequest>('leaveRequests', tenantId))
      .slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [apiData, tenantId, refreshKey]
  );
  const payrollRuns = useMemo(
    () => (apiData?.payrollRuns ?? getByTenant<PayrollRun>('payrollRuns', tenantId)).slice().sort((a, b) => b.month.localeCompare(a.month)),
    [apiData, tenantId, refreshKey]
  );
  const onLeaveToday = useMemo(
    () => new Set(leaves.filter(l => l.status === 'approved' && l.from <= attendanceDate && attendanceDate <= l.to).map(l => l.employeeId)),
    [leaves, attendanceDate]
  );

  const activeEmployees = employees.filter(e => e.active);
  const empName = (id: string) => employees.find(e => e.id === id)?.name || '—';
  const projectName = (id?: string) => projects.find(p => p.id === id)?.name || '—';
  const audit = (action: string, entity: string, entityId: string, details: string) => {
    if (user) logAudit({ tenantId, userId: user.id, userName: user.name, action, entity, entityId, details });
  };

  // KPIs
  const presentToday = allAttendance.filter(a => a.date === todayKey()).length;
  const pending = leaves.filter(l => l.status === 'pending').length;
  const contractCount = activeEmployees.filter(e => e.type === 'contract_worker').length;

  // ── Employees ──────────────────────────────────────────────────────────────
  const handleAddEmployee = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = (fd.get('name') as string)?.trim();
    const phone = (fd.get('phone') as string)?.trim();
    if (!name || !phone) { toast.error('Name and phone are required'); return; }
    const type = (fd.get('type') as EmployeeType) || 'staff';
    const pay = Number(fd.get('pay')) || 0;
    let created: Employee;
    try {
      created = await hrWrites.createEmployee({
        id: '', tenantId, name, phone,
        email: (fd.get('email') as string) || '',
        designation: (fd.get('designation') as string) || (type === 'staff' ? 'Staff' : 'Worker'),
        department: (fd.get('department') as string) || 'Other',
        type,
        projectId: (fd.get('projectId') as string) || undefined,
        monthlySalary: type === 'staff' ? pay : undefined,
        dailyWage: type === 'contract_worker' ? pay : undefined,
        joinDate: (fd.get('joinDate') as string) || todayKey(),
        active: true,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add the employee');
      return;
    }
    audit('create', 'employee', created.id, `Added ${type === 'staff' ? 'employee' : 'contract worker'} "${name}"`);
    setShowAddEmployee(false);
    refresh();
    toast.success('Employee added');
  };

  const toggleEmployee = async (emp: Employee) => {
    try { await hrWrites.setEmployeeActive(emp, !emp.active); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not update the employee'); return; }
    audit('update', 'employee', emp.id, `Marked "${emp.name}" ${emp.active ? 'inactive' : 'active'}`);
    refresh();
  };

  const deleteEmployee = async (emp: Employee) => {
    const hasHistory = allAttendance.some(a => a.employeeId === emp.id)
      || leaves.some(l => l.employeeId === emp.id);
    if (hasHistory) { toast.error('This person has attendance or leave history — mark them inactive instead'); return; }
    if (!confirm(`Delete "${emp.name}"?`)) return;
    try { await hrWrites.deleteEmployee(emp); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not delete the employee'); return; }
    audit('delete', 'employee', emp.id, `Deleted employee "${emp.name}"`);
    refresh();
    toast.success('Employee removed');
  };

  // ── Attendance ─────────────────────────────────────────────────────────────
  const recordFor = (employeeId: string) => dayRecords.find(a => a.employeeId === employeeId);

  const checkIn = (emp: Employee) => {
    if (recordFor(emp.id)) return;
    setCheckingIn(emp.id);
    const finish = async (lat?: number, lng?: number) => {
      try {
        await hrWrites.markAttendance({
          id: '', tenantId, employeeId: emp.id, date: attendanceDate,
          checkIn: new Date().toISOString(),
          projectId: emp.projectId,
          lat, lng,
          method: lat !== undefined ? 'geo' : 'manual',
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        setCheckingIn(null);
        toast.error(err instanceof Error ? err.message : 'Could not record the check-in');
        return;
      }
      audit('create', 'attendance', emp.id, `Checked in ${emp.name}${lat !== undefined ? ' (geo-tagged)' : ''} — ${attendanceDate}`);
      setCheckingIn(null);
      refresh();
      toast.success(`${emp.name} checked in${lat !== undefined ? ' · location stamped' : ''}`);
    };
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => finish(Number(pos.coords.latitude.toFixed(5)), Number(pos.coords.longitude.toFixed(5))),
        () => finish(),   // denied/unavailable → manual mark, still recorded
        { timeout: 4000, maximumAge: 60000 }
      );
    } else finish();
  };

  const checkOut = async (emp: Employee) => {
    const rec = recordFor(emp.id);
    if (!rec || rec.checkOut) return;
    try { await hrWrites.checkOutAttendance(rec, new Date().toISOString()); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not record the check-out'); return; }
    refresh();
    toast.success(`${emp.name} checked out`);
  };

  const undoAttendance = async (emp: Employee) => {
    const rec = recordFor(emp.id);
    if (!rec) return;
    try { await hrWrites.removeAttendance(rec); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not remove the entry'); return; }
    audit('delete', 'attendance', emp.id, `Removed attendance entry for ${emp.name} — ${attendanceDate}`);
    refresh();
  };

  // ── Leave ──────────────────────────────────────────────────────────────────
  const handleLeaveRequest = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const employeeId = fd.get('employeeId') as string;
    const from = fd.get('from') as string;
    const to = (fd.get('to') as string) || from;
    if (!employeeId || !from) { toast.error('Pick an employee and a start date'); return; }
    if (to < from) { toast.error('End date is before the start date'); return; }
    let created: LeaveRequest;
    try {
      created = await hrWrites.createLeave({
        id: '', tenantId, employeeId,
        type: (fd.get('type') as LeaveType) || 'casual',
        from, to, days: leaveDays(from, to),
        reason: (fd.get('reason') as string) || '',
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not submit the leave request');
      return;
    }
    audit('create', 'leave_request', created.id, `Leave requested for ${empName(employeeId)} (${created.days}d ${created.type})`);
    setShowLeaveForm(false);
    refresh();
    toast.success('Leave request submitted');
  };

  const decideLeave = async (req: LeaveRequest, approved: boolean) => {
    if (!user) return;
    try { await hrWrites.decideLeave(req, approved, user.id); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not update the leave request'); return; }
    audit('update', 'leave_request', req.id, `${approved ? 'Approved' : 'Rejected'} ${req.days}d ${req.type} leave for ${empName(req.employeeId)}`);
    refresh();
    toast.success(approved ? 'Leave approved' : 'Leave rejected');
  };

  // ── Payroll ────────────────────────────────────────────────────────────────
  const currentRun = payrollRuns.find(r => r.month === payrollMonth);

  const preparePayroll = async () => {
    const items = buildPayrollItemsFrom(employees, allAttendance, payrollMonth);
    if (items.length === 0) { toast.error('No active employees with a salary or wage set'); return; }
    if (currentRun && currentRun.status === 'processed') { toast.error('This month is already processed'); return; }
    try { await hrWrites.savePayrollDraft(tenantId, payrollMonth, items, currentRun); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not prepare the payroll draft'); return; }
    toast.success(currentRun ? 'Draft refreshed from latest attendance' : `Payroll draft prepared for ${payrollMonth}`);
    audit('create', 'payroll_run', payrollMonth, `Prepared payroll draft for ${payrollMonth} (${items.length} people)`);
    refresh();
  };

  const processPayroll = async () => {
    if (!currentRun || !user) return;
    if (!confirm(`Mark ${payrollMonth} payroll as processed? The run locks after this.`)) return;
    try { await hrWrites.processPayrollRun(currentRun, user.id); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not process the payroll'); return; }
    audit('update', 'payroll_run', currentRun.id, `Processed ${payrollMonth} payroll — ${formatCurrency(currentRun.items.reduce((s, i) => s + i.gross, 0), currency)} gross`);
    refresh();
    toast.success('Payroll processed');
  };

  const inputCls = 'w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20';
  const labelCls = 'block text-xs font-semibold text-zinc-500 uppercase mb-1';
  const fmtDate = (d?: string) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const fmtTime = (iso?: string) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div className="space-y-6 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">HR & Workforce</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Employees, site attendance, leave and payroll — office staff and site crews together.</p>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gradient-to-br from-indigo-500 to-violet-600 rounded-2xl p-4 text-white">
          <div className="flex items-center gap-2 mb-2">
            <UserCheck className="h-5 w-5 text-indigo-200" />
            <span className="text-xs font-medium text-indigo-200">Present Today</span>
          </div>
          <p className="text-3xl font-bold">{presentToday}<span className="text-lg font-semibold text-indigo-200">/{activeEmployees.length}</span></p>
          <p className="text-xs text-indigo-200 mt-1">{todayKey() === attendanceDate ? 'live register' : `viewing ${fmtDate(attendanceDate)}`}</p>
        </div>
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Users className="h-5 w-5 text-zinc-400" />
            <span className="text-xs font-medium text-zinc-500">Workforce</span>
          </div>
          <p className="text-2xl font-bold text-zinc-900">{activeEmployees.length}</p>
          <p className="text-xs text-zinc-500 mt-1">{contractCount} on contract</p>
        </div>
        <div className={`rounded-2xl border p-4 ${pending > 0 ? 'bg-amber-50/60 border-amber-200' : 'bg-white border-zinc-200/60'}`}>
          <div className="flex items-center gap-2 mb-2">
            <CalendarDays className={`h-5 w-5 ${pending > 0 ? 'text-amber-500' : 'text-zinc-400'}`} />
            <span className={`text-xs font-medium ${pending > 0 ? 'text-amber-600' : 'text-zinc-500'}`}>Leave Requests</span>
          </div>
          <p className={`text-2xl font-bold ${pending > 0 ? 'text-amber-600' : 'text-zinc-900'}`}>{pending}</p>
          <p className={`text-xs mt-1 ${pending > 0 ? 'text-amber-500' : 'text-zinc-500'}`}>{pending > 0 ? 'awaiting a decision' : 'all decided'}</p>
        </div>
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Wallet className="h-5 w-5 text-zinc-400" />
            <span className="text-xs font-medium text-zinc-500">Last Payroll</span>
          </div>
          <p className="text-2xl font-bold text-zinc-900">
            {payrollRuns[0] ? formatCurrency(payrollRuns[0].items.reduce((s, i) => s + i.gross, 0), currency) : '—'}
          </p>
          <p className="text-xs text-zinc-500 mt-1">{payrollRuns[0] ? `${payrollRuns[0].month} · ${payrollRuns[0].status}` : 'no runs yet'}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-white border border-zinc-200 rounded-xl p-1 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${tab === t.id ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}
          >
            <t.icon className="h-4 w-4" /> {t.label}
            {t.id === 'leave' && pending > 0 && (
              <span className={`text-[10px] font-bold px-1.5 rounded-full ${tab === 'leave' ? 'bg-white/20' : 'bg-amber-100 text-amber-700'}`}>{pending}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Employees ── */}
      {tab === 'employees' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-3">
            <h3 className="font-semibold text-zinc-900">Employee Records</h3>
            <div className="flex-1" />
            {canManage && (
              <button onClick={() => setShowAddEmployee(true)} className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors">
                <Plus className="h-3.5 w-3.5" /> Add Person
              </button>
            )}
          </div>
          {employees.length === 0 ? (
            <div className="py-16 text-center">
              <Users className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">No employee records yet. Add office staff and site crews to run attendance and payroll.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-zinc-50/30 border-b border-zinc-100">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Name</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase hidden md:table-cell">Department</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase hidden sm:table-cell">Site</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Pay</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {employees.map(emp => (
                    <tr key={emp.id} className="border-b border-zinc-50 hover:bg-zinc-50/30 transition-colors">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-zinc-900">{emp.name}</p>
                        <p className="text-[11px] text-zinc-500">
                          {emp.designation}
                          <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold ${emp.type === 'staff' ? 'bg-indigo-50 text-indigo-600' : 'bg-amber-50 text-amber-700'}`}>
                            {emp.type === 'staff' ? 'Staff' : 'Contract'}
                          </span>
                        </p>
                      </td>
                      <td className="px-4 py-3 text-sm text-zinc-600 hidden md:table-cell">{emp.department}</td>
                      <td className="px-4 py-3 text-sm text-zinc-600 hidden sm:table-cell">{emp.projectId ? projectName(emp.projectId) : 'Head office'}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-zinc-900 text-right">
                        {emp.type === 'staff'
                          ? (emp.monthlySalary ? `${formatCurrency(emp.monthlySalary, currency)}/mo` : '—')
                          : (emp.dailyWage ? `${formatCurrencyFull(emp.dailyWage, currency)}/day` : '—')}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          disabled={!canManage}
                          onClick={() => toggleEmployee(emp)}
                          className={`text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors ${emp.active ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-500'} ${canManage ? 'cursor-pointer hover:opacity-80' : ''}`}
                        >{emp.active ? 'active' : 'inactive'}</button>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {canManage && (
                          <button onClick={() => deleteEmployee(emp)} className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 transition-colors">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Attendance ── */}
      {tab === 'attendance' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-3 flex-wrap">
            <h3 className="font-semibold text-zinc-900">Attendance Register</h3>
            <div className="flex-1" />
            <select value={siteFilter} onChange={e => setSiteFilter(e.target.value)} className="px-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs">
              <option value="all">All locations</option>
              <option value="office">Head office</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input type="date" value={attendanceDate} max={todayKey()} onChange={e => setAttendanceDate(e.target.value)} className="px-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs" />
          </div>
          {activeEmployees.length === 0 ? (
            <div className="py-16 text-center">
              <MapPin className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">Add employees first — then mark the daily register here, geo-stamped on site.</p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-50">
              {activeEmployees
                .filter(e => siteFilter === 'all' || (siteFilter === 'office' ? !e.projectId : e.projectId === siteFilter))
                .map(emp => {
                  const rec = recordFor(emp.id);
                  const away = onLeaveToday.has(emp.id);
                  return (
                    <div key={emp.id} className="flex items-center gap-3 px-5 py-3">
                      <div className={`h-9 w-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${rec ? 'bg-emerald-100 text-emerald-700' : away ? 'bg-amber-100 text-amber-700' : 'bg-zinc-100 text-zinc-500'}`}>
                        {emp.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-zinc-900 truncate">{emp.name}</p>
                        <p className="text-[11px] text-zinc-500 flex items-center gap-1.5">
                          <Building2 className="h-3 w-3" /> {emp.projectId ? projectName(emp.projectId) : 'Head office'}
                          {rec && (
                            <span className="text-emerald-600 font-medium">
                              · in {fmtTime(rec.checkIn)}{rec.checkOut ? ` — out ${fmtTime(rec.checkOut)}` : ''}
                              {rec.lat !== undefined && <span title={`${rec.lat}, ${rec.lng}`}> · 📍 geo</span>}
                            </span>
                          )}
                          {away && !rec && <span className="text-amber-600 font-medium">· on approved leave</span>}
                        </p>
                      </div>
                      {canMark && !rec && (
                        <button
                          onClick={() => checkIn(emp)}
                          disabled={checkingIn === emp.id}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors disabled:opacity-50"
                        >
                          {checkingIn === emp.id ? 'Locating…' : 'Check In'}
                        </button>
                      )}
                      {canMark && rec && !rec.checkOut && (
                        <button onClick={() => checkOut(emp)} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors inline-flex items-center gap-1">
                          <LogOut className="h-3 w-3" /> Check Out
                        </button>
                      )}
                      {canMark && rec && (
                        <button onClick={() => undoAttendance(emp)} className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-300 hover:text-red-500 transition-colors" title="Remove entry">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {!canMark && (
                        <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${rec ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-500'}`}>
                          {rec ? 'Present' : away ? 'On leave' : 'Absent'}
                        </span>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}

      {/* ── Leave ── */}
      {tab === 'leave' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-3">
            <h3 className="font-semibold text-zinc-900">Leave Management</h3>
            <div className="flex-1" />
            {canManage && (
              <button onClick={() => setShowLeaveForm(true)} className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors">
                <Plus className="h-3.5 w-3.5" /> Request Leave
              </button>
            )}
          </div>
          {leaves.length === 0 ? (
            <div className="py-16 text-center">
              <CalendarDays className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">No leave requests yet.</p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-50">
              {leaves.map(req => (
                <div key={req.id} className="flex items-center gap-3 px-5 py-3 flex-wrap">
                  <div className="flex-1 min-w-[200px]">
                    <p className="text-sm font-medium text-zinc-900">{empName(req.employeeId)}</p>
                    <p className="text-[11px] text-zinc-500">
                      {LEAVE_TYPES.find(t => t.id === req.type)?.label} · {fmtDate(req.from)}{req.to !== req.from ? ` → ${fmtDate(req.to)}` : ''} · {req.days}d
                      {req.reason ? ` · ${req.reason}` : ''}
                    </p>
                  </div>
                  {req.status === 'pending' && canManage ? (
                    <div className="flex gap-1.5">
                      <button onClick={() => decideLeave(req, true)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors">Approve</button>
                      <button onClick={() => decideLeave(req, false)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-red-50 text-red-600 hover:bg-red-100 transition-colors">Reject</button>
                    </div>
                  ) : (
                    <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${
                      req.status === 'approved' ? 'bg-emerald-50 text-emerald-700' :
                      req.status === 'rejected' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'
                    }`}>{req.status}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Payroll ── */}
      {tab === 'payroll' && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-3 flex-wrap">
              <h3 className="font-semibold text-zinc-900">Payroll Run</h3>
              <div className="flex-1" />
              <input type="month" value={payrollMonth} max={monthKey()} onChange={e => setPayrollMonth(e.target.value)} className="px-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs" />
              {canManage && currentRun?.status !== 'processed' && (
                <button onClick={preparePayroll} className="px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors">
                  {currentRun ? 'Refresh Draft' : 'Prepare Payroll'}
                </button>
              )}
              {canManage && currentRun?.status === 'draft' && (
                <button onClick={processPayroll} className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 text-white rounded-xl text-xs font-semibold hover:bg-emerald-700 transition-colors">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Mark Processed
                </button>
              )}
            </div>
            {!currentRun ? (
              <div className="py-14 text-center">
                <Wallet className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
                <p className="text-sm text-zinc-500">No run for {payrollMonth} yet. Staff get their monthly salary; contract workers get daily wage × days present.</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-zinc-50/30 border-b border-zinc-100">
                        <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Person</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Basis</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Gross</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentRun.items.map(item => (
                        <tr key={item.employeeId} className="border-b border-zinc-50">
                          <td className="px-4 py-3">
                            <p className="text-sm font-medium text-zinc-900">{item.name}</p>
                            <p className="text-[11px] text-zinc-500">{item.designation}</p>
                          </td>
                          <td className="px-4 py-3 text-sm text-zinc-600">{item.basis}</td>
                          <td className="px-4 py-3 text-sm font-semibold text-zinc-900 text-right">{formatCurrencyFull(item.gross, currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-zinc-50/50">
                        <td className="px-4 py-3 text-sm font-bold text-zinc-900" colSpan={2}>
                          Total ({currentRun.items.length} people)
                          <span className={`ml-2 text-[10px] font-semibold px-2 py-0.5 rounded-full ${currentRun.status === 'processed' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                            {currentRun.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm font-bold text-zinc-900 text-right">
                          {formatCurrencyFull(currentRun.items.reduce((s, i) => s + i.gross, 0), currency)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {currentRun.status === 'draft' && (
                  <p className="px-5 py-3 text-[11px] text-zinc-400 border-t border-zinc-100 flex items-center gap-1.5">
                    <AlertTriangle className="h-3 w-3" /> Gross amounts only — statutory deductions are applied in your accounting system for now.
                  </p>
                )}
              </>
            )}
          </div>

          {payrollRuns.filter(r => r.month !== payrollMonth).length > 0 && (
            <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
              <div className="px-5 py-3 border-b border-zinc-100"><h3 className="font-semibold text-zinc-900 text-sm">Past Runs</h3></div>
              <div className="divide-y divide-zinc-50">
                {payrollRuns.filter(r => r.month !== payrollMonth).map(run => (
                  <button key={run.id} onClick={() => setPayrollMonth(run.month)} className="w-full flex items-center justify-between px-5 py-2.5 hover:bg-zinc-50/50 text-left">
                    <span className="text-sm text-zinc-700">{run.month} · {run.items.length} people</span>
                    <span className="text-sm font-semibold text-zinc-900">{formatCurrency(run.items.reduce((s, i) => s + i.gross, 0), currency)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Modals ── */}
      {showAddEmployee && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddEmployee(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Add Person</h3>
              <button onClick={() => setShowAddEmployee(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddEmployee} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Full Name *</label>
                  <input name="name" required placeholder="Suresh Patil" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Phone *</label>
                  <input name="phone" required placeholder="+91 98765 00000" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Type</label>
                  <select name="type" className={inputCls}>
                    <option value="staff">Staff (monthly salary)</option>
                    <option value="contract_worker">Contract worker (daily wage)</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Salary / Daily Wage ({currency})</label>
                  <input name="pay" type="number" min="0" placeholder="45000 or 800" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Designation</label>
                  <input name="designation" placeholder="Site Supervisor" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Department</label>
                  <select name="department" className={inputCls}>
                    {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Deployed At</label>
                  <select name="projectId" className={inputCls}>
                    <option value="">Head office</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Joining Date</label>
                  <input name="joinDate" type="date" defaultValue={todayKey()} className={inputCls} />
                </div>
                <div className="col-span-2">
                  <label className={labelCls}>Email</label>
                  <input name="email" type="email" placeholder="Optional" className={inputCls} />
                </div>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddEmployee(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Add Person</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showLeaveForm && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowLeaveForm(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Request Leave</h3>
              <button onClick={() => setShowLeaveForm(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleLeaveRequest} className="space-y-3">
              <div>
                <label className={labelCls}>Employee *</label>
                <select name="employeeId" required className={inputCls}>
                  <option value="">Select...</option>
                  {activeEmployees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Type</label>
                  <select name="type" className={inputCls}>
                    {LEAVE_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </div>
                <div />
                <div>
                  <label className={labelCls}>From *</label>
                  <input name="from" type="date" required className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>To</label>
                  <input name="to" type="date" className={inputCls} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Reason</label>
                <input name="reason" placeholder="Optional" className={inputCls} />
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowLeaveForm(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Submit Request</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
