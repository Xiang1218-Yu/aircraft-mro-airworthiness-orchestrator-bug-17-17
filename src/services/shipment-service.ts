import type { Shipment, ShipmentLine } from '../domain/types.js';
import { Store } from '../store/store.js';

export interface SplitOptions {
  requestId?: string;
  tenantId?: string;
}

export interface CustomsQuantity {
  lineId: string;
  quantity: number;
}

export class ShipmentService {
  constructor(private readonly store: Store) {}

  create(orderId: string, lines: ShipmentLine[], tenantId?: string): Shipment {
    const shipment: Shipment = {
      id: this.store.nextId('shipment'),
      ...(tenantId !== undefined ? { tenantId } : {}),
      orderId,
      status: 'ACTIVE',
      lines: lines.map((line) => ({ ...line })),
    };
    this.store.shipments.set(shipment.id, shipment);
    // Re-derive the customs projection so create/import stays consistent as well.
    this.rebuildCustomsLines();
    return shipment;
  }

  /**
   * Split one active shipment into independent child shipments.
   *
   * Idempotency contract:
   *  - the same `requestId` replayed with the same groups returns the original children;
   *  - the same `requestId` with different groups is rejected as a conflict;
   *  - after a rollback the same `requestId` may be replayed and yields a fresh batch;
   *  - all validation runs before any state change, so a failed attempt leaves no trace;
   *  - customs quantities are rebuilt from active shipments only, hence never double counted.
   */
  split(parentId: string, groups: ShipmentLine[][], options: SplitOptions = {}): Shipment[] {
    const parent = this.store.shipments.get(parentId);
    if (!parent) throw new Error('shipment not found');
    if (parent.status === 'CANCELLED') throw new Error('cannot split a cancelled shipment');

    const canonicalGroups = this.canonicalizeGroups(groups);
    const fingerprint = this.fingerprint(parent, canonicalGroups);
    const tenantId = options.tenantId ?? parent.tenantId;

    if (options.requestId) {
      const prior = this.store.shipmentSplitRequests.get(options.requestId);
      if (prior) {
        if (prior.parentId !== parentId) throw new Error('split request id conflicts with another shipment');
        if (prior.fingerprint !== fingerprint) throw new Error('split request id conflicts with a different split plan');
        if (prior.status === 'ACTIVE') {
          // Idempotent replay: return exactly the children created by the first call.
          return prior.childrenIds.map((id) => this.requireShipment(id));
        }
        // ROLLED_BACK replay: fall through and create a fresh batch under the same requestId.
      }
    } else if (parent.status === 'SPLIT') {
      throw new Error('shipment already split; supply the original requestId for an idempotent retry');
    }

    if (parent.status === 'SPLIT') {
      // Re-splitting without the matching request id is never allowed.
      throw new Error('shipment already split');
    }

    // Everything below validates before any mutation, so failure is side-effect free.
    this.validateSerializedOwnership(parent, canonicalGroups);
    this.validateGroups(parent, canonicalGroups);

    // Mutation phase: create children first (nothing references them yet if id generation throws).
    const children: Shipment[] = canonicalGroups.map((lines) => {
      const child: Shipment = {
        id: this.store.nextId('shipment'),
        ...(tenantId !== undefined ? { tenantId } : {}),
        orderId: parent.orderId,
        parentId: parent.id,
        ...(options.requestId ? { splitRequestId: options.requestId } : {}),
        status: 'ACTIVE',
        lines: lines.map((line) => ({ ...line })),
      };
      this.store.shipments.set(child.id, child);
      return child;
    });

    parent.status = 'SPLIT';
    if (tenantId !== undefined) parent.tenantId = parent.tenantId ?? tenantId;

    if (options.requestId) {
      this.store.shipmentSplitRequests.set(options.requestId, {
        requestId: options.requestId,
        parentId: parent.id,
        fingerprint,
        childrenIds: children.map((child) => child.id),
        status: 'ACTIVE',
      });
    }

    // Parent lines disappear from the projection (SPLIT), children appear (ACTIVE):
    // every order line is therefore counted exactly once, regardless of retry history.
    this.rebuildCustomsLines();

    this.store.addAudit(
      tenantId ?? '',
      'shipment.split',
      'shipment',
      parent.id,
      { requestId: options.requestId ?? '', childCount: children.length },
    );
    this.store.addOutbox(tenantId ?? '', 'mro.shipment-split', parent.id, {
      parentId: parent.id,
      childIds: children.map((child) => child.id),
      ...(options.requestId ? { requestId: options.requestId } : {}),
    });

    return children;
  }

  /**
   * Undo a split: restore the parent and cancel every active child.
   * Idempotent — rolling back an ACTIVE (never split) shipment is a no-op.
   * Refused when customs has released a declaration for a child, or when a
   * child was itself split; those situations cannot be unilaterally unwound.
   */
  rollbackSplit(parentId: string, requestId?: string): void {
    const parent = this.store.shipments.get(parentId);
    if (!parent) throw new Error('shipment not found');
    if (parent.status === 'CANCELLED') throw new Error('cannot roll back a cancelled shipment');
    if (parent.status === 'ACTIVE') return; // already rolled back / never split

    const children = [...this.store.shipments.values()].filter(
      (shipment) => shipment.parentId === parentId && shipment.status !== 'CANCELLED',
    );
    if (children.length === 0) {
      // State already rolled back but parent flag lagged; finish idempotently.
      parent.status = 'ACTIVE';
      this.rebuildCustomsLines();
      return;
    }

    for (const child of children) {
      if (child.status === 'SPLIT') throw new Error(`cannot roll back: child shipment ${child.id} was split`);
      for (const declaration of this.store.customs.values()) {
        if (declaration.shipmentId === child.id && declaration.status === 'RELEASED') {
          throw new Error(`cannot roll back: customs declaration ${declaration.id} for ${child.id} is released`);
        }
      }
    }

    for (const child of children) {
      child.status = 'CANCELLED';
      this.store.addAudit(
        child.tenantId ?? parent.tenantId ?? '',
        'shipment.split-rollback-child',
        'shipment',
        child.id,
        { parentId: parent.id },
      );
    }

    parent.status = 'ACTIVE';

    if (requestId) {
      const request = this.store.shipmentSplitRequests.get(requestId);
      if (request && request.parentId === parentId) request.status = 'ROLLED_BACK';
    }
    // Also mark the id embedded on children / parent if the caller did not pass it.
    for (const child of children) {
      if (child.splitRequestId) {
        const request = this.store.shipmentSplitRequests.get(child.splitRequestId);
        if (request && request.parentId === parentId) request.status = 'ROLLED_BACK';
      }
    }

    this.rebuildCustomsLines();

    this.store.addAudit(parent.tenantId ?? '', 'shipment.split-rolled-back', 'shipment', parent.id, {
      childCount: children.length,
    });
    this.store.addOutbox(parent.tenantId ?? '', 'mro.shipment-split-rolled-back', parent.id, {
      parentId: parent.id,
      childIds: children.map((child) => child.id),
    });
  }

  /** Customs quantities aggregated from ACTIVE shipments only, one line id counted once. */
  customsQuantity(lineId: string): number {
    return this.store.customsLines.get(lineId) ?? 0;
  }

  customsQuantities(): CustomsQuantity[] {
    return [...this.store.customsLines.entries()]
      .filter(([, quantity]) => quantity !== 0)
      .map(([lineId, quantity]) => ({ lineId, quantity }));
  }

  private rebuildCustomsLines(): void {
    this.store.customsLines.clear();
    for (const shipment of this.store.shipments.values()) {
      if (shipment.status !== 'ACTIVE') continue;
      for (const line of shipment.lines) {
        this.store.customsLines.set(line.id, (this.store.customsLines.get(line.id) ?? 0) + line.quantity);
      }
    }
  }

  private canonicalizeGroups(groups: ShipmentLine[][]): ShipmentLine[][] {
    if (groups.length === 0) throw new Error('split requires at least one group');
    return groups.map((group) => {
      if (group.length === 0) throw new Error('split groups must not be empty');
      return group.map((line) => ({ ...line }));
    });
  }

  private validateGroups(parent: Shipment, groups: ShipmentLine[][]): void {
    const parentLines = new Map(parent.lines.map((line) => [line.id, line]));
    const allocated = new Map<string, number>();

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      for (const line of groups[groupIndex]!) {
        const source = parentLines.get(line.id);
        if (!source) throw new Error(`line ${line.id} does not belong to shipment ${parent.id}`);
        if (line.orderId !== source.orderId || line.partNumber !== source.partNumber
          || line.serialNumber !== source.serialNumber) {
          throw new Error(`line ${line.id} was modified during split`);
        }
        if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
          throw new Error(`line ${line.id} quantity must be a positive integer`);
        }
        if (line.serialNumber !== undefined && line.quantity !== 1) {
          throw new Error(`serialized line ${line.id} must be moved as a single unit`);
        }
        allocated.set(line.id, (allocated.get(line.id) ?? 0) + line.quantity);
      }
    }

    // Every parent order line must be consumed exactly once in total quantity.
    for (const source of parent.lines) {
      const total = allocated.get(source.id) ?? 0;
      if (total !== source.quantity) {
        throw new Error(
          `line ${source.id} allocation ${total} does not match shipment quantity ${source.quantity}`,
        );
      }
    }
  }

  private validateSerializedOwnership(parent: Shipment, groups: ShipmentLine[][]): void {
    // A serial number may appear in at most one child group of this split...
    const seen = new Set<string>();
    for (const group of groups) {
      const groupSerials = new Set<string>();
      for (const line of group) {
        if (line.serialNumber === undefined) continue;
        const key = `${line.orderId}|${line.partNumber}|${line.serialNumber}`;
        if (groupSerials.has(key) || seen.has(key)) {
          throw new Error(`serial number ${line.serialNumber} is assigned to more than one child shipment`);
        }
        groupSerials.add(key);
        seen.add(key);
      }
    }

    // ...and it must not already live on another effective (ACTIVE) shipment.
    for (const key of seen) {
      for (const shipment of this.store.shipments.values()) {
        if (shipment.id === parent.id || shipment.status !== 'ACTIVE' || shipment.orderId !== parent.orderId) continue;
        for (const line of shipment.lines) {
          if (line.serialNumber === undefined) continue;
          if (`${line.orderId}|${line.partNumber}|${line.serialNumber}` === key) {
            throw new Error(`serial number ${line.serialNumber} already belongs to active shipment ${shipment.id}`);
          }
        }
      }
    }
  }

  private fingerprint(parent: Shipment, groups: ShipmentLine[][]): string {
    const payload = JSON.stringify({
      orderId: parent.orderId,
      groups: groups.map((group) =>
        group
          .map((line) => ({ id: line.id, quantity: line.quantity }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      ),
    });
    // FNV-1a over the canonical payload; the embedded full canonical string makes
    // the conflict check character-for-character exact.
    let hash = 0x811c9dc5;
    for (let index = 0; index < payload.length; index += 1) {
      hash ^= payload.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${hash.toString(16).padStart(8, '0')}:${payload}`;
  }

  private requireShipment(id: string): Shipment {
    const shipment = this.store.shipments.get(id);
    if (!shipment) throw new Error(`shipment ${id} referenced by split request is missing`);
    return shipment;
  }
}
