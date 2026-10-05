import type { Shipment, ShipmentLine } from '../domain/types.js';
import { Store } from '../store/store.js';

export class ShipmentService {
  constructor(private readonly store: Store) {}

  create(orderId: string, lines: ShipmentLine[]): Shipment {
    const shipment: Shipment = { id: this.store.nextId('shipment'), orderId, status: 'ACTIVE', lines: lines.map((line) => ({ ...line })) };
    this.store.shipments.set(shipment.id, shipment);
    return shipment;
  }

  split(parentId: string, groups: ShipmentLine[][]): Shipment[] {
    const parent = this.store.shipments.get(parentId);
    if (!parent) throw new Error('shipment not found');
    const children = groups.map((lines) => this.create(parent.orderId, lines.map((line) => ({ ...line }))));
    // BUG: the parent remains active and its customs quantity is not cleared before children are generated.
    for (const line of parent.lines) {
      this.store.customsLines.set(line.id, (this.store.customsLines.get(line.id) ?? 0) + line.quantity);
    }
    for (const child of children) {
      for (const line of child.lines) this.store.customsLines.set(line.id, (this.store.customsLines.get(line.id) ?? 0) + line.quantity);
    }
    parent.status = 'SPLIT';
    for (const child of children) child.parentId = parent.id;
    return children;
  }
}
