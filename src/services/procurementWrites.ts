/**
 * Procurement write dispatcher + API-shape mappers (leadWrites pattern): API
 * mode talks to Fastify/Postgres (RLS+RBAC); demo mode keeps localStorage
 * behavior exactly. The vendor master is shared with AP — gst ⇄ tax_id.
 */
import { v4 as uuid } from 'uuid';
import { create, update, remove } from './db';
import type { Vendor, PurchaseOrder, PurchaseOrderLine, Material, StockTransaction, Machine, MachineStatus } from '../types';
import { receiveAgainstPo, formatPoNumber } from './procurementService';
import {
  isApiEnabled,
  apiGetVendors, apiCreateVendor, apiUpdateVendor, apiDeleteVendor,
  apiGetPurchaseOrders, apiCreatePurchaseOrder, apiUpdatePurchaseOrder, apiReceivePurchaseOrder,
  apiGetMaterials, apiCreateMaterial, apiDeleteMaterial,
  apiGetStockTxns, apiCreateStockTxn,
  apiGetMachines, apiCreateMachine, apiUpdateMachine, apiDeleteMachine,
  type ApiVendor, type ApiPurchaseOrder, type ApiMaterial, type ApiStockTxn, type ApiMachine, type ApiPoLine,
} from './apiClient';

const day = (v: unknown) => (v ? String(v).slice(0, 10) : undefined);

// ── Server row → SPA shape ───────────────────────────────────────────────────

export function mapVendor(r: ApiVendor, tenantId: string): Vendor {
  return {
    id: r.id, tenantId, name: r.name,
    category: r.category || 'Other',
    contactPerson: r.contactPerson || undefined,
    phone: r.phone || '', email: r.email || undefined,
    gst: r.taxId || undefined, address: r.address || undefined,
    rating: r.rating ?? undefined,
    status: r.status === 'active' ? 'active' : 'inactive',
    createdAt: new Date().toISOString(),
  };
}

export function mapPo(r: ApiPurchaseOrder, tenantId: string): PurchaseOrder {
  const lines: PurchaseOrderLine[] = ((r.lines || []) as (ApiPoLine & { id?: string })[]).map(l => ({
    id: l.id || uuid(),   // server lines carry no id — synthesize; receive maps by position
    materialId: l.materialId || undefined,
    description: l.description, unit: l.unit || 'nos',
    qty: l.qty, rate: l.rate, receivedQty: l.receivedQty ?? 0,
  }));
  return {
    id: r.id, tenantId, number: r.number, vendorId: r.vendorId,
    projectId: r.projectId || undefined,
    status: r.status as PurchaseOrder['status'], lines,
    expectedDate: day(r.expectedDate), notes: r.notes || undefined,
    createdBy: r.createdBy || '', approvedBy: r.approvedBy || undefined,
    approvedAt: r.approvedAt || undefined, createdAt: new Date().toISOString(),
  };
}

export function mapMaterial(r: ApiMaterial, tenantId: string): Material {
  return { id: r.id, tenantId, name: r.name, category: r.category || 'Other', unit: r.unit, reorderLevel: r.reorderLevel, createdAt: new Date().toISOString() };
}

export function mapStockTxn(r: ApiStockTxn, tenantId: string): StockTransaction {
  return {
    id: r.id, tenantId, materialId: r.materialId, projectId: r.projectId || undefined,
    type: r.type as StockTransaction['type'], qty: r.qty, rate: r.rate ?? undefined,
    vendorId: r.vendorId || undefined, poId: r.poId || undefined,
    reference: r.reference || undefined, notes: r.notes || undefined,
    createdBy: '', date: day(r.date) || '', createdAt: new Date().toISOString(),
  };
}

export function mapMachine(r: ApiMachine, tenantId: string): Machine {
  return {
    id: r.id, tenantId, name: r.name, category: r.category || 'Other',
    registrationNo: r.registrationNo || undefined,
    ownership: (r.ownership as Machine['ownership']) || 'owned',
    projectId: r.projectId || undefined, status: r.status as MachineStatus,
    nextServiceDate: day(r.nextServiceDate), notes: r.notes || undefined,
    createdAt: new Date().toISOString(),
  };
}

/** API mode: one round of all five procurement datasets, mapped to SPA shapes. */
export async function fetchProcurementData(tenantId: string): Promise<{
  vendors: Vendor[]; pos: PurchaseOrder[]; materials: Material[]; txns: StockTransaction[]; machines: Machine[];
} | null> {
  if (!isApiEnabled()) return null;
  const [v, p, m, t, mc] = await Promise.all([
    apiGetVendors(), apiGetPurchaseOrders(), apiGetMaterials(), apiGetStockTxns(), apiGetMachines(),
  ]);
  return {
    vendors: v.map(x => mapVendor(x, tenantId)),
    pos: p.map(x => mapPo(x, tenantId)),
    materials: m.map(x => mapMaterial(x, tenantId)),
    txns: t.map(x => mapStockTxn(x, tenantId)),
    machines: mc.map(x => mapMachine(x, tenantId)),
  };
}

// ── Mutations ────────────────────────────────────────────────────────────────

export async function createVendor(data: Vendor): Promise<Vendor> {
  if (isApiEnabled()) {
    const r = await apiCreateVendor({
      name: data.name, category: data.category, contactPerson: data.contactPerson,
      phone: data.phone, email: data.email || undefined, taxId: data.gst || undefined, address: data.address,
    });
    return mapVendor(r, data.tenantId);
  }
  return create<Vendor>('vendors', data);
}

export async function setVendorRating(v: Vendor, rating: number | undefined): Promise<void> {
  if (isApiEnabled()) { await apiUpdateVendor(v.id, { rating: rating ?? null }); return; }
  update<Vendor>('vendors', v.id, { rating });
}

export async function setVendorStatus(v: Vendor, status: 'active' | 'inactive'): Promise<void> {
  if (isApiEnabled()) { await apiUpdateVendor(v.id, { status }); return; }
  update<Vendor>('vendors', v.id, { status });
}

export async function deleteVendor(v: Vendor): Promise<void> {
  if (isApiEnabled()) { await apiDeleteVendor(v.id); return; }
  remove('vendors', v.id);
}

export async function createPo(data: PurchaseOrder): Promise<PurchaseOrder> {
  if (isApiEnabled()) {
    const r = await apiCreatePurchaseOrder({
      vendorId: data.vendorId, projectId: data.projectId,
      expectedDate: data.expectedDate, notes: data.notes,
      // The server schema owns line shape — strip the SPA-side ids.
      lines: data.lines.map(l => ({ materialId: l.materialId, description: l.description, unit: l.unit, qty: l.qty, rate: l.rate, receivedQty: 0 })),
    });
    return mapPo(r, data.tenantId);
  }
  return create<PurchaseOrder>('purchaseOrders', data);
}

export async function decidePo(po: PurchaseOrder, status: 'approved' | 'cancelled', userId: string): Promise<void> {
  if (isApiEnabled()) { await apiUpdatePurchaseOrder(po.id, status); return; }
  update<PurchaseOrder>('purchaseOrders', po.id,
    status === 'approved'
      ? { status, approvedBy: userId, approvedAt: new Date().toISOString() }
      : { status });
}

/**
 * Goods receipt. API mode mirrors the demo semantics server-side: bump the PO's
 * received quantities, then write an inward stock movement for every received
 * material line (clamped to what was outstanding).
 */
export async function receivePo(
  po: PurchaseOrder,
  receipts: { lineId: string; qty: number }[],
  actor: { id: string; name: string },
): Promise<boolean> {
  const accepted = receipts.filter(r => r.qty > 0);
  if (accepted.length === 0) return false;
  if (isApiEnabled()) {
    const idxReceipts = accepted
      .map(r => {
        const i = po.lines.findIndex(l => l.id === r.lineId);
        if (i < 0) return null;
        return { index: i, receivedQty: po.lines[i].receivedQty + Math.max(0, Math.min(r.qty, po.lines[i].qty - po.lines[i].receivedQty)) };
      })
      .filter((x): x is { index: number; receivedQty: number } => x !== null);
    if (idxReceipts.length === 0) return false;
    await apiReceivePurchaseOrder(po.id, idxReceipts);
    for (const r of accepted) {
      const line = po.lines.find(l => l.id === r.lineId);
      if (!line?.materialId) continue;
      const qty = Math.min(r.qty, line.qty - line.receivedQty);
      if (qty <= 0) continue;
      await apiCreateStockTxn({
        materialId: line.materialId, type: 'inward', qty, rate: line.rate,
        projectId: po.projectId, vendorId: po.vendorId, poId: po.id,
        reference: formatPoNumber(po.number),
      });
    }
    return true;
  }
  return receiveAgainstPo(po, receipts, actor) !== null;
}

export async function createMaterial(data: Material): Promise<Material> {
  if (isApiEnabled()) {
    const r = await apiCreateMaterial({ name: data.name, category: data.category, unit: data.unit, reorderLevel: data.reorderLevel });
    return mapMaterial(r, data.tenantId);
  }
  return create<Material>('materials', data);
}

export async function deleteMaterial(m: Material): Promise<void> {
  if (isApiEnabled()) { await apiDeleteMaterial(m.id); return; }
  remove('materials', m.id);
}

export async function createStockTxn(data: StockTransaction): Promise<StockTransaction> {
  if (isApiEnabled()) {
    const r = await apiCreateStockTxn({
      materialId: data.materialId, type: data.type as 'inward' | 'outward', qty: data.qty,
      projectId: data.projectId, rate: data.rate, vendorId: data.vendorId,
      reference: data.reference, notes: data.notes, date: data.date,
    });
    return mapStockTxn(r, data.tenantId);
  }
  return create<StockTransaction>('stockTxns', data);
}

export async function createMachine(data: Machine): Promise<Machine> {
  if (isApiEnabled()) {
    const r = await apiCreateMachine({
      name: data.name, category: data.category, registrationNo: data.registrationNo,
      ownership: data.ownership, projectId: data.projectId, status: data.status,
      nextServiceDate: data.nextServiceDate, notes: data.notes,
    });
    return mapMachine(r, data.tenantId);
  }
  return create<Machine>('machines', data);
}

export async function patchMachine(m: Machine, patch: { status?: MachineStatus; projectId?: string }): Promise<void> {
  if (isApiEnabled()) {
    // The server PATCH can set but not clear projectId — pass it only when set.
    await apiUpdateMachine(m.id, { status: patch.status, projectId: patch.projectId || undefined });
    return;
  }
  update<Machine>('machines', m.id, patch);
}

export async function deleteMachine(m: Machine): Promise<void> {
  if (isApiEnabled()) { await apiDeleteMachine(m.id); return; }
  remove('machines', m.id);
}
