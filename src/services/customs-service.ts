import type { CustomsCallback, CustomsDeclaration } from '../domain/types.js';
import { Store } from '../store/store.js';

export class CustomsService {
  constructor(private readonly store: Store) {}

  /** Projection key: one order line (root shipment line id) maps to exactly one customs quantity bucket. */
  static lineKey(tenantId: string, orderId: string, rootLineId: string): string {
    return `${tenantId}|${orderId}|${rootLineId}`;
  }

  declaredQuantity(tenantId: string, orderId: string, rootLineId: string): number {
    return this.store.customsLines.get(CustomsService.lineKey(tenantId, orderId, rootLineId)) ?? 0;
  }

  create(tenantId: string, shipmentId: string): CustomsDeclaration {
    const existing = this.findForShipment(shipmentId);
    if (existing && existing.status !== 'VOID') return existing;
    const declaration: CustomsDeclaration = { id: this.store.nextId('customs'), tenantId, shipmentId, version: 1, status: 'DRAFT', updatedAt: this.store.now() };
    this.store.customs.set(declaration.id, declaration);
    return declaration;
  }

  /** Return the draft for a shipment, creating one if none exists; a rolled-back/voided draft is replaced. */
  ensureDraftForShipment(tenantId: string, shipmentId: string): CustomsDeclaration {
    const existing = this.findForShipment(shipmentId);
    if (existing && existing.status !== 'VOID') {
      if (existing.status === 'DRAFT' || existing.status === 'REJECTED') return existing;
      throw new Error(`cannot regenerate draft from customs status ${existing.status}`);
    }
    // The previous record (if any) stays VOIDED in the map; the new record supersedes it.
    return this.create(tenantId, shipmentId);
  }

  /**
   * Void draft declarations of a shipment that is ceasing to be an effective transport detail.
   * Declarations already in the regulatory pipeline cannot be voided: the split/rollback must fail.
   */
  voidForShipment(shipmentId: string, reason: string): void {
    const declaration = this.findForShipment(shipmentId);
    if (!declaration || declaration.status === 'VOID') return;
    if (declaration.status === 'SUBMITTED' || declaration.status === 'INSPECTION' || declaration.status === 'RELEASED') {
      throw new Error(`cannot void customs declaration in status ${declaration.status}`);
    }
    declaration.status = 'VOID';
    declaration.version += 1;
    declaration.updatedAt = this.store.now();
    this.store.addAudit(declaration.tenantId, 'customs.voided', 'customs', declaration.id, { shipmentId, reason });
  }

  submit(declarationId: string): void {
    const declaration = this.store.customs.get(declarationId);
    if (!declaration) throw new Error('declaration not found');
    declaration.version += 1;
    declaration.status = 'SUBMITTED';
    declaration.updatedAt = this.store.now();
  }

  applyCallback(callback: CustomsCallback): void {
    const declaration = this.store.customs.get(callback.declarationId);
    if (!declaration) throw new Error('declaration not found');
    // A voided declaration belongs to a shipment that is no longer effective; late callbacks must not resurrect it.
    if (declaration.status === 'VOID') {
      this.store.addAudit(declaration.tenantId, 'customs.ignored-void-callback', 'customs', declaration.id, { callbackId: callback.callbackId });
      return;
    }
    if (callback.version < declaration.version) {
      this.store.addAudit(declaration.tenantId, 'customs.stale-callback', 'customs', declaration.id, { callbackVersion: callback.version, currentVersion: declaration.version });
      return;
    }
    if (callback.version === declaration.version && declaration.status === callback.status) return;
    declaration.version = callback.version;
    declaration.status = callback.status;
    declaration.updatedAt = callback.receivedAt;
    this.store.addAudit(declaration.tenantId, 'customs.updated', 'customs', declaration.id, { version: callback.version, status: callback.status });
    this.store.addOutbox(declaration.tenantId, 'mro.customs-updated', declaration.shipmentId, { declarationId: declaration.id, version: callback.version, status: callback.status });
  }

  private findForShipment(shipmentId: string): CustomsDeclaration | undefined {
    let match: CustomsDeclaration | undefined;
    for (const declaration of this.store.customs.values()) {
      if (declaration.shipmentId === shipmentId) match = declaration; // latest record wins: a regenerated draft supersedes the voided one
    }
    return match;
  }
}
