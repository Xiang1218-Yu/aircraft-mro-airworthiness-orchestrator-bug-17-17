import type { CustomsCallback, CustomsDeclaration } from '../domain/types.js';
import { Store } from '../store/store.js';

export class CustomsService {
  constructor(private readonly store: Store) {}

  create(tenantId: string, shipmentId: string): CustomsDeclaration {
    // Only an effective shipment detail may carry a customs declaration:
    // a split parent and cancelled/non-existent shipments are not declarable.
    const shipment = this.store.shipments.get(shipmentId);
    if (shipment && shipment.status !== 'ACTIVE') {
      throw new Error(`cannot declare customs for ${shipment.status.toLowerCase()} shipment ${shipmentId}`);
    }
    const declaration: CustomsDeclaration = { id: this.store.nextId('customs'), tenantId, shipmentId, version: 1, status: 'DRAFT', updatedAt: this.store.now() };
    this.store.customs.set(declaration.id, declaration);
    return declaration;
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
}
