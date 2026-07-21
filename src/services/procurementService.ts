import { getByTenant, create, update, logAudit } from './db';
import type { PurchaseOrder, StockTransaction, Material, Machine, VendorBill } from '../types';
import { v4 as uuid } from 'uuid';

/** PO value is always derived from its lines — never stored. */
export function poTotal(po: PurchaseOrder): number {
  return po.lines.reduce((s, l) => s + l.qty * l.rate, 0);
}

export function nextPoNumber(tenantId: string): number {
  const pos = getByTenant<PurchaseOrder>('purchaseOrders', tenantId);
  return pos.reduce((max, p) => Math.max(max, p.number), 0) + 1;
}

export function formatPoNumber(n: number): string {
  return `PO-${String(n).padStart(4, '0')}`;
}

/** On-hand qty per material = inward − outward. projectId narrows to one site;
 *  omit it for the tenant-wide aggregate (which reorder alerts use). */
export function stockOnHand(tenantId: string, materialId: string, projectId?: string): number {
  return getByTenant<StockTransaction>('stockTxns', tenantId)
    .filter(t => t.materialId === materialId && (projectId === undefined || t.projectId === projectId))
    .reduce((s, t) => s + (t.type === 'inward' ? t.qty : -t.qty), 0);
}

export function lowStockMaterials(tenantId: string): { material: Material; onHand: number }[] {
  return getByTenant<Material>('materials', tenantId)
    .map(material => ({ material, onHand: stockOnHand(tenantId, material.id) }))
    .filter(({ material, onHand }) => material.reorderLevel > 0 && onHand <= material.reorderLevel);
}

/**
 * Receive material against an approved PO: bumps each line's receivedQty,
 * writes matching inward stock transactions, and rolls the PO status forward
 * to partially_received / received. One call = one goods receipt.
 */
export function receiveAgainstPo(
  po: PurchaseOrder,
  receipts: { lineId: string; qty: number }[],
  actor: { id: string; name: string },
  reference?: string,
): PurchaseOrder | null {
  const accepted = receipts.filter(r => r.qty > 0);
  if (accepted.length === 0) return null;

  const lines = po.lines.map(line => {
    const r = accepted.find(x => x.lineId === line.id);
    if (!r) return line;
    // Clamp to what is still outstanding — over-receipt is a data error
    const qty = Math.min(r.qty, line.qty - line.receivedQty);
    return { ...line, receivedQty: line.receivedQty + Math.max(0, qty) };
  });

  const fullyReceived = lines.every(l => l.receivedQty >= l.qty);
  const updated = update<PurchaseOrder>('purchaseOrders', po.id, {
    lines,
    status: fullyReceived ? 'received' : 'partially_received',
  });
  if (!updated) return null;

  const today = new Date().toISOString();
  for (const r of accepted) {
    const line = po.lines.find(l => l.id === r.lineId);
    if (!line?.materialId) continue;   // free-text lines don't hit stock
    const qty = Math.min(r.qty, line.qty - line.receivedQty);
    if (qty <= 0) continue;
    create<StockTransaction>('stockTxns', {
      id: uuid(), tenantId: po.tenantId, materialId: line.materialId,
      projectId: po.projectId, type: 'inward', qty, rate: line.rate,
      vendorId: po.vendorId, poId: po.id,
      reference: reference || formatPoNumber(po.number),
      createdBy: actor.id, date: today, createdAt: today,
    });
  }

  logAudit({
    tenantId: po.tenantId, userId: actor.id, userName: actor.name,
    action: 'update', entity: 'purchase_order', entityId: po.id,
    details: `Received goods against ${formatPoNumber(po.number)}${fullyReceived ? ' (now fully received)' : ''}`,
  });
  return updated;
}

/** Machines due (or overdue) for service within the next `days`. */
export function machinesDueForService(tenantId: string, days = 7): Machine[] {
  const horizon = Date.now() + days * 86400000;
  return getByTenant<Machine>('machines', tenantId).filter(m =>
    m.nextServiceDate && new Date(m.nextServiceDate).getTime() <= horizon
  );
}

// ── Accounts payable ─────────────────────────────────────────────────────────

export function isBillOverdue(bill: VendorBill): boolean {
  return bill.status !== 'paid' && new Date(bill.dueDate).getTime() < Date.now();
}

/** Actual spend per project = vendor bills that are approved or paid.
 *  Pending bills are excluded — they are claims, not commitments yet. */
export function projectActuals(tenantId: string, projectId: string): Map<string, number> {
  const actuals = new Map<string, number>();
  getByTenant<VendorBill>('vendorBills', tenantId)
    .filter(b => b.projectId === projectId && b.status !== 'pending')
    .forEach(b => actuals.set(b.category, (actuals.get(b.category) ?? 0) + b.amount));
  return actuals;
}
