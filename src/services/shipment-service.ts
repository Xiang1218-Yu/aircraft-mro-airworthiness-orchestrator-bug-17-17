import type { Shipment, ShipmentAllocation, ShipmentLine } from '../domain/types.js';
import { CustomsService } from './customs-service.js';
import { Store } from '../store/store.js';

export interface SplitResult {
  parent: Shipment;
  children: Shipment[];
  requestKey: string;
  idempotent: boolean;
}

export interface RollbackResult {
  parent: Shipment;
  children: Shipment[];
  requestKey: string;
  idempotent: boolean;
}

/**
 * Shipment splitting / customs quantity rules:
 *  - A parent shipment and its children can never both be effective (ACTIVE) transport details.
 *  - Customs quantity is a projection rebuilt from ACTIVE shipments, so every order line is counted exactly once.
 *  - A serialized part can be carried by at most one ACTIVE shipment.
 *  - Splits are keyed for idempotent retry; rollback restores the parent and cancels every child atomically.
 */
export class ShipmentService {
  private readonly customs: CustomsService;

  constructor(
    private readonly store: Store,
    customs?: CustomsService,
  ) {
    this.customs = customs ?? new CustomsService(store);
  }

  async create(tenantId: string, orderId: string, lines: ShipmentLine[]): Promise<Shipment> {
    return this.store.lock.runExclusive(() => {
      if (lines.length === 0) throw new Error('shipment must contain at least one line');
      const normalized = lines.map((line) => ({ ...line }));
      const seenLineIds = new Set<string>();
      for (const line of normalized) {
        if (!line.id || line.orderId !== orderId) throw new Error(`line ${line.id} does not belong to order ${orderId}`);
        if (!seenLineIds.add(line.id)) throw new Error(`duplicate order line ${line.id} in shipment`);
        if (line.quantity <= 0 || !Number.isFinite(line.quantity)) throw new Error(`line ${line.id} must have a positive quantity`);
      }
      this.assertSerialsAvailable(tenantId, normalized, []);
      this.assertStockAvailable(tenantId, normalized);

      const shipment: Shipment = { id: this.store.nextId('shipment'), tenantId, orderId, status: 'ACTIVE', lines: normalized, version: 1 };
      this.store.shipments.set(shipment.id, shipment);
      for (const allocation of this.buildCreateAllocations(shipment, normalized)) {
        this.store.shipmentAllocations.set(allocation.id, allocation);
      }
      this.rebuildCustomsProjection(orderId);
      this.store.addAudit(tenantId, 'shipment.created', 'shipment', shipment.id, { orderId, lines: normalized.length });
      this.store.addOutbox(tenantId, 'mro.shipment-created', shipment.id, { shipmentId: shipment.id, orderId });
      return shipment;
    });
  }

  async split(parentId: string, groups: ShipmentLine[][], splitKey?: string): Promise<SplitResult> {
    return this.store.lock.runExclusive(() => {
      const parent = this.store.shipments.get(parentId);
      if (!parent) throw new Error('shipment not found');
      const key = splitKey ?? this.autoKey(parent.id, groups);
      const requestKey = this.requestKey(parent.id, key);

      // Idempotent retry: the exact same request returns the children already generated.
      const existing = this.store.splitRequests.get(requestKey);
      if (existing) {
        if (existing.groupsHash !== this.hashGroups(groups)) throw new Error('split request fingerprint conflict');
        if (existing.status === 'COMPLETED') {
          const children = existing.childIds.map((id) => this.mustGetShipment(id));
          if (parent.status !== 'SPLIT') throw new Error('split state corrupted');
          return { parent, children, requestKey: key, idempotent: true };
        }
        throw new Error('split request was rolled back; retry with a new split key');
      }
      if (parent.status !== 'ACTIVE') throw new Error(`shipment cannot be split from status ${parent.status}`);

      this.validateGroups(parent, groups);
      const children = this.commitSplit(parent, groups, key, requestKey);
      return { parent, children, requestKey: key, idempotent: false };
    });
  }

  async rollbackSplit(parentId: string, key: string): Promise<RollbackResult> {
    return this.store.lock.runExclusive(() => {
      const parent = this.store.shipments.get(parentId);
      if (!parent) throw new Error('shipment not found');
      const request = this.store.splitRequests.get(this.requestKey(parentId, key));

      // Idempotent rollback: a repeated call reports the already-restored state without side effects.
      if (!request || request.status === 'ROLLED_BACK') {
        const children = request ? request.childIds.map((id) => this.mustGetShipment(id)) : [];
        if (parent.status === 'ACTIVE' && children.every((child) => child.status === 'CANCELLED')) {
          return { parent, children, requestKey: key, idempotent: true };
        }
        throw new Error('split request not found or rollback state corrupted');
      }
      if (parent.status !== 'SPLIT') throw new Error('parent shipment is not in split status');

      const children = request.childIds.map((id) => this.mustGetShipment(id));
      this.assertCustomsVoidable(children.map((child) => child.id));
      this.assertCustomsVoidable([parent.id]);

      for (const child of children) {
        this.customs.voidForShipment(child.id, 'split-rolled-back');
        child.status = 'CANCELLED';
        child.version += 1;
      }
      // Reservations move back to the parent lines; the total reserved against each stock never changes.
      for (const child of children) this.releaseAllocations(child.id, 'split-rolled-back');
      this.recreateParentAllocations(parent, key);

      this.customs.ensureDraftForShipment(parent.tenantId, parent.id);
      parent.status = 'ACTIVE';
      delete parent.splitKey;
      parent.version += 1;

      request.status = 'ROLLED_BACK';
      request.updatedAt = this.store.now();

      this.rebuildCustomsProjection(parent.orderId);
      this.store.addAudit(parent.tenantId, 'shipment.split-rolled-back', 'shipment', parent.id, { splitKey: key, children: children.length });
      this.store.addOutbox(parent.tenantId, 'mro.shipment-split-rolled-back', parent.id, { shipmentId: parent.id, splitKey: key, childIds: request.childIds });
      return { parent, children, requestKey: key, idempotent: false };
    });
  }

  private commitSplit(parent: Shipment, groups: ShipmentLine[][], key: string, requestKey: string): Shipment[] {
    this.assertCustomsVoidable([parent.id]);

    const children: Shipment[] = groups.map((group, index) => ({
      id: this.childShipmentId(parent.id, key, index),
      tenantId: parent.tenantId,
      orderId: parent.orderId,
      parentId: parent.id,
      status: 'ACTIVE',
      lines: group.map((line) => ({ ...line })),
      splitKey: key,
      version: 1,
    }));

    // Re-parent stock reservations first; the parent allocations are released and the children take
    // the exact same quantities, so stock.reserved is unchanged by a split.
    this.releaseAllocations(parent.id, 'shipment-split');
    for (const child of children) this.createChildAllocations(parent, child);

    this.customs.voidForShipment(parent.id, 'shipment-split');
    parent.status = 'SPLIT';
    parent.splitKey = key;
    parent.version += 1;
    for (const child of children) {
      this.store.shipments.set(child.id, child);
      this.customs.ensureDraftForShipment(child.tenantId, child.id);
    }
    this.store.splitRequests.set(requestKey, {
      key,
      tenantId: parent.tenantId,
      parentId: parent.id,
      childIds: children.map((child) => child.id),
      groupsHash: this.hashGroups(groups),
      status: 'COMPLETED',
      attempts: 1,
      createdAt: this.store.now(),
      updatedAt: this.store.now(),
    });
    this.rebuildCustomsProjection(parent.orderId);
    this.store.addAudit(parent.tenantId, 'shipment.split', 'shipment', parent.id, { splitKey: key, children: children.length });
    this.store.addOutbox(parent.tenantId, 'mro.shipment-split', parent.id, { shipmentId: parent.id, splitKey: key, childIds: children.map((child) => child.id) });
    return children;
  }

  private validateGroups(parent: Shipment, groups: ShipmentLine[][]): void {
    if (groups.length < 2) throw new Error('split must produce at least two child shipments');
    if (groups.some((group) => group.length === 0)) throw new Error('split groups must not be empty');

    const parentLines = new Map(parent.lines.map((line) => [line.id, line]));
    const childQuantityByLine = new Map<string, number>();
    const serialOwner = new Map<string, string>();
    for (const group of groups) {
      for (const line of group) {
        const parentLine = parentLines.get(line.id);
        if (!parentLine || line.orderId !== parent.orderId) throw new Error(`line ${line.id} is not part of shipment ${parent.id}`);
        if (line.partNumber !== parentLine.partNumber || (line.serialNumber ?? '') !== (parentLine.serialNumber ?? '')) {
          throw new Error(`line ${line.id} part/serial does not match the parent shipment`);
        }
        if ((line.stockId ?? '') !== (parentLine.stockId ?? '')) throw new Error(`line ${line.id} stock must match the parent shipment`);
        if (line.quantity <= 0 || !Number.isFinite(line.quantity)) throw new Error(`line ${line.id} must have a positive quantity`);
        childQuantityByLine.set(line.id, (childQuantityByLine.get(line.id) ?? 0) + line.quantity);
        if (line.serialNumber) {
          const owner = serialOwner.get(line.serialNumber);
          if (owner && owner !== line.id) throw new Error(`serialized part ${line.serialNumber} appears in multiple split groups`);
          serialOwner.set(line.serialNumber, line.id);
          if (line.quantity !== 1) throw new Error(`serialized line ${line.id} must be carried whole by one child`);
        }
      }
    }

    // Every parent line must be covered exactly once in total (order line quantity counted exactly once).
    for (const parentLine of parent.lines) {
      const covered = childQuantityByLine.get(parentLine.id) ?? 0;
      if (covered !== parentLine.quantity) {
        throw new Error(`split quantity for line ${parentLine.id} must total ${parentLine.quantity}, got ${covered}`);
      }
      if (parentLine.serialNumber && covered > 0 && groups.filter((group) => group.some((line) => line.id === parentLine.id)).length > 1) {
        throw new Error(`serialized line ${parentLine.id} can only belong to one child shipment`);
      }
    }

    this.assertSerialsAvailable(parent.tenantId, groups.flat(), [parent.id]);
    this.assertAllocationCoverage(parent, groups);
  }

  /** Child allocations per (line, stock) must match what the parent reserved, in total. */
  private assertAllocationCoverage(parent: Shipment, groups: ShipmentLine[][]): void {
    const parentByLineStock = this.sumAllocations(parent.id, (allocation) => `${allocation.lineId}|${allocation.stockId}`);
    if (parentByLineStock.size === 0) return;
    const childByLineStock = new Map<string, number>();
    for (const group of groups) {
      for (const line of group) {
        if (!line.stockId) throw new Error(`line ${line.id} must carry the parent stock reference`);
        const bucket = `${line.id}|${line.stockId}`;
        childByLineStock.set(bucket, (childByLineStock.get(bucket) ?? 0) + line.quantity);
      }
    }
    for (const [bucket, quantity] of parentByLineStock) {
      if (childByLineStock.get(bucket) !== quantity) throw new Error(`split does not preserve stock allocation for ${bucket}`);
    }
  }

  /** Dry-run check: creating these allocations must not over-commit any stock. */
  private assertStockAvailable(tenantId: string, lines: ShipmentLine[]): void {
    const demand = new Map<string, number>();
    for (const line of lines) {
      if (!line.stockId) continue;
      demand.set(line.stockId, (demand.get(line.stockId) ?? 0) + line.quantity);
    }
    for (const [stockId, quantity] of demand) {
      const stock = this.store.stocks.get(stockId);
      if (!stock || stock.tenantId !== tenantId) throw new Error(`stock ${stockId} not found`);
      if (stock.quantity - stock.reserved < quantity) throw new Error(`insufficient available stock ${stockId}`);
    }
    for (const line of lines) {
      if (!line.serialNumber) continue;
      const stock = this.store.stocks.get(line.stockId ?? '');
      if (!stock || stock.kind !== 'SERIALIZED' || stock.serialNumber !== line.serialNumber || line.quantity !== 1) {
        throw new Error(`serialized line ${line.id} does not match stock ${line.stockId ?? ''}`);
      }
    }
  }

  private buildCreateAllocations(shipment: Shipment, lines: ShipmentLine[]): ShipmentAllocation[] {
    return lines.flatMap((line) => {
      if (!line.stockId) return [];
      const stock = this.store.stocks.get(line.stockId);
      if (!stock) throw new Error(`stock ${line.stockId} not found`);
      stock.reserved += line.quantity;
      stock.version += 1;
      const allocation: ShipmentAllocation = {
        id: `${shipment.id}:${line.id}:${line.stockId}`,
        tenantId: shipment.tenantId,
        shipmentId: shipment.id,
        lineId: line.id,
        stockId: stock.id,
        quantity: line.quantity,
        status: 'ACTIVE',
        version: 1,
      };
      this.store.addAudit(shipment.tenantId, 'shipment.inventory-reserved', 'shipment-allocation', allocation.id, { stockId: stock.id, lineId: line.id, quantity: line.quantity });
      return [allocation];
    });
  }

  private createChildAllocations(parent: Shipment, child: Shipment): void {
    for (const line of child.lines) {
      if (!line.stockId) continue;
      const allocation: ShipmentAllocation = {
        id: `${child.id}:${line.id}:${line.stockId}`,
        tenantId: child.tenantId,
        shipmentId: child.id,
        lineId: line.id,
        stockId: line.stockId,
        quantity: line.quantity,
        status: 'ACTIVE',
        version: 1,
      };
      this.store.shipmentAllocations.set(allocation.id, allocation);
      this.store.addAudit(child.tenantId, 'shipment.inventory-transferred', 'shipment-allocation', allocation.id, { stockId: line.stockId, lineId: line.id, quantity: line.quantity, from: parent.id, to: child.id });
    }
  }

  private recreateParentAllocations(parent: Shipment, key: string): void {
    for (const line of parent.lines) {
      if (!line.stockId) continue;
      const allocation: ShipmentAllocation = {
        id: `${parent.id}:${line.id}:${line.stockId}:rb:${key}`,
        tenantId: parent.tenantId,
        shipmentId: parent.id,
        lineId: line.id,
        stockId: line.stockId,
        quantity: line.quantity,
        status: 'ACTIVE',
        version: 1,
      };
      this.store.shipmentAllocations.set(allocation.id, allocation);
      this.store.addAudit(parent.tenantId, 'shipment.inventory-transferred', 'shipment-allocation', allocation.id, { stockId: line.stockId, lineId: line.id, quantity: line.quantity, from: 'children', to: parent.id });
    }
  }

  private releaseAllocations(shipmentId: string, reason: string): void {
    for (const allocation of this.store.shipmentAllocations.values()) {
      if (allocation.shipmentId !== shipmentId || allocation.status !== 'ACTIVE') continue;
      allocation.status = 'RELEASED';
      allocation.version += 1;
      this.store.addAudit(allocation.tenantId, 'shipment.allocation-released', 'shipment-allocation', allocation.id, { reason, quantity: allocation.quantity });
    }
  }

  private sumAllocations(shipmentId: string, keyOf: (allocation: ShipmentAllocation) => string): Map<string, number> {
    const totals = new Map<string, number>();
    for (const allocation of this.store.shipmentAllocations.values()) {
      if (allocation.shipmentId !== shipmentId || allocation.status !== 'ACTIVE') continue;
      const key = keyOf(allocation);
      totals.set(key, (totals.get(key) ?? 0) + allocation.quantity);
    }
    return totals;
  }

  /** A serialized part may be carried by at most one ACTIVE shipment at a time. */
  private assertSerialsAvailable(tenantId: string, lines: ShipmentLine[], excludeShipmentIds: string[]): void {
    const excluded = new Set(excludeShipmentIds);
    const claimed = new Map<string, string>();
    for (const shipment of this.store.shipments.values()) {
      if (shipment.tenantId !== tenantId || shipment.status !== 'ACTIVE' || excluded.has(shipment.id)) continue;
      for (const line of shipment.lines) {
        if (line.serialNumber) claimed.set(line.serialNumber, shipment.id);
      }
    }
    const local = new Set<string>();
    for (const line of lines) {
      if (!line.serialNumber) continue;
      const owner = claimed.get(line.serialNumber);
      if (owner) throw new Error(`serialized part ${line.serialNumber} already belongs to active shipment ${owner}`);
      if (local.has(line.serialNumber)) throw new Error(`serialized part ${line.serialNumber} listed more than once`);
      local.add(line.serialNumber);
    }
  }

  private assertCustomsVoidable(shipmentIds: string[]): void {
    for (const shipmentId of shipmentIds) {
      for (const declaration of this.store.customs.values()) {
        if (declaration.shipmentId !== shipmentId) continue;
        if (declaration.status === 'SUBMITTED' || declaration.status === 'INSPECTION' || declaration.status === 'RELEASED') {
          throw new Error(`shipment ${shipmentId} has a customs declaration in status ${declaration.status}`);
        }
      }
    }
  }

  /**
   * Rebuild the customs quantity projection for one order from ACTIVE shipments only.
   * The parent is SPLIT (not ACTIVE) while children are ACTIVE, so the two can never both count;
   * after rollback the inverse holds. This is what keeps order line quantities counted exactly once.
   */
  private rebuildCustomsProjection(orderId: string): void {
    const effective = new Map<string, number>();
    const rootQuantities = new Map<string, number>();
    for (const shipment of this.store.shipments.values()) {
      if (shipment.orderId !== orderId) continue;
      if (!shipment.parentId && shipment.status !== 'CANCELLED') {
        for (const line of shipment.lines) {
          const key = CustomsService.lineKey(shipment.tenantId, orderId, line.id);
          rootQuantities.set(key, (rootQuantities.get(key) ?? 0) + line.quantity);
        }
      }
      if (shipment.status !== 'ACTIVE') continue;
      for (const line of shipment.lines) {
        const key = CustomsService.lineKey(shipment.tenantId, orderId, line.id);
        effective.set(key, (effective.get(key) ?? 0) + line.quantity);
      }
    }
    for (const [key, quantity] of effective) {
      const root = rootQuantities.get(key);
      if (root === undefined || quantity > root) throw new Error(`customs quantity ${quantity} for ${key} exceeds order line quantity ${root ?? 0}`);
    }
    const tenants = new Set<string>();
    for (const shipment of this.store.shipments.values()) {
      if (shipment.orderId === orderId) tenants.add(shipment.tenantId);
    }
    for (const tenantId of tenants) {
      const prefix = `${tenantId}|${orderId}|`;
      for (const key of [...this.store.customsLines.keys()]) {
        if (key.startsWith(prefix)) this.store.customsLines.delete(key);
      }
    }
    for (const [key, quantity] of effective) this.store.customsLines.set(key, quantity);
  }

  private mustGetShipment(id: string): Shipment {
    const shipment = this.store.shipments.get(id);
    if (!shipment) throw new Error(`shipment ${id} missing`);
    return shipment;
  }

  private requestKey(parentId: string, key: string): string {
    return `${parentId}|${key}`;
  }

  private childShipmentId(parentId: string, key: string, index: number): string {
    return `${parentId}:child:${index}:${key}`;
  }

  private autoKey(parentId: string, groups: ShipmentLine[][]): string {
    return `auto-${this.hashGroups(groups)}-${parentId}`;
  }

  private hashGroups(groups: ShipmentLine[][]): string {
    const normalized = groups.map((group) => group.map((line) => ({
      id: line.id,
      partNumber: line.partNumber,
      serialNumber: line.serialNumber ?? null,
      stockId: line.stockId ?? null,
      quantity: line.quantity,
    })));
    const json = JSON.stringify(normalized);
    let hash = 0;
    for (let i = 0; i < json.length; i += 1) {
      hash = (Math.imul(31, hash) + json.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
}
