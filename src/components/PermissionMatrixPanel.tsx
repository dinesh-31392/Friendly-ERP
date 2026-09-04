import { useState, useEffect, useMemo } from 'react';
import { Loader2, Check, Search, ShieldAlert } from 'lucide-react';
import { isApiEnabled, apiGetPermissionMatrix, type ApiPermissionMatrix } from '../services/apiClient';

/**
 * Every role, and what it actually grants.
 *
 * WHAT THIS REPLACES
 *
 * A hardcoded table: eighteen hand-written labels across four role columns,
 * written when the product had four roles and never revisited. A workspace now
 * has eleven roles and around eighty permission keys, so the screen showed an
 * administrator something that had not been true for a long time — no HR keys
 * at all, nothing for execution, procurement, land, business development,
 * leasing or accounts, and seven roles simply missing.
 *
 * That is worse than having no screen. This is the page somebody checks before
 * deciding a role is safe to hand a new colleague, and it was answering from
 * memory rather than from the database.
 *
 * Now read from role_permissions, so it cannot drift again: a permission added
 * in a migration appears here the moment it is granted.
 *
 * GROUPED BY MODULE, because eighty rows in key order is a list nobody reads.
 * The prefix after the verb is the module — view_hr, manage_hr and
 * manage_hr_all all belong together, and seeing them adjacent is what makes
 * "this role marks attendance but cannot see pay" legible at a glance.
 */

/** The module a key belongs to, derived from the key itself. */
function moduleOf(key: string): string {
  const k = key.replace(/^(view|manage|approve|create|send|use|signoff|schedule|add)_/, '');
  const MAP: Record<string, string> = {
    dashboard: 'General', settings: 'Workspace', tenant: 'Workspace', users: 'Workspace',
    team: 'Workspace', branch: 'Workspace', platform: 'Platform', audit_log: 'Workspace',
    approval_rules: 'Workspace',
    leads: 'Sales', own_leads: 'Sales', notes: 'Sales', visits: 'Sales',
    // assign_leads strips to 'leads' only if the verb list catches "assign";
    // it does, but the bare key is listed too so a future rename cannot
    // silently drop it into Other.
    assign_leads: 'Sales',
    sales_performance: 'Sales', campaigns: 'Marketing', ai_studio: 'Marketing',
    messages: 'Marketing', reminders: 'Marketing',
    inventory: 'Inventory', projects: 'Projects', bookings: 'Sales',
    quotations: 'Sales', discounts: 'Sales',
    hr: 'HR', hr_all: 'HR', attendance: 'HR',
    execution: 'Execution', change_orders: 'Execution', ra_bills: 'Execution',
    procurement: 'Procurement', purchase_orders: 'Procurement',
    accounts: 'Finance', finance: 'Finance', invoices: 'Finance',
    vendor_bills: 'Finance', owner_payouts: 'Finance',
    land: 'Land & BD', land_qualify: 'Land & BD', land_convert: 'Land & BD',
    bd: 'Land & BD', bd_handoff: 'Land & BD',
    leasing: 'Leasing', service: 'Service', brokers: 'Channel Partners',
    documents: 'Documents', calendar: 'Calendar', reports: 'Reports',
  };
  return MAP[k] ?? 'Other';
}

/** A key read as a person would say it: view_hr → "View HR". */
const pretty = (key: string) =>
  key.replace(/_/g, ' ')
     .replace(/\bhr\b/gi, 'HR').replace(/\bbd\b/gi, 'BD')
     .replace(/\bra\b/gi, 'RA').replace(/\bai\b/gi, 'AI')
     .replace(/^./, c => c.toUpperCase());

export default function PermissionMatrixPanel() {
  const [data, setData] = useState<ApiPermissionMatrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!isApiEnabled()) { setLoading(false); return; }
    let cancelled = false;
    apiGetPermissionMatrix()
      .then(d => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Platform roles are not a workspace's business — super_admin exists to
  // administer the platform, not this builder's projects.
  const roles = useMemo(
    () => (data?.roles ?? []).filter(r => r.name !== 'super_admin'),
    [data]);

  const grouped = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const keys = (data?.permissions ?? [])
      .map(p => p.key)
      .filter(k => !needle || k.toLowerCase().includes(needle) || moduleOf(k).toLowerCase().includes(needle));
    const m = new Map<string, string[]>();
    for (const k of keys) {
      const g = moduleOf(k);
      m.set(g, [...(m.get(g) ?? []), k]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data, q]);

  const held = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const r of roles) m.set(r.id, new Set(r.keys));
    return m;
  }, [roles]);

  if (!isApiEnabled()) {
    return (
      <div className="py-10 text-center">
        <ShieldAlert className="h-8 w-8 text-zinc-300 mx-auto mb-2" />
        <p className="text-sm text-zinc-600">The permission matrix needs the API.</p>
        <p className="text-xs text-zinc-400 mt-1">Roles and grants are resolved in the database.</p>
      </div>
    );
  }

  if (loading) {
    return <div className="py-12 flex justify-center"><Loader2 className="h-6 w-6 text-zinc-300 animate-spin" /></div>;
  }

  if (!data || roles.length === 0) {
    return <div className="py-12 text-center text-sm text-zinc-500">No roles to show.</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
          <input
            value={q} onChange={e => setQ(e.target.value)}
            placeholder="Filter — try 'hr' or 'finance'"
            className="w-full pl-9 pr-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-xs"
            aria-label="Filter permissions"
          />
        </div>
        <p className="text-[11px] text-zinc-400 tabular-nums">
          {data.permissions.length} permissions · {roles.length} roles · read from the database
        </p>
      </div>

      {/* The table is wide by nature — eleven role columns — so it scrolls in
          its own container rather than pushing the page sideways. */}
      <div className="overflow-x-auto border border-zinc-100 rounded-xl">
        <table className="w-full min-w-[860px]">
          <thead className="sticky top-0 bg-white">
            <tr className="border-b border-zinc-100">
              <th className="text-left py-2.5 px-3 text-[10px] font-semibold text-zinc-500 uppercase">Permission</th>
              {roles.map(r => (
                <th key={r.id} className="py-2.5 px-2 text-[10px] font-semibold text-zinc-500 uppercase text-center whitespace-nowrap">
                  {r.name.replace(/_/g, ' ')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grouped.map(([group, keys]) => (
              <>
                <tr key={group} className="bg-zinc-50/70">
                  <td colSpan={roles.length + 1}
                    className="py-1.5 px-3 text-[10px] font-bold text-zinc-600 uppercase tracking-wide">
                    {group}
                  </td>
                </tr>
                {keys.map(k => (
                  <tr key={k} className="border-b border-zinc-50 hover:bg-zinc-50/40">
                    <td className="py-2 px-3 text-xs text-zinc-700 whitespace-nowrap">
                      {pretty(k)}
                      <span className="ml-2 text-[10px] text-zinc-300 font-mono">{k}</span>
                    </td>
                    {roles.map(r => (
                      <td key={r.id} className="text-center py-2 px-2">
                        {held.get(r.id)?.has(k)
                          ? <Check className="h-3.5 w-3.5 text-emerald-500 mx-auto" />
                          : <span className="text-zinc-200">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {grouped.length === 0 && (
        <p className="py-8 text-center text-sm text-zinc-400">Nothing matches “{q}”.</p>
      )}

      <p className="text-[11px] text-zinc-400">
        A role holding <span className="font-mono">manage_hr</span> but not{' '}
        <span className="font-mono">manage_hr_all</span> is limited to the sites it is
        posted to, under Team &amp; Roles. With no posting it is company-wide.
      </p>
    </div>
  );
}
