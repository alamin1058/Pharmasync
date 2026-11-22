export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  HEAD_OFFICE_ADMIN = 'HEAD_OFFICE_ADMIN',
  BRANCH_MANAGER = 'BRANCH_MANAGER',
  PHARMACIST = 'PHARMACIST',
  CASHIER = 'CASHIER',
  INVENTORY_STAFF = 'INVENTORY_STAFF',
}

export enum BatchStatus {
  ACTIVE = 'ACTIVE',
  EXPIRING_SOON = 'EXPIRING_SOON',
  EXPIRED = 'EXPIRED',
  RECALLED = 'RECALLED',
  DEPLETED = 'DEPLETED',
}

export enum TransferStatus {
  DISPATCHED = 'DISPATCHED',
  IN_TRANSIT = 'IN_TRANSIT',
  RECEIVED = 'RECEIVED',
}

export enum PackUnit {
  TABLET = 'TABLET',
  STRIP = 'STRIP',
  BOX = 'BOX',
}

export enum SyncOpType {
  SALE = 'SALE',
  RETURN = 'RETURN',
  STOCK_RECEIPT = 'STOCK_RECEIPT',
  STOCK_COUNT = 'STOCK_COUNT',
  TRANSFER_DISPATCH = 'TRANSFER_DISPATCH',
  TRANSFER_RECEIVE = 'TRANSFER_RECEIVE',
  INVENTORY_ADJUST = 'INVENTORY_ADJUST',
}

export enum SyncOpStatus {
  PENDING = 'PENDING',
  SYNCED = 'SYNCED',
  FAILED = 'FAILED',
  CONFLICT = 'CONFLICT',
}

export enum ConflictType {
  OLD_PRICE_SALE = 'OLD_PRICE_SALE',
  NEGATIVE_STOCK = 'NEGATIVE_STOCK',
  POST_RECALL_SALE = 'POST_RECALL_SALE',
  DUPLICATE_OPERATION = 'DUPLICATE_OPERATION',
}

export type Permission =
  | 'branches:manage'
  | 'users:manage'
  | 'medicines:write'
  | 'prices:write'
  | 'recalls:write'
  | 'inventory:read'
  | 'inventory:write'
  | 'pos:sell'
  | 'pos:return'
  | 'prescriptions:write'
  | 'transfers:manage'
  | 'reports:head_office'
  | 'reports:branch'
  | 'sync:manage';

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  [UserRole.SUPER_ADMIN]: [
    'branches:manage',
    'users:manage',
    'medicines:write',
    'prices:write',
    'recalls:write',
    'inventory:read',
    'inventory:write',
    'pos:sell',
    'pos:return',
    'prescriptions:write',
    'transfers:manage',
    'reports:head_office',
    'reports:branch',
    'sync:manage',
  ],
  [UserRole.HEAD_OFFICE_ADMIN]: [
    'medicines:write',
    'prices:write',
    'recalls:write',
    'inventory:read',
    'inventory:write',
    'transfers:manage',
    'reports:head_office',
    'reports:branch',
    'sync:manage',
  ],
  [UserRole.BRANCH_MANAGER]: [
    'users:manage',
    'inventory:read',
    'inventory:write',
    'pos:sell',
    'pos:return',
    'prescriptions:write',
    'transfers:manage',
    'reports:branch',
    'sync:manage',
  ],
  [UserRole.PHARMACIST]: [
    'inventory:read',
    'pos:sell',
    'pos:return',
    'prescriptions:write',
    'reports:branch',
  ],
  [UserRole.CASHIER]: [
    'inventory:read',
    'pos:sell',
    'pos:return',
  ],
  [UserRole.INVENTORY_STAFF]: [
    'inventory:read',
    'inventory:write',
    'transfers:manage',
    'sync:manage',
  ],
};

export interface PackHierarchy {
  tabletsPerStrip: number;
  stripsPerBox: number;
}

export interface Medicine {
  id: string;
  genericName: string;
  brandName: string;
  strength: string;
  dosageForm: string;
  manufacturer: string;
  barcode: string;
  category: string;
  purchasePrice: number; // per base unit (tablet/unit)
  sellingPrice: number;  // per base unit (tablet/unit)
  packHierarchy: PackHierarchy;
  prescriptionOnly: boolean;
  active: boolean;
  leadTimeDays: number;
  safetyStock: number;
  updatedAt: string;
  version: number;
}

export interface Batch {
  id: string;
  batchNumber: string;
  medicineId: string;
  branchId: string;
  manufacturingDate: string;
  expiryDate: string;
  quantity: number; // stored in base units (tablets/units)
  purchasePrice: number;
  sellingPrice: number;
  status: BatchStatus;
  recalledAt?: string | null;
  recallReason?: string | null;
  updatedAt: string;
}

export interface Branch {
  id: string;
  code: string;
  name: string;
  city: string;
  address: string;
  phone: string;
  isHeadOffice: boolean;
  online: boolean;
  lastSyncAt: string | null;
  pendingOpsCount: number;
  deviceId: string;
}

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  email: string;
  role: UserRole;
  branchId: string;
  branchName: string;
  active: boolean;
  permissions: Permission[];
}

export interface PrescriptionInput {
  prescriberRegNo: string;
  patientName: string;
  prescriptionDate: string;
  notes?: string;
}

export interface PrescriptionRecord extends PrescriptionInput {
  id: string;
  saleId: string;
  invoiceNumber: string;
  branchId: string;
  medicineIds: string[];
  medicineSummary: string;
  dispensedBy: string;
  createdAt: string;
}

export interface SaleItemInput {
  medicineId: string;
  quantity: number; // in chosen packUnit
  packUnit: PackUnit;
  unitPriceOverride?: number;
  preferredBatchId?: string;
}

export interface SaleLineAllocation {
  medicineId: string;
  medicineName: string;
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  packUnit: PackUnit;
  packQuantity: number;
  baseUnits: number;
  unitPrice: number;
  lineTotal: number;
  prescriptionOnly: boolean;
}

export interface SaleRecord {
  id: string;
  operationId: string;
  invoiceNumber: string;
  branchId: string;
  branchName?: string;
  cashierId: string;
  cashierName: string;
  items: SaleLineAllocation[];
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  taxAmount: number;
  totalAmount: number;
  paymentMethod: 'CASH' | 'CARD' | 'INSURANCE' | 'MOBILE';
  prescription?: PrescriptionInput | null;
  status: 'COMPLETED' | 'RETURNED' | 'PARTIAL_RETURN';
  createdOffline: boolean;
  synced: boolean;
  checkoutDurationMs?: number;
  createdAt: string;
}

export interface ReturnRecord {
  id: string;
  operationId: string;
  saleId: string;
  invoiceNumber: string;
  branchId: string;
  reason: string;
  refundAmount: number;
  restockedUnits: number;
  processedBy: string;
  createdAt: string;
}

export interface TransferRecord {
  id: string;
  transferNumber: string;
  sourceBranchId: string;
  sourceBranchName?: string;
  destinationBranchId: string;
  destinationBranchName?: string;
  medicineId: string;
  medicineName?: string;
  batchId: string;
  batchNumber: string;
  transferQuantity: number;
  receivedQuantity: number | null;
  discrepancyQuantity: number;
  status: TransferStatus;
  dispatchDate: string;
  inTransitDate?: string | null;
  receivedDate?: string | null;
  dispatchedBy: string;
  receivedBy?: string | null;
  notes?: string;
}

export interface RecallRecord {
  id: string;
  batchNumber: string;
  medicineId: string;
  medicineName?: string;
  reason: string;
  recalledAt: string;
  issuedBy: string;
  totalAffectedUnits: number;
  unitsSoldAfterRecall: number;
  pendingBranches: string[];
  branchBreakdown: Array<{
    branchId: string;
    branchName: string;
    remainingStock: number;
    soldAfterRecall: number;
    synced: boolean;
  }>;
}

export interface SyncOperation {
  operationId: string;
  sequenceNo: number;
  branchId: string;
  type: SyncOpType;
  payload: Record<string, unknown>;
  status: SyncOpStatus;
  retryCount: number;
  nextRetryAt: string | null;
  lastError: string | null;
  createdAt: string;
  syncedAt: string | null;
}

export interface ConflictRecord {
  id: string;
  operationId: string;
  branchId: string;
  branchName?: string;
  type: ConflictType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  summary: string;
  resolutionRule: string;
  details: Record<string, unknown>;
  resolved: boolean;
  createdAt: string;
}

export interface StockCountTask {
  id: string;
  branchId: string;
  branchName?: string;
  medicineId: string;
  medicineName?: string;
  batchId: string;
  batchNumber: string;
  expectedQty: number;
  countedQty: number | null;
  variance: number | null;
  reason: string;
  status: 'OPEN' | 'COMPLETED';
  createdAt: string;
  completedAt?: string | null;
}

export interface ReorderSuggestion {
  branchId: string;
  branchName: string;
  medicineId: string;
  medicineName: string;
  genericName: string;
  category: string;
  dailySalesVelocity: number;
  last30DaysSold: number;
  leadTimeDays: number;
  safetyStock: number;
  currentStock: number;
  pendingIncomingTransfers: number;
  suggestedOrderQty: number;
  estimatedCost: number;
  urgency: 'CRITICAL' | 'LOW' | 'HEALTHY';
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  traceId?: string;
  errors?: Record<string, string>;
}

export interface AuditLogEntry {
  id: string;
  traceId: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  action: string;
  resource: string;
  details: string;
  createdAt: string;
}
