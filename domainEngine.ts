import {
  Batch,
  BatchStatus,
  ConflictType,
  Medicine,
  PackHierarchy,
  PackUnit,
  PrescriptionInput,
  SaleLineAllocation,
  SaleRecord,
  TransferStatus,
} from './types';

// ============================================================================
// 1. COMPOSITE PATTERN: Pack Hierarchy Converter (Box -> Strip -> Tablet)
// ============================================================================
export interface PackNode {
  unit: PackUnit;
  toBaseUnits(qty: number): number;
  describe(): string;
}

export class TabletUnit implements PackNode {
  unit = PackUnit.TABLET;
  toBaseUnits(qty: number): number {
    return Math.round(qty);
  }
  describe(): string {
    return '1 base unit';
  }
}

export class StripPack implements PackNode {
  unit = PackUnit.STRIP;
  constructor(private readonly tabletsPerStrip: number, private readonly child: TabletUnit = new TabletUnit()) {}
  toBaseUnits(qty: number): number {
    return this.child.toBaseUnits(qty * Math.max(1, this.tabletsPerStrip));
  }
  describe(): string {
    return `1 strip = ${this.tabletsPerStrip} units`;
  }
}

export class BoxPack implements PackNode {
  unit = PackUnit.BOX;
  private readonly strip: StripPack;
  constructor(private readonly hierarchy: PackHierarchy) {
    this.strip = new StripPack(hierarchy.tabletsPerStrip);
  }
  toBaseUnits(qty: number): number {
    return this.strip.toBaseUnits(qty * Math.max(1, this.hierarchy.stripsPerBox));
  }
  describe(): string {
    const total = Math.max(1, this.hierarchy.stripsPerBox) * Math.max(1, this.hierarchy.tabletsPerStrip);
    return `1 box = ${this.hierarchy.stripsPerBox} strips (${total} units)`;
  }
}

export function convertToBaseUnits(qty: number, unit: PackUnit, hierarchy: PackHierarchy): number {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error('Quantity must be a positive number.');
  }
  switch (unit) {
    case PackUnit.BOX:
      return new BoxPack(hierarchy).toBaseUnits(qty);
    case PackUnit.STRIP:
      return new StripPack(hierarchy.tabletsPerStrip).toBaseUnits(qty);
    case PackUnit.TABLET:
    default:
      return new TabletUnit().toBaseUnits(qty);
  }
}

export function formatPackBreakdown(baseUnits: number, hierarchy: PackHierarchy): string {
  const perStrip = Math.max(1, hierarchy.tabletsPerStrip);
  const perBox = perStrip * Math.max(1, hierarchy.stripsPerBox);
  if (perBox === 1 && perStrip === 1) return `${baseUnits} units`;
  const boxes = Math.floor(baseUnits / perBox);
  const remAfterBoxes = baseUnits % perBox;
  const strips = Math.floor(remAfterBoxes / perStrip);
  const tablets = remAfterBoxes % perStrip;
  const parts: string[] = [];
  if (boxes > 0) parts.push(`${boxes} box`);
  if (strips > 0) parts.push(`${strips} strip`);
  if (tablets > 0 || parts.length === 0) parts.push(`${tablets} unit`);
  return parts.join(' · ');
}

// ============================================================================
// 2. STRATEGY PATTERN: Batch Expiry Classification & FEFO Allocation
// ============================================================================
export function evaluateBatchStatus(
  batch: Pick<Batch, 'expiryDate' | 'quantity' | 'status' | 'recalledAt'>,
  referenceDate: Date = new Date()
): BatchStatus {
  if (batch.status === BatchStatus.RECALLED || batch.recalledAt) {
    return BatchStatus.RECALLED;
  }
  const expiry = new Date(batch.expiryDate);
  const refMidnight = new Date(referenceDate.toISOString().slice(0, 10));
  if (expiry.getTime() <= refMidnight.getTime()) {
    return BatchStatus.EXPIRED;
  }
  if (batch.quantity <= 0) {
    return BatchStatus.DEPLETED;
  }
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  if (expiry.getTime() - refMidnight.getTime() <= ninetyDaysMs) {
    return BatchStatus.EXPIRING_SOON;
  }
  return BatchStatus.ACTIVE;
}

export interface BatchAllocationResult {
  allocations: Array<{
    batch: Batch;
    unitsAllocated: number;
  }>;
  totalAllocated: number;
}

export interface BatchSelectionStrategy {
  allocate(batches: Batch[], requiredBaseUnits: number, referenceDate?: Date): BatchAllocationResult;
}

export class FefoBatchSelectionStrategy implements BatchSelectionStrategy {
  allocate(batches: Batch[], requiredBaseUnits: number, referenceDate: Date = new Date()): BatchAllocationResult {
    if (requiredBaseUnits <= 0) {
      throw new Error('Required base units must be greater than zero.');
    }

    const eligible = batches
      .filter((b) => {
        const status = evaluateBatchStatus(b, referenceDate);
        return (
          status !== BatchStatus.EXPIRED &&
          status !== BatchStatus.RECALLED &&
          b.quantity > 0
        );
      })
      .sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());

    const totalAvailable = eligible.reduce((sum, b) => sum + b.quantity, 0);
    if (totalAvailable < requiredBaseUnits) {
      const hasRecalled = batches.some((b) => evaluateBatchStatus(b, referenceDate) === BatchStatus.RECALLED && b.quantity > 0);
      const hasExpired = batches.some((b) => evaluateBatchStatus(b, referenceDate) === BatchStatus.EXPIRED && b.quantity > 0);
      if (totalAvailable === 0 && hasRecalled) {
        throw new Error('Batch is blocked due to an active safety recall.');
      }
      if (totalAvailable === 0 && hasExpired) {
        throw new Error('Available stock is expired and cannot be dispensed.');
      }
      throw new Error(
        `Insufficient non-expired, non-recalled stock. Requested ${requiredBaseUnits} units, available ${totalAvailable} units.`
      );
    }

    const allocations: Array<{ batch: Batch; unitsAllocated: number }> = [];
    let remaining = requiredBaseUnits;

    for (const batch of eligible) {
      if (remaining <= 0) break;
      const take = Math.min(batch.quantity, remaining);
      allocations.push({ batch, unitsAllocated: take });
      remaining -= take;
    }

    return {
      allocations,
      totalAllocated: requiredBaseUnits,
    };
  }
}

export const fefoStrategy = new FefoBatchSelectionStrategy();

// ============================================================================
// 3. PRESCRIPTION COMPLIANCE GUARD (QA4)
// ============================================================================
export interface PrescriptionValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

export function validatePrescriptionRequirement(
  requiresPrescription: boolean,
  prescription?: PrescriptionInput | null
): PrescriptionValidationResult {
  if (!requiresPrescription) {
    return { valid: true, errors: {} };
  }
  const errors: Record<string, string> = {};
  if (!prescription) {
    return {
      valid: false,
      errors: {
        prescription: 'Prescription-only medicine requires prescriber registration number, patient name, and prescription date.',
      },
    };
  }
  if (!prescription.prescriberRegNo || prescription.prescriberRegNo.trim().length < 3) {
    errors.prescriberRegNo = 'Valid prescriber registration number is required.';
  }
  if (!prescription.patientName || prescription.patientName.trim().length < 2) {
    errors.patientName = 'Patient full name is required.';
  }
  if (!prescription.prescriptionDate || Number.isNaN(Date.parse(prescription.prescriptionDate))) {
    errors.prescriptionDate = 'Valid prescription date is required.';
  }
  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

// ============================================================================
// 4. STATE PATTERN: Branch Transfer Workflow (DISPATCHED -> IN_TRANSIT -> RECEIVED)
// ============================================================================
const VALID_TRANSFER_TRANSITIONS: Record<TransferStatus, TransferStatus[]> = {
  [TransferStatus.DISPATCHED]: [TransferStatus.IN_TRANSIT],
  [TransferStatus.IN_TRANSIT]: [TransferStatus.RECEIVED],
  [TransferStatus.RECEIVED]: [],
};

export function assertTransferTransition(current: TransferStatus, next: TransferStatus): void {
  const allowed = VALID_TRANSFER_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`Invalid transfer state transition: ${current} -> ${next}`);
  }
}

export function computeTransferDiscrepancy(dispatchedQty: number, receivedQty: number): number {
  if (receivedQty < 0) {
    throw new Error('Received quantity cannot be negative.');
  }
  return receivedQty - dispatchedQty;
}

// ============================================================================
// 5. DETERMINISTIC CONFLICT RESOLUTION ENGINE (Module 7)
// ============================================================================
export interface ConflictEvaluationInput {
  operationId: string;
  isDuplicateOperation: boolean;
  saleUnitPrice?: number;
  centralUnitPrice?: number;
  saleTimestamp?: string;
  batchRecalledAt?: string | null;
  resultingCentralStock?: number;
}

export interface ConflictDecision {
  conflictType: ConflictType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  rejectOperation: boolean;
  preserveSalePrice: boolean;
  createStockCountTask: boolean;
  flagPostRecallIncident: boolean;
  priceDifference?: number;
  resolutionRule: string;
  summary: string;
}

export function evaluateSyncConflicts(input: ConflictEvaluationInput): ConflictDecision[] {
  const decisions: ConflictDecision[] = [];

  // Rule 1: Duplicate operation idempotency check
  if (input.isDuplicateOperation) {
    decisions.push({
      conflictType: ConflictType.DUPLICATE_OPERATION,
      severity: 'LOW',
      rejectOperation: true,
      preserveSalePrice: false,
      createStockCountTask: false,
      flagPostRecallIncident: false,
      resolutionRule: 'IDEMPOTENT_DEDUP: Operation ID already acknowledged by Head Office; duplicate processing safely rejected.',
      summary: `Duplicate operation ${input.operationId} safely ignored.`,
    });
    return decisions;
  }

  // Rule 2: Sale made using an old price while offline
  if (
    typeof input.saleUnitPrice === 'number' &&
    typeof input.centralUnitPrice === 'number' &&
    Math.abs(input.saleUnitPrice - input.centralUnitPrice) > 0.001
  ) {
    const diff = Number((input.saleUnitPrice - input.centralUnitPrice).toFixed(2));
    decisions.push({
      conflictType: ConflictType.OLD_PRICE_SALE,
      severity: 'MEDIUM',
      rejectOperation: false,
      preserveSalePrice: true,
      createStockCountTask: false,
      flagPostRecallIncident: false,
      priceDifference: diff,
      resolutionRule: 'PRESERVE_POS_PRICE: Original point-of-sale price preserved for fiscal accuracy; variance logged for Head Office reconciliation.',
      summary: `Offline sale used unit price $${input.saleUnitPrice.toFixed(2)} vs central $${input.centralUnitPrice.toFixed(2)} (diff ${diff >= 0 ? '+' : ''}$${diff.toFixed(2)}).`,
    });
  }

  // Rule 3: Batch recalled while branch was offline
  if (input.batchRecalledAt && input.saleTimestamp) {
    if (new Date(input.saleTimestamp).getTime() >= new Date(input.batchRecalledAt).getTime()) {
      decisions.push({
        conflictType: ConflictType.POST_RECALL_SALE,
        severity: 'CRITICAL',
        rejectOperation: false,
        preserveSalePrice: true,
        createStockCountTask: false,
        flagPostRecallIncident: true,
        resolutionRule: 'FLAG_POST_RECALL_DISPENSE: Sale occurred offline after central recall timestamp; transaction flagged for immediate pharmacovigilance patient follow-up.',
        summary: `Offline sale timestamp (${input.saleTimestamp}) occurred after central recall timestamp (${input.batchRecalledAt}).`,
      });
    }
  }

  // Rule 4: Negative stock after synchronization
  if (typeof input.resultingCentralStock === 'number' && input.resultingCentralStock < 0) {
    decisions.push({
      conflictType: ConflictType.NEGATIVE_STOCK,
      severity: 'HIGH',
      rejectOperation: false,
      preserveSalePrice: true,
      createStockCountTask: true,
      flagPostRecallIncident: false,
      resolutionRule: 'AUTO_STOCK_COUNT_TASK: Resulting central inventory dropped below zero; stock-count reconciliation task automatically assigned to branch.',
      summary: `Post-sync batch inventory reached ${input.resultingCentralStock} units; physical stock count required.`,
    });
  }

  return decisions;
}

// ============================================================================
// 6. REORDER CALCULATION STRATEGY (Module 11)
// ============================================================================
export interface ReorderInputs {
  last30DaysSold: number;
  leadTimeDays: number;
  safetyStock: number;
  currentStock: number;
  pendingIncomingTransfers: number;
}

export interface ReorderResult {
  dailySalesVelocity: number;
  suggestedOrderQty: number;
  urgency: 'CRITICAL' | 'LOW' | 'HEALTHY';
}

export function calculateReorderSuggestion(inputs: ReorderInputs): ReorderResult {
  const dailySalesVelocity = Number((Math.max(0, inputs.last30DaysSold) / 30).toFixed(2));
  const reorderPoint = Math.ceil(dailySalesVelocity * Math.max(1, inputs.leadTimeDays) + Math.max(0, inputs.safetyStock));
  const effectiveStock = Math.max(0, inputs.currentStock) + Math.max(0, inputs.pendingIncomingTransfers);
  const targetStock = Math.ceil(reorderPoint + dailySalesVelocity * 14); // 14-day replenishment buffer
  const suggestedOrderQty = effectiveStock < reorderPoint ? Math.max(0, targetStock - effectiveStock) : 0;

  let urgency: 'CRITICAL' | 'LOW' | 'HEALTHY' = 'HEALTHY';
  if (effectiveStock <= inputs.safetyStock || effectiveStock === 0) {
    urgency = 'CRITICAL';
  } else if (effectiveStock < reorderPoint) {
    urgency = 'LOW';
  }

  return {
    dailySalesVelocity,
    suggestedOrderQty,
    urgency,
  };
}

// ============================================================================
// 7. EXPONENTIAL BACKOFF STRATEGY (Offline Sync Retry)
// ============================================================================
export function calculateBackoffDelayMs(retryCount: number, baseMs = 2000, maxMs = 300_000): number {
  const exponent = Math.max(0, Math.min(retryCount, 10));
  return Math.min(maxMs, baseMs * Math.pow(2, exponent));
}

// ============================================================================
// 8. OBSERVER PATTERN: Lightweight Domain Event Bus
// ============================================================================
export type DomainEvent =
  | { type: 'SALE_COMPLETED'; payload: { saleId: string; branchId: string; totalAmount: number } }
  | { type: 'BATCH_RECALLED'; payload: { batchNumber: string; medicineId: string; recalledAt: string } }
  | { type: 'CONFLICT_DETECTED'; payload: { operationId: string; conflictType: ConflictType; branchId: string } }
  | { type: 'TRANSFER_UPDATED'; payload: { transferId: string; status: TransferStatus } };

type EventListener = (event: DomainEvent) => void;

export class DomainEventBus {
  private listeners = new Map<DomainEvent['type'], Set<EventListener>>();

  subscribe(type: DomainEvent['type'], listener: EventListener): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
    return () => {
      this.listeners.get(type)?.delete(listener);
    };
  }

  publish(event: DomainEvent): void {
    const handlers = this.listeners.get(event.type);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(event);
    }
  }
}

export const domainEvents = new DomainEventBus();

// ============================================================================
// 9. ADAPTER PATTERN: Mock Thermal Receipt Printer Adapter
// ============================================================================
export interface ReceiptPrinterAdapter {
  readonly adapterName: string;
  formatReceipt(sale: SaleRecord, branchName: string, branchAddress?: string): string;
}

export class ThermalReceiptPrinterAdapter implements ReceiptPrinterAdapter {
  readonly adapterName = 'ESC/POS 80mm Thermal Adapter (Mock)';

  formatReceipt(sale: SaleRecord, branchName: string, branchAddress = 'Licensed Retail Pharmacy'): string {
    const divider = '------------------------------------------';
    const lines: string[] = [
      '                PHARMASYNC                ',
      branchName.slice(0, 42).padStart(Math.floor((42 + Math.min(42, branchName.length)) / 2)),
      branchAddress.slice(0, 42),
      divider,
      `Invoice:  ${sale.invoiceNumber}`,
      `Date:     ${new Date(sale.createdAt).toLocaleString()}`,
      `Cashier:  ${sale.cashierName}`,
      `Payment:  ${sale.paymentMethod}`,
      `Mode:     ${sale.createdOffline ? 'OFFLINE QUEUED' : 'ONLINE SYNCED'}`,
      divider,
      'ITEM                 QTY   PRICE    TOTAL',
    ];

    for (const item of sale.items) {
      const name = item.medicineName.slice(0, 20).padEnd(20);
      const qty = `${item.packQuantity}${item.packUnit[0]}`.padStart(4);
      const price = item.unitPrice.toFixed(2).padStart(7);
      const total = item.lineTotal.toFixed(2).padStart(8);
      lines.push(`${name} ${qty} ${price} ${total}`);
      lines.push(`  Batch: ${item.batchNumber} | Exp: ${item.expiryDate}`);
    }

    lines.push(divider);
    lines.push(`Subtotal:                        $${sale.subtotal.toFixed(2).padStart(8)}`);
    if (sale.discountAmount > 0) {
      lines.push(`Discount (${sale.discountPercent}%):                 -$${sale.discountAmount.toFixed(2).padStart(7)}`);
    }
    lines.push(`Tax:                             $${sale.taxAmount.toFixed(2).padStart(8)}`);
    lines.push(`TOTAL PAID:                      $${sale.totalAmount.toFixed(2).padStart(8)}`);

    if (sale.prescription) {
      lines.push(divider);
      lines.push('PRESCRIPTION RECORD');
      lines.push(`Patient:    ${sale.prescription.patientName}`);
      lines.push(`Prescriber: ${sale.prescription.prescriberRegNo}`);
      lines.push(`Rx Date:    ${sale.prescription.prescriptionDate}`);
    }

    lines.push(divider);
    lines.push('  FEFO Verified · Keep Out of Reach of');
    lines.push('  Children · Thank you for visiting');
    return lines.join('\n');
  }
}

export const receiptPrinter = new ThermalReceiptPrinterAdapter();

// Helper to build cart pricing cleanly
export function calculateCartTotals(
  items: SaleLineAllocation[],
  discountPercent: number,
  taxRate = 0.05
): { subtotal: number; discountAmount: number; taxAmount: number; totalAmount: number } {
  const safeDiscount = Math.min(50, Math.max(0, Number.isFinite(discountPercent) ? discountPercent : 0));
  const subtotal = Number(items.reduce((sum, i) => sum + i.lineTotal, 0).toFixed(2));
  const discountAmount = Number(((subtotal * safeDiscount) / 100).toFixed(2));
  const taxable = Math.max(0, subtotal - discountAmount);
  const taxAmount = Number((taxable * taxRate).toFixed(2));
  const totalAmount = Number((taxable + taxAmount).toFixed(2));
  return { subtotal, discountAmount, taxAmount, totalAmount };
}

export function buildMedicineSearchText(med: Medicine): string {
  return `${med.brandName} ${med.genericName} ${med.strength} ${med.barcode} ${med.category} ${med.manufacturer}`.toLowerCase();
}
