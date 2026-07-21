import { useState, useMemo } from 'react';
import {
  Truck, Package, ShoppingCart, Wrench, Plus, X, Trash2, Star,
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, CalendarClock, Building2,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, create, update, remove, logAudit } from '../services/db';
import {
  poTotal, nextPoNumber, formatPoNumber, stockOnHand, lowStockMaterials,
  receiveAgainstPo, machinesDueForService,
} from '../services/procurementService';
import { formatCurrency } from '../utils/format';
import type {
  Project, User, Vendor, PurchaseOrder, PurchaseOrderLine, Material,
  StockTransaction, Machine, MachineStatus,
} from '../types';
import { VENDOR_CATEGORIES, MATERIAL_UNITS, MACHINE_CATEGORIES, PO_STATUSES } from '../types';
import { v4 as uuid } from 'uuid';
import toast from 'react-hot-toast';

type Tab = 'vendors' | 'orders' | 'materials' | 'machinery';

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'vendors', label: 'Vendors', icon: Truck },
  { id: 'orders', label: 'Purchase Orders', icon: ShoppingCart },
  { id: 'materials', label: 'Materials & Stock', icon: Package },
  { id: 'machinery', label: 'Plant & Machinery', icon: Wrench },
];

/** Draft line while composing a PO — quantities stay strings for free typing */
interface DraftLine { key: string; materialId: string; description: string; unit: string; qty: string; rate: string }

const emptyLine = (): DraftLine => ({ key: uuid(), materialId: '', description: '', unit: 'nos', qty: '', rate: '' });

export default function Procurement() {
  const { user, tenant, hasPermission } = useAuth();
  const tenantId = tenant?.id || '';
  const currency = tenant?.currency || 'INR';
  const canManage = hasPermission('manage_procurement');
  // Separation of duties: whoever raises a PO cannot necessarily approve it.
  const canApprove = hasPermission('approve_purchase_orders');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  const [tab, setTab] = useState<Tab>('vendors');
  const [showAddVendor, setShowAddVendor] = useState(false);
  const [showAddPo, setShowAddPo] = useState(false);
  const [showAddMaterial, setShowAddMaterial] = useState(false);
  const [showMovement, setShowMovement] = useState<'inward' | 'outward' | null>(null);
  const [showAddMachine, setShowAddMachine] = useState(false);
  const [receivingPo, setReceivingPo] = useState<PurchaseOrder | null>(null);
  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({});
  const [draftLines, setDraftLines] = useState<DraftLine[]>([emptyLine()]);

  const vendors = useMemo(
    () => getByTenant<Vendor>('vendors', tenantId).sort((a, b) => a.name.localeCompare(b.name)),
    [tenantId, refreshKey]
  );
  const pos = useMemo(
    () => getByTenant<PurchaseOrder>('purchaseOrders', tenantId).sort((a, b) => b.number - a.number),
    [tenantId, refreshKey]
  );
  const materials = useMemo(
    () => getByTenant<Material>('materials', tenantId).sort((a, b) => a.name.localeCompare(b.name)),
    [tenantId, refreshKey]
  );
  const txns = useMemo(
    () => getByTenant<StockTransaction>('stockTxns', tenantId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [tenantId, refreshKey]
  );
  const machines = useMemo(
    () => getByTenant<Machine>('machines', tenantId).sort((a, b) => a.name.localeCompare(b.name)),
    [tenantId, refreshKey]
  );
  const projects = useMemo(() => getByTenant<Project>('projects', tenantId), [tenantId, refreshKey]);
  const users = useMemo(() => getByTenant<User>('users', tenantId).filter(u => u.active), [tenantId, refreshKey]);

  const vendorName = (id?: string) => vendors.find(v => v.id === id)?.name || '—';
  const projectName = (id?: string) => projects.find(p => p.id === id)?.name || 'Central store';
  const materialName = (id: string) => materials.find(m => m.id === id)?.name || '—';
  const userName = (id?: string) => users.find(u => u.id === id)?.name || '—';
  const audit = (action: string, entity: string, entityId: string, details: string) => {
    if (user) logAudit({ tenantId, userId: user.id, userName: user.name, action, entity, entityId, details });
  };

  // KPIs
  const activeVendors = vendors.filter(v => v.status === 'active').length;
  const openPos = pos.filter(p => p.status === 'approved' || p.status === 'partially_received' || p.status === 'pending_approval');
  const openPoValue = openPos.reduce((s, p) => s + poTotal(p), 0);
  const lowStock = lowStockMaterials(tenantId);
  const serviceDue = machinesDueForService(tenantId);

  // ── Vendors ────────────────────────────────────────────────────────────────
  const handleAddVendor = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = (fd.get('name') as string)?.trim();
    const phone = (fd.get('phone') as string)?.trim();
    if (!name || !phone) { toast.error('Name and phone are required'); return; }
    const created = create<Vendor>('vendors', {
      id: '', tenantId, name,
      category: (fd.get('category') as string) || 'Other',
      contactPerson: (fd.get('contactPerson') as string) || '',
      phone, email: (fd.get('email') as string) || '',
      gst: (fd.get('gst') as string) || '',
      address: (fd.get('address') as string) || '',
      status: 'active',
      createdAt: new Date().toISOString(),
    });
    audit('create', 'vendor', created.id, `Added vendor "${name}" (${created.category})`);
    setShowAddVendor(false);
    refresh();
    toast.success('Vendor added');
  };

  const rateVendor = (v: Vendor, rating: number) => {
    update<Vendor>('vendors', v.id, { rating: v.rating === rating ? undefined : rating });
    refresh();
  };

  const toggleVendor = (v: Vendor) => {
    update<Vendor>('vendors', v.id, { status: v.status === 'active' ? 'inactive' : 'active' });
    audit('update', 'vendor', v.id, `Marked vendor "${v.name}" ${v.status === 'active' ? 'inactive' : 'active'}`);
    refresh();
  };

  const deleteVendor = (v: Vendor) => {
    if (pos.some(p => p.vendorId === v.id)) { toast.error('This vendor has purchase orders — mark them inactive instead'); return; }
    if (!confirm(`Delete vendor "${v.name}"?`)) return;
    remove('vendors', v.id);
    audit('delete', 'vendor', v.id, `Deleted vendor "${v.name}"`);
    refresh();
    toast.success('Vendor deleted');
  };

  // ── Purchase orders ────────────────────────────────────────────────────────
  const draftTotal = draftLines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0);

  const setLine = (key: string, patch: Partial<DraftLine>) =>
    setDraftLines(lines => lines.map(l => l.key === key ? { ...l, ...patch } : l));

  const pickLineMaterial = (key: string, materialId: string) => {
    const m = materials.find(x => x.id === materialId);
    setLine(key, materialId && m
      ? { materialId, description: m.name, unit: m.unit }
      : { materialId: '' });
  };

  const handleAddPo = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user) return;
    const fd = new FormData(e.currentTarget);
    const vendorId = fd.get('vendorId') as string;
    if (!vendorId) { toast.error('Pick a vendor'); return; }
    const lines: PurchaseOrderLine[] = draftLines
      .filter(l => l.description.trim() && Number(l.qty) > 0)
      .map(l => ({
        id: uuid(), materialId: l.materialId || undefined,
        description: l.description.trim(), unit: l.unit,
        qty: Number(l.qty), rate: Number(l.rate) || 0, receivedQty: 0,
      }));
    if (lines.length === 0) { toast.error('Add at least one line with a description and quantity'); return; }
    const created = create<PurchaseOrder>('purchaseOrders', {
      id: '', tenantId, number: nextPoNumber(tenantId), vendorId,
      projectId: (fd.get('projectId') as string) || undefined,
      status: 'pending_approval', lines,
      expectedDate: (fd.get('expectedDate') as string) || undefined,
      notes: (fd.get('notes') as string) || '',
      createdBy: user.id,
      createdAt: new Date().toISOString(),
    });
    audit('create', 'purchase_order', created.id, `Raised ${formatPoNumber(created.number)} on ${vendorName(vendorId)} — ${formatCurrency(poTotal(created), currency)}`);
    setShowAddPo(false);
    setDraftLines([emptyLine()]);
    refresh();
    toast.success(`${formatPoNumber(created.number)} raised`);
  };

  const approvePo = (po: PurchaseOrder) => {
    if (!user) return;
    update<PurchaseOrder>('purchaseOrders', po.id, { status: 'approved', approvedBy: user.id, approvedAt: new Date().toISOString() });
    audit('update', 'purchase_order', po.id, `Approved ${formatPoNumber(po.number)}`);
    refresh();
    toast.success('PO approved');
  };

  const cancelPo = (po: PurchaseOrder) => {
    if (!confirm(`Cancel ${formatPoNumber(po.number)}?`)) return;
    update<PurchaseOrder>('purchaseOrders', po.id, { status: 'cancelled' });
    audit('update', 'purchase_order', po.id, `Cancelled ${formatPoNumber(po.number)}`);
    refresh();
    toast.success('PO cancelled');
  };

  const handleReceive = () => {
    if (!receivingPo || !user) return;
    const receipts = receivingPo.lines
      .map(l => ({ lineId: l.id, qty: Number(receiveQty[l.id]) || 0 }))
      .filter(r => r.qty > 0);
    if (receipts.length === 0) { toast.error('Enter a received quantity on at least one line'); return; }
    const result = receiveAgainstPo(receivingPo, receipts, { id: user.id, name: user.name });
    if (!result) { toast.error('Nothing to receive'); return; }
    setReceivingPo(null);
    setReceiveQty({});
    refresh();
    toast.success(`Goods received against ${formatPoNumber(receivingPo.number)} — stock updated`);
  };

  // ── Materials & stock ──────────────────────────────────────────────────────
  const handleAddMaterial = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = (fd.get('name') as string)?.trim();
    if (!name) { toast.error('Material name is required'); return; }
    const created = create<Material>('materials', {
      id: '', tenantId, name,
      category: (fd.get('category') as string) || 'Other',
      unit: (fd.get('unit') as string) || 'nos',
      reorderLevel: Number(fd.get('reorderLevel')) || 0,
      createdAt: new Date().toISOString(),
    });
    audit('create', 'material', created.id, `Added material "${name}"`);
    setShowAddMaterial(false);
    refresh();
    toast.success('Material added');
  };

  const handleMovement = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user || !showMovement) return;
    const fd = new FormData(e.currentTarget);
    const materialId = fd.get('materialId') as string;
    const qty = Number(fd.get('qty'));
    if (!materialId || !(qty > 0)) { toast.error('Pick a material and a positive quantity'); return; }
    const projectId = (fd.get('projectId') as string) || undefined;
    if (showMovement === 'outward') {
      const onHand = stockOnHand(tenantId, materialId, projectId);
      if (qty > onHand) {
        toast.error(`Only ${onHand} ${materials.find(m => m.id === materialId)?.unit || ''} on hand at ${projectName(projectId)}`);
        return;
      }
    }
    const created = create<StockTransaction>('stockTxns', {
      id: '', tenantId, materialId, projectId,
      type: showMovement, qty,
      rate: showMovement === 'inward' ? Number(fd.get('rate')) || undefined : undefined,
      vendorId: showMovement === 'inward' ? (fd.get('vendorId') as string) || undefined : undefined,
      reference: (fd.get('reference') as string) || '',
      notes: (fd.get('notes') as string) || '',
      createdBy: user.id,
      date: (fd.get('date') as string) || new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
    });
    audit('create', 'stock_transaction', created.id,
      `${showMovement === 'inward' ? 'Inward' : 'Issued'} ${qty} × ${materialName(materialId)} @ ${projectName(projectId)}`);
    setShowMovement(null);
    refresh();
    toast.success(showMovement === 'inward' ? 'Stock received' : 'Material issued');
  };

  const deleteMaterial = (m: Material) => {
    if (txns.some(t => t.materialId === m.id)) { toast.error('This material has stock movements — it cannot be deleted'); return; }
    if (!confirm(`Delete material "${m.name}"?`)) return;
    remove('materials', m.id);
    refresh();
    toast.success('Material deleted');
  };

  // ── Machinery ──────────────────────────────────────────────────────────────
  const handleAddMachine = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = (fd.get('name') as string)?.trim();
    if (!name) { toast.error('Machine name is required'); return; }
    const created = create<Machine>('machines', {
      id: '', tenantId, name,
      category: (fd.get('category') as string) || 'Other',
      registrationNo: (fd.get('registrationNo') as string) || '',
      ownership: (fd.get('ownership') as 'owned' | 'rented') || 'owned',
      projectId: (fd.get('projectId') as string) || undefined,
      status: 'on_site',
      nextServiceDate: (fd.get('nextServiceDate') as string) || undefined,
      createdAt: new Date().toISOString(),
    });
    audit('create', 'machine', created.id, `Added ${created.category.toLowerCase()} "${name}"`);
    setShowAddMachine(false);
    refresh();
    toast.success('Machine added');
  };

  const setMachineStatus = (m: Machine, status: MachineStatus) => {
    update<Machine>('machines', m.id, { status });
    refresh();
  };

  const moveMachine = (m: Machine, projectId: string) => {
    update<Machine>('machines', m.id, { projectId: projectId || undefined });
    audit('update', 'machine', m.id, `Moved "${m.name}" to ${projectName(projectId || undefined)}`);
    refresh();
  };

  const deleteMachine = (m: Machine) => {
    if (!confirm(`Delete "${m.name}"?`)) return;
    remove('machines', m.id);
    audit('delete', 'machine', m.id, `Deleted machine "${m.name}"`);
    refresh();
    toast.success('Machine removed');
  };

  // ── Shared bits ────────────────────────────────────────────────────────────
  const inputCls = 'w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20';
  const labelCls = 'block text-xs font-semibold text-zinc-500 uppercase mb-1';
  const fmtDate = (d?: string) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const poStatusCls: Record<PurchaseOrder['status'], string> = {
    pending_approval: 'bg-amber-50 text-amber-700',
    approved: 'bg-blue-50 text-blue-700',
    partially_received: 'bg-indigo-50 text-indigo-700',
    received: 'bg-emerald-50 text-emerald-700',
    cancelled: 'bg-zinc-100 text-zinc-500',
  };

  return (
    <div className="space-y-6 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Procurement & Materials</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Vendors, purchase orders, site stock and machinery — the supply side of every project.</p>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gradient-to-br from-indigo-500 to-violet-600 rounded-2xl p-4 text-white">
          <div className="flex items-center gap-2 mb-2">
            <ShoppingCart className="h-5 w-5 text-indigo-200" />
            <span className="text-xs font-medium text-indigo-200">Open PO Value</span>
          </div>
          <p className="text-3xl font-bold">{formatCurrency(openPoValue, currency)}</p>
          <p className="text-xs text-indigo-200 mt-1">{openPos.length} open order{openPos.length === 1 ? '' : 's'}</p>
        </div>
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Truck className="h-5 w-5 text-zinc-400" />
            <span className="text-xs font-medium text-zinc-500">Active Vendors</span>
          </div>
          <p className="text-2xl font-bold text-zinc-900">{activeVendors}</p>
          <p className="text-xs text-zinc-500 mt-1">{vendors.length} in the master</p>
        </div>
        <div className={`rounded-2xl border p-4 ${lowStock.length > 0 ? 'bg-red-50/60 border-red-200' : 'bg-white border-zinc-200/60'}`}>
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className={`h-5 w-5 ${lowStock.length > 0 ? 'text-red-500' : 'text-zinc-400'}`} />
            <span className={`text-xs font-medium ${lowStock.length > 0 ? 'text-red-600' : 'text-zinc-500'}`}>Reorder Alerts</span>
          </div>
          <p className={`text-2xl font-bold ${lowStock.length > 0 ? 'text-red-600' : 'text-zinc-900'}`}>{lowStock.length}</p>
          <p className={`text-xs mt-1 truncate ${lowStock.length > 0 ? 'text-red-500' : 'text-zinc-500'}`}>
            {lowStock.length > 0 ? lowStock.map(l => l.material.name).join(', ') : 'All materials above threshold'}
          </p>
        </div>
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-2">
            <CalendarClock className="h-5 w-5 text-zinc-400" />
            <span className="text-xs font-medium text-zinc-500">Service Due</span>
          </div>
          <p className="text-2xl font-bold text-zinc-900">{serviceDue.length}</p>
          <p className="text-xs text-zinc-500 mt-1 truncate">
            {serviceDue.length > 0 ? serviceDue.map(m => m.name).join(', ') : `${machines.length} machine${machines.length === 1 ? '' : 's'} tracked`}
          </p>
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
            {t.id === 'materials' && lowStock.length > 0 && (
              <span className={`text-[10px] font-bold px-1.5 rounded-full ${tab === 'materials' ? 'bg-white/20' : 'bg-red-100 text-red-600'}`}>{lowStock.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Vendors ── */}
      {tab === 'vendors' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-3">
            <h3 className="font-semibold text-zinc-900">Vendor Master</h3>
            <div className="flex-1" />
            {canManage && (
              <button onClick={() => setShowAddVendor(true)} className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors">
                <Plus className="h-3.5 w-3.5" /> Add Vendor
              </button>
            )}
          </div>
          {vendors.length === 0 ? (
            <div className="py-16 text-center">
              <Truck className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">No vendors yet. Add your cement, steel and contractor partners to start raising POs.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-zinc-50/30 border-b border-zinc-100">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Vendor</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase hidden md:table-cell">Contact</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Rating</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase hidden sm:table-cell">Orders</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {vendors.map(v => {
                    const vendorPos = pos.filter(p => p.vendorId === v.id && p.status !== 'cancelled');
                    return (
                      <tr key={v.id} className="border-b border-zinc-50 hover:bg-zinc-50/30 transition-colors">
                        <td className="px-4 py-3">
                          <p className="text-sm font-medium text-zinc-900">{v.name}</p>
                          <p className="text-[11px] text-zinc-500">{v.category}{v.gst ? ` · GST ${v.gst}` : ''}</p>
                        </td>
                        <td className="px-4 py-3 text-sm text-zinc-600 hidden md:table-cell">
                          {v.contactPerson || '—'}
                          <p className="text-[11px] text-zinc-400">{v.phone}</p>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-0.5">
                            {[1, 2, 3, 4, 5].map(n => (
                              <button key={n} disabled={!canManage} onClick={() => rateVendor(v, n)}>
                                <Star className={`h-3.5 w-3.5 ${v.rating && n <= v.rating ? 'text-amber-400 fill-amber-400' : 'text-zinc-200'} ${canManage ? 'hover:text-amber-300' : ''}`} />
                              </button>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-zinc-600 text-right hidden sm:table-cell">
                          {vendorPos.length}
                          <p className="text-[11px] text-zinc-400">{formatCurrency(vendorPos.reduce((s, p) => s + poTotal(p), 0), currency)}</p>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button
                            disabled={!canManage}
                            onClick={() => toggleVendor(v)}
                            className={`text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors ${v.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-500'} ${canManage ? 'cursor-pointer hover:opacity-80' : ''}`}
                          >{v.status}</button>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {canManage && (
                            <button onClick={() => deleteVendor(v)} className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 transition-colors">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Purchase Orders ── */}
      {tab === 'orders' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-3">
            <h3 className="font-semibold text-zinc-900">Purchase Orders</h3>
            <div className="flex-1" />
            {canManage && (
              <button
                onClick={() => {
                  if (vendors.filter(v => v.status === 'active').length === 0) { toast.error('Add an active vendor first'); return; }
                  setDraftLines([emptyLine()]);
                  setShowAddPo(true);
                }}
                className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" /> Raise PO
              </button>
            )}
          </div>
          {pos.length === 0 ? (
            <div className="py-16 text-center">
              <ShoppingCart className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">No purchase orders yet. Raise a PO and receive goods straight into site stock.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-zinc-50/30 border-b border-zinc-100">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">PO</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Vendor</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase hidden md:table-cell">Site</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Value</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase hidden sm:table-cell">Expected</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {pos.map(po => (
                    <tr key={po.id} className="border-b border-zinc-50 hover:bg-zinc-50/30 transition-colors">
                      <td className="px-4 py-3">
                        <p className="text-xs font-mono font-semibold text-indigo-600">{formatPoNumber(po.number)}</p>
                        <p className="text-[11px] text-zinc-400">{po.lines.length} line{po.lines.length === 1 ? '' : 's'} · {fmtDate(po.createdAt)}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-zinc-700">{vendorName(po.vendorId)}</td>
                      <td className="px-4 py-3 text-sm text-zinc-600 hidden md:table-cell">{projectName(po.projectId)}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-zinc-900 text-right">{formatCurrency(poTotal(po), currency)}</td>
                      <td className="px-4 py-3 text-sm text-zinc-500 hidden sm:table-cell">{fmtDate(po.expectedDate)}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${poStatusCls[po.status]}`}>
                          {PO_STATUSES.find(s => s.id === po.status)?.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {po.status === 'pending_approval' && (
                          <>
                            {canApprove && <button onClick={() => approvePo(po)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors mr-1">Approve</button>}
                            {canManage && <button onClick={() => cancelPo(po)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-red-50 text-red-600 hover:bg-red-100 transition-colors">Cancel</button>}
                          </>
                        )}
                        {canManage && (po.status === 'approved' || po.status === 'partially_received') && (
                          <button
                            onClick={() => { setReceivingPo(po); setReceiveQty({}); }}
                            className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors inline-flex items-center gap-1"
                          >
                            <ArrowDownToLine className="h-3 w-3" /> Receive
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

      {/* ── Materials & Stock ── */}
      {tab === 'materials' && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-zinc-900">Materials</h3>
              <div className="flex-1" />
              {canManage && (
                <>
                  <button onClick={() => setShowMovement('inward')} className="flex items-center gap-1.5 px-3 py-2 bg-emerald-50 text-emerald-700 rounded-xl text-xs font-semibold hover:bg-emerald-100 transition-colors">
                    <ArrowDownToLine className="h-3.5 w-3.5" /> Inward
                  </button>
                  <button onClick={() => setShowMovement('outward')} className="flex items-center gap-1.5 px-3 py-2 bg-amber-50 text-amber-700 rounded-xl text-xs font-semibold hover:bg-amber-100 transition-colors">
                    <ArrowUpFromLine className="h-3.5 w-3.5" /> Issue
                  </button>
                  <button onClick={() => setShowAddMaterial(true)} className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors">
                    <Plus className="h-3.5 w-3.5" /> Add Material
                  </button>
                </>
              )}
            </div>
            {materials.length === 0 ? (
              <div className="py-16 text-center">
                <Package className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
                <p className="text-sm text-zinc-500">No materials yet. Define cement, steel, bricks — then track every inward and issue per site.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-zinc-50/30 border-b border-zinc-100">
                      <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Material</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">On Hand</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase hidden sm:table-cell">Reorder At</th>
                      <th className="text-center px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Stock Health</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {materials.map(m => {
                      const onHand = stockOnHand(tenantId, m.id);
                      const low = m.reorderLevel > 0 && onHand <= m.reorderLevel;
                      return (
                        <tr key={m.id} className="border-b border-zinc-50 hover:bg-zinc-50/30 transition-colors">
                          <td className="px-4 py-3">
                            <p className="text-sm font-medium text-zinc-900">{m.name}</p>
                            <p className="text-[11px] text-zinc-500">{m.category}</p>
                          </td>
                          <td className="px-4 py-3 text-sm font-semibold text-zinc-900 text-right">{onHand} <span className="text-[11px] font-normal text-zinc-400">{m.unit}</span></td>
                          <td className="px-4 py-3 text-sm text-zinc-500 text-right hidden sm:table-cell">{m.reorderLevel > 0 ? `${m.reorderLevel} ${m.unit}` : '—'}</td>
                          <td className="px-4 py-3 text-center">
                            {low ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-red-50 text-red-600">
                                <AlertTriangle className="h-3 w-3" /> Reorder now
                              </span>
                            ) : (
                              <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700">OK</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {canManage && (
                              <button onClick={() => deleteMaterial(m)} className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 transition-colors">
                                <Trash2 className="h-4 w-4" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {txns.length > 0 && (
            <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
              <div className="px-5 py-4 border-b border-zinc-100">
                <h3 className="font-semibold text-zinc-900 text-sm">Recent Movements</h3>
              </div>
              <div className="divide-y divide-zinc-50">
                {txns.slice(0, 12).map(t => (
                  <div key={t.id} className="flex items-center gap-3 px-5 py-2.5">
                    <div className={`h-7 w-7 rounded-lg flex items-center justify-center shrink-0 ${t.type === 'inward' ? 'bg-emerald-50' : 'bg-amber-50'}`}>
                      {t.type === 'inward'
                        ? <ArrowDownToLine className="h-3.5 w-3.5 text-emerald-600" />
                        : <ArrowUpFromLine className="h-3.5 w-3.5 text-amber-600" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-zinc-800 truncate">
                        <span className="font-semibold">{t.qty}</span> × {materialName(t.materialId)}
                        <span className="text-zinc-400"> · {projectName(t.projectId)}</span>
                      </p>
                      <p className="text-[11px] text-zinc-400">
                        {fmtDate(t.date)} · by {userName(t.createdBy)}{t.reference ? ` · ${t.reference}` : ''}
                      </p>
                    </div>
                    {t.type === 'inward' && t.rate ? (
                      <span className="text-xs text-zinc-500 shrink-0">{formatCurrency(t.qty * t.rate, currency)}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Plant & Machinery ── */}
      {tab === 'machinery' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-zinc-500">{machines.length} machine{machines.length === 1 ? '' : 's'} tracked across sites</p>
            {canManage && (
              <button onClick={() => setShowAddMachine(true)} className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition-colors">
                <Plus className="h-3.5 w-3.5" /> Add Machine
              </button>
            )}
          </div>
          {machines.length === 0 ? (
            <div className="bg-white rounded-2xl border border-zinc-200/60 py-16 text-center">
              <Wrench className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">No machinery tracked yet. Add excavators, cranes and mixers to track deployment and service schedules.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {machines.map(m => {
                const due = m.nextServiceDate && new Date(m.nextServiceDate).getTime() <= Date.now() + 7 * 86400000;
                return (
                  <div key={m.id} className="bg-white rounded-2xl border border-zinc-200/60 p-5">
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-zinc-600 to-zinc-800 flex items-center justify-center shrink-0">
                          <Wrench className="h-5 w-5 text-white" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-zinc-900 truncate">{m.name}</p>
                          <p className="text-[11px] text-zinc-500">{m.category} · {m.ownership}{m.registrationNo ? ` · ${m.registrationNo}` : ''}</p>
                        </div>
                      </div>
                      {canManage && (
                        <button onClick={() => deleteMachine(m)} className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 transition-colors shrink-0">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="space-y-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-zinc-500 flex items-center gap-1"><Building2 className="h-3 w-3" /> Site</span>
                        {canManage ? (
                          <select value={m.projectId || ''} onChange={e => moveMachine(m, e.target.value)} className="text-xs font-medium bg-zinc-50 border border-zinc-200 rounded-lg px-2 py-1 max-w-[55%]">
                            <option value="">Central yard</option>
                            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        ) : <span className="font-medium text-zinc-800">{projectName(m.projectId)}</span>}
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-zinc-500">Status</span>
                        {canManage ? (
                          <select value={m.status} onChange={e => setMachineStatus(m, e.target.value as MachineStatus)} className="text-xs font-medium bg-zinc-50 border border-zinc-200 rounded-lg px-2 py-1">
                            <option value="on_site">On Site</option>
                            <option value="idle">Idle</option>
                            <option value="maintenance">Under Maintenance</option>
                          </select>
                        ) : <span className="font-medium text-zinc-800 capitalize">{m.status.replace('_', ' ')}</span>}
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-zinc-500">Next service</span>
                        <span className={`font-medium ${due ? 'text-red-600' : 'text-zinc-800'}`}>
                          {fmtDate(m.nextServiceDate)}{due ? ' ⚠' : ''}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Modals ── */}

      {/* Add vendor */}
      {showAddVendor && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddVendor(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Add Vendor</h3>
              <button onClick={() => setShowAddVendor(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddVendor} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className={labelCls}>Vendor Name *</label>
                  <input name="name" required placeholder="Shree Cement Distributors" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Category</label>
                  <select name="category" className={inputCls}>
                    {VENDOR_CATEGORIES.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Contact Person</label>
                  <input name="contactPerson" placeholder="Ramesh Kumar" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Phone *</label>
                  <input name="phone" required placeholder="+91 98765 43210" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Email</label>
                  <input name="email" type="email" placeholder="sales@vendor.com" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>GST Number</label>
                  <input name="gst" placeholder="29ABCDE1234F1Z5" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Address</label>
                  <input name="address" placeholder="City / area" className={inputCls} />
                </div>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddVendor(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Add Vendor</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Raise PO */}
      {showAddPo && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddPo(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Raise Purchase Order</h3>
              <button onClick={() => setShowAddPo(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddPo} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Vendor *</label>
                  <select name="vendorId" required className={inputCls}>
                    <option value="">Select vendor...</option>
                    {vendors.filter(v => v.status === 'active').map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Deliver To</label>
                  <select name="projectId" className={inputCls}>
                    <option value="">Central store</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Expected Delivery</label>
                  <input name="expectedDate" type="date" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Notes</label>
                  <input name="notes" placeholder="Terms, site contact..." className={inputCls} />
                </div>
              </div>

              <div>
                <label className={labelCls}>Order Lines</label>
                <div className="space-y-2">
                  {draftLines.map(line => (
                    <div key={line.key} className="grid grid-cols-12 gap-2 items-center">
                      <select
                        value={line.materialId}
                        onChange={e => pickLineMaterial(line.key, e.target.value)}
                        className="col-span-3 px-2 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-xs"
                      >
                        <option value="">Free text</option>
                        {materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                      <input
                        value={line.description}
                        onChange={e => setLine(line.key, { description: e.target.value })}
                        placeholder="Description"
                        className="col-span-4 px-2 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-xs"
                      />
                      <input
                        value={line.qty}
                        onChange={e => setLine(line.key, { qty: e.target.value })}
                        placeholder="Qty" type="number" min="0" step="any"
                        className="col-span-2 px-2 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-xs"
                      />
                      <input
                        value={line.rate}
                        onChange={e => setLine(line.key, { rate: e.target.value })}
                        placeholder={`Rate/${line.unit}`} type="number" min="0" step="any"
                        className="col-span-2 px-2 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => setDraftLines(ls => ls.length > 1 ? ls.filter(l => l.key !== line.key) : ls)}
                        className="col-span-1 p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 justify-self-center"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <div className="flex items-center justify-between">
                    <button type="button" onClick={() => setDraftLines(ls => [...ls, emptyLine()])} className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-700 px-1 py-1">
                      <Plus className="h-3.5 w-3.5" /> Add line
                    </button>
                    <p className="text-sm font-bold text-zinc-900">Total: {formatCurrency(draftTotal, currency)}</p>
                  </div>
                </div>
              </div>

              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddPo(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Submit for Approval</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Receive against PO */}
      {receivingPo && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setReceivingPo(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-mono font-semibold text-indigo-600">{formatPoNumber(receivingPo.number)}</span>
              <button onClick={() => setReceivingPo(null)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <h3 className="text-lg font-bold text-zinc-900 mb-1">Receive Goods</h3>
            <p className="text-[11px] text-zinc-500 mb-4">{vendorName(receivingPo.vendorId)} → {projectName(receivingPo.projectId)}. Received quantities post straight into site stock.</p>
            <div className="space-y-2 mb-4">
              {receivingPo.lines.map(l => {
                const outstanding = l.qty - l.receivedQty;
                return (
                  <div key={l.id} className="border border-zinc-200 rounded-xl p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-zinc-900 truncate">{l.description}</p>
                        <p className="text-[11px] text-zinc-500">{l.receivedQty}/{l.qty} {l.unit} received{l.materialId ? '' : ' · not stock-tracked'}</p>
                      </div>
                      <input
                        type="number" min="0" max={outstanding} step="any"
                        placeholder={`≤ ${outstanding}`}
                        value={receiveQty[l.id] ?? ''}
                        onChange={e => setReceiveQty(q => ({ ...q, [l.id]: e.target.value }))}
                        disabled={outstanding <= 0}
                        className="w-24 px-2 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm text-right disabled:opacity-40"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <button onClick={handleReceive} className="w-full px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm flex items-center justify-center gap-2">
              <ArrowDownToLine className="h-4 w-4" /> Post Goods Receipt
            </button>
          </div>
        </div>
      )}

      {/* Add material */}
      {showAddMaterial && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddMaterial(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Add Material</h3>
              <button onClick={() => setShowAddMaterial(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddMaterial} className="space-y-3">
              <div>
                <label className={labelCls}>Material Name *</label>
                <input name="name" required placeholder="OPC 53 Grade Cement" className={inputCls} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Category</label>
                  <select name="category" className={inputCls}>
                    {VENDOR_CATEGORIES.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Unit</label>
                  <select name="unit" className={inputCls}>
                    {MATERIAL_UNITS.map(u => <option key={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className={labelCls}>Reorder Level</label>
                <input name="reorderLevel" type="number" min="0" placeholder="100 — alert when stock falls to this" className={inputCls} />
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddMaterial(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Add Material</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Stock movement */}
      {showMovement && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowMovement(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">{showMovement === 'inward' ? 'Record Inward Stock' : 'Issue Material'}</h3>
              <button onClick={() => setShowMovement(null)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            {materials.length === 0 ? (
              <p className="text-sm text-zinc-500 py-6 text-center">Add a material first.</p>
            ) : (
              <form onSubmit={handleMovement} className="space-y-3">
                <div>
                  <label className={labelCls}>Material *</label>
                  <select name="materialId" required className={inputCls}>
                    <option value="">Select material...</option>
                    {materials.map(m => <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>Site</label>
                    <select name="projectId" className={inputCls}>
                      <option value="">Central store</option>
                      {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Quantity *</label>
                    <input name="qty" type="number" min="0" step="any" required placeholder="50" className={inputCls} />
                  </div>
                  {showMovement === 'inward' && (
                    <>
                      <div>
                        <label className={labelCls}>Rate / unit</label>
                        <input name="rate" type="number" min="0" step="any" placeholder="380" className={inputCls} />
                      </div>
                      <div>
                        <label className={labelCls}>Vendor</label>
                        <select name="vendorId" className={inputCls}>
                          <option value="">—</option>
                          {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                        </select>
                      </div>
                    </>
                  )}
                  <div>
                    <label className={labelCls}>Date</label>
                    <input name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>Reference</label>
                    <input name="reference" placeholder={showMovement === 'inward' ? 'Challan no.' : 'Issue slip no.'} className={inputCls} />
                  </div>
                </div>
                <div>
                  <label className={labelCls}>Notes</label>
                  <input name="notes" placeholder={showMovement === 'outward' ? 'Issued for 4th floor slab...' : 'Optional'} className={inputCls} />
                </div>
                <div className="flex gap-3 pt-3">
                  <button type="button" onClick={() => setShowMovement(null)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                  <button type="submit" className={`flex-1 px-4 py-2.5 text-white rounded-xl text-sm font-semibold shadow-sm ${showMovement === 'inward' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-amber-600 hover:bg-amber-700'}`}>
                    {showMovement === 'inward' ? 'Receive Stock' : 'Issue Material'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Add machine */}
      {showAddMachine && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddMachine(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-900">Add Machine</h3>
              <button onClick={() => setShowAddMachine(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddMachine} className="space-y-3">
              <div>
                <label className={labelCls}>Name *</label>
                <input name="name" required placeholder="JCB 3DX #2" className={inputCls} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Category</label>
                  <select name="category" className={inputCls}>
                    {MACHINE_CATEGORIES.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Ownership</label>
                  <select name="ownership" className={inputCls}>
                    <option value="owned">Owned</option>
                    <option value="rented">Rented</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Registration No.</label>
                  <input name="registrationNo" placeholder="KA-01-AB-1234" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Next Service</label>
                  <input name="nextServiceDate" type="date" className={inputCls} />
                </div>
                <div className="col-span-2">
                  <label className={labelCls}>Deployed At</label>
                  <select name="projectId" className={inputCls}>
                    <option value="">Central yard</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddMachine(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Add Machine</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
