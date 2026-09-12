import { useState } from 'react';
import { X, Loader2, ShieldCheck, Landmark, Briefcase } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiUpdateEmployee } from '../services/apiClient';
import type { Employee } from '../types';

/**
 * Change what is recorded about one person.
 *
 * WHY THIS EXISTS
 *
 * The HR page could add an employee, switch them active/inactive, and delete
 * them. That was all. There was no way to give somebody a raise, correct a
 * misspelt designation, move them to another site, or record the bank account
 * their salary is paid into — `apiUpdateEmployee` had existed the whole time
 * and was only ever called with `{ active }`.
 *
 * So the panel could hire and fire and nothing in between, which is most of
 * what an HR desk actually does.
 *
 * THE STATUTORY HALF
 *
 * UAN, ESIC, PAN, bank account and IFSC are not decoration: without them a PF
 * return cannot be filed and a salary cannot be transferred. Payroll would
 * compute a perfect net figure that nobody could pay.
 *
 * Aadhaar is LAST FOUR DIGITS ONLY. Four digits confirm which person a bank
 * line refers to; the full number would put a UIDAI-regulated identifier in
 * every backup for no working benefit.
 *
 * Only what CHANGED is sent. A PATCH carrying every field would overwrite a
 * colleague's concurrent edit with the values this form happened to load.
 */

interface Props {
  employee: Employee;
  currency: string;
  projects: { id: string; name: string }[];
  /** Company-wide HR may move somebody between sites; a site manager may not. */
  canMoveSite: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const label = 'block text-[11px] font-semibold text-zinc-500 uppercase mb-1';
const input = 'w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30';

export default function EmployeeEditDrawer({ employee, currency, projects, canMoveSite, onClose, onSaved }: Props) {
  const e = employee;
  const isWorker = employee.type === 'contract_worker';

  const [form, setForm] = useState({
    designation: employee.designation ?? '',
    department: employee.department ?? '',
    projectId: employee.projectId ?? '',
    pay: String((isWorker ? employee.dailyWage : employee.monthlySalary) ?? ''),
    uan: e.uan ?? '',
    esicNumber: e.esicNumber ?? '',
    pan: e.pan ?? '',
    aadhaarLast4: e.aadhaarLast4 ?? '',
    bankAccount: e.bankAccount ?? '',
    bankIfsc: e.bankIfsc ?? '',
    pfOpted: e.pfOpted !== false,
    ptMonthly: String(e.ptMonthly ?? 0),
  });
  const [saving, setSaving] = useState(false);

  const set = (k: keyof typeof form) => (v: string | boolean) => setForm(f => ({ ...f, [k]: v }));

  const save = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setSaving(true);
    try {
      // Only the fields that actually moved. Sending the whole form would
      // clobber a concurrent edit with stale values this drawer loaded.
      const patch: Parameters<typeof apiUpdateEmployee>[1] = {};
      if (form.designation !== (employee.designation ?? '')) patch.designation = form.designation;
      if (form.department !== (employee.department ?? '')) patch.department = form.department;
      if (canMoveSite && form.projectId && form.projectId !== (employee.projectId ?? '')) {
        patch.projectId = form.projectId;
      }
      const pay = Number(form.pay);
      if (form.pay !== '' && Number.isFinite(pay)) {
        const current = (isWorker ? employee.dailyWage : employee.monthlySalary) ?? null;
        if (pay !== current) {
          if (isWorker) patch.dailyWage = pay; else patch.monthlySalary = pay;
        }
      }
      for (const k of ['uan', 'esicNumber', 'pan', 'aadhaarLast4', 'bankAccount', 'bankIfsc'] as const) {
        if (form[k] !== (e[k] ?? '')) patch[k] = form[k];
      }
      if (form.pfOpted !== (e.pfOpted !== false)) patch.pfOpted = form.pfOpted;
      const pt = Number(form.ptMonthly);
      if (Number.isFinite(pt) && pt !== (e.ptMonthly ?? 0)) patch.ptMonthly = pt;

      if (Object.keys(patch).length === 0) { toast('Nothing changed'); onClose(); return; }

      await apiUpdateEmployee(employee.id, patch);
      toast.success(`${employee.name} updated`);
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save those changes');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-zinc-900/30" onClick={onClose}>
      <form
        onSubmit={save} onClick={ev => ev.stopPropagation()}
        className="w-full max-w-md h-full bg-white shadow-xl overflow-y-auto"
      >
        <div className="sticky top-0 bg-white border-b border-zinc-100 px-5 py-4 flex items-start gap-3">
          <div className="flex-1">
            <h2 className="font-semibold text-zinc-900">{employee.name}</h2>
            <p className="text-[11px] text-zinc-500">
              {isWorker ? 'Contract worker — paid by the day' : 'Staff — monthly salary'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-400">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-6">
          <section className="space-y-3">
            <h3 className="text-xs font-semibold text-zinc-700 flex items-center gap-1.5">
              <Briefcase className="h-3.5 w-3.5 text-zinc-400" /> Role and pay
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Designation</label>
                <input value={form.designation} onChange={ev => set('designation')(ev.target.value)}
                  className={input} placeholder="Site Supervisor" />
              </div>
              <div>
                <label className={label}>Department</label>
                <input value={form.department} onChange={ev => set('department')(ev.target.value)}
                  className={input} placeholder="Execution" />
              </div>
              <div>
                <label className={label}>
                  {isWorker ? `Daily wage (${currency})` : `Monthly salary (${currency})`}
                </label>
                <input type="number" min="0" value={form.pay} onChange={ev => set('pay')(ev.target.value)}
                  className={input} />
              </div>
              <div>
                <label className={label}>Site</label>
                <select
                  value={form.projectId} onChange={ev => set('projectId')(ev.target.value)}
                  disabled={!canMoveSite} className={`${input} disabled:opacity-60`}
                >
                  <option value="">Head office</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {!canMoveSite && (
                  // Said plainly rather than left as a mysteriously dead control.
                  <p className="text-[10px] text-zinc-400 mt-1">
                    Moving somebody between sites needs company-wide HR.
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold text-zinc-700 flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-zinc-400" /> Statutory
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>UAN</label>
                <input value={form.uan} onChange={ev => set('uan')(ev.target.value.replace(/\D/g, '').slice(0, 12))}
                  className={input} placeholder="12 digits" inputMode="numeric" />
              </div>
              <div>
                <label className={label}>ESIC number</label>
                <input value={form.esicNumber} onChange={ev => set('esicNumber')(ev.target.value.replace(/\D/g, '').slice(0, 17))}
                  className={input} placeholder="17 digits" inputMode="numeric" />
              </div>
              <div>
                <label className={label}>PAN</label>
                <input value={form.pan} onChange={ev => set('pan')(ev.target.value.toUpperCase().slice(0, 10))}
                  className={`${input} uppercase`} placeholder="ABCDE1234F" />
              </div>
              <div>
                <label className={label}>Aadhaar — last 4</label>
                <input value={form.aadhaarLast4} onChange={ev => set('aadhaarLast4')(ev.target.value.replace(/\D/g, '').slice(0, 4))}
                  className={input} placeholder="1234" inputMode="numeric" />
                <p className="text-[10px] text-zinc-400 mt-1">Last four only, never the full number.</p>
              </div>
              <div>
                <label className={label}>Professional tax / month</label>
                <input type="number" min="0" value={form.ptMonthly} onChange={ev => set('ptMonthly')(ev.target.value)}
                  className={input} />
                <p className="text-[10px] text-zinc-400 mt-1">A state slab — differs by state.</p>
              </div>
              <div className="flex items-end pb-1">
                <label className="flex items-center gap-2 text-xs text-zinc-700">
                  <input type="checkbox" checked={form.pfOpted}
                    onChange={ev => set('pfOpted')(ev.target.checked)}
                    className="h-4 w-4 rounded border-zinc-300" />
                  Contributes to PF
                </label>
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold text-zinc-700 flex items-center gap-1.5">
              <Landmark className="h-3.5 w-3.5 text-zinc-400" /> Where the salary goes
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Bank account</label>
                <input value={form.bankAccount} onChange={ev => set('bankAccount')(ev.target.value.trim().slice(0, 34))}
                  className={input} placeholder="Account number" />
              </div>
              <div>
                <label className={label}>IFSC</label>
                <input value={form.bankIfsc} onChange={ev => set('bankIfsc')(ev.target.value.toUpperCase().slice(0, 11))}
                  className={`${input} uppercase`} placeholder="HDFC0001234" />
              </div>
            </div>
          </section>
        </div>

        <div className="sticky bottom-0 bg-white border-t border-zinc-100 px-5 py-3 flex gap-2">
          <button type="button" onClick={onClose}
            className="flex-1 px-4 py-2.5 bg-zinc-100 text-zinc-700 rounded-xl text-sm font-semibold hover:bg-zinc-200">
            Cancel
          </button>
          <button type="submit" disabled={saving}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </button>
        </div>
      </form>
    </div>
  );
}
