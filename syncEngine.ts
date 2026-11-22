import crypto from 'node:crypto';
import { DatabaseCluster } from './db';
import {
  BatchStatus,
  ConflictRecord,
  ConflictType,
  SaleRecord,
  SyncOpStatus,
  SyncOpType,
} from '../src/shared/types';
import {
  calculateBackoffDelayMs,
  domainEvents,
  evaluateBatchStatus,
  evaluateSyncConflicts,
} from '../src/shared/domainEngine';

export interface SyncExecutionSummary {
  branchId: string;
  pushedOperations: number;
  acknowledgedOperations: number;
  duplicateRejected: number;
  conflictsDetected: ConflictRecord[];
  pulledMedicines: number;
  pulledRecalls: number;
  pulledBatchUpdates: number;
  durationMs: number;
  resumableCursor: number;
  syncedAt: string;
}

export function enqueueBranchOperation(
  db: DatabaseCluster,
  branchId: string,
  opType: SyncOpType,
  operationId: string,
  payload: Record<string, unknown>
): number {
  return db.runBranchTx(() => {
    const state = db.branchPos
      .prepare('SELECT next_sequence_no FROM branch_sync_state WHERE branch_id = ?')
      .get(branchId) as { next_sequence_no: number } | undefined;
    const seq = state ? state.next_sequence_no : 1;

    db.branchPos
      .prepare(`
        INSERT OR IGNORE INTO sync_outbox (
          operation_id, sequence_no, branch_id, op_type, payload_json, status, retry_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      `)
      .run(operationId, seq, branchId, opType, JSON.stringify(payload), SyncOpStatus.PENDING, new Date().toISOString());

    db.branchPos
      .prepare(`
        INSERT INTO branch_sync_state (branch_id, last_pulled_version, next_sequence_no)
        VALUES (?, 0, ?)
        ON CONFLICT(branch_id) DO UPDATE SET next_sequence_no = ?
      `)
      .run(branchId, seq + 1, seq + 1);

    return seq;
  });
}

export function synchronizeBranch(
  db: DatabaseCluster,
  branchId: string,
  batchSize = 200
): SyncExecutionSummary {
  const start = performance.now();
  const nowIso = new Date().toISOString();

  // Verify branch exists and is online
  const branchRow = db.headOffice
    .prepare('SELECT id, name, online FROM branches WHERE id = ?')
    .get(branchId) as { id: string; name: string; online: number } | undefined;

  if (!branchRow) {
    throw new Error(`Branch ${branchId} does not exist.`);
  }

  // Pull pending operations in deterministic sequence order (resumable chunking)
  const pendingRows = db.branchPos
    .prepare(`
      SELECT operation_id, sequence_no, op_type, payload_json, retry_count
      FROM sync_outbox
      WHERE branch_id = ? AND status IN ('PENDING', 'FAILED')
      ORDER BY sequence_no ASC
      LIMIT ?
    `)
    .all(branchId, batchSize) as Array<{
      operation_id: string;
      sequence_no: number;
      op_type: SyncOpType;
      payload_json: string;
      retry_count: number;
    }>;

  let acknowledgedOperations = 0;
  let duplicateRejected = 0;
  const conflictsDetected: ConflictRecord[] = [];
  let lastSeq = 0;

  // PHASE 1: Branch -> Head Office Push (Idempotent Command Processing)
  for (const op of pendingRows) {
    lastSeq = op.sequence_no;
    try {
      const payload = JSON.parse(op.payload_json) as Record<string, unknown>;
      const alreadyAcked = Boolean(
        db.headOffice.prepare('SELECT 1 FROM sync_acks WHERE operation_id = ?').get(op.operation_id)
      );

      if (alreadyAcked) {
        duplicateRejected++;
        const decisions = evaluateSyncConflicts({
          operationId: op.operation_id,
          isDuplicateOperation: true,
        });
        for (const d of decisions) {
          const conflict = persistConflict(db, branchId, branchRow.name, op.operation_id, d, { opType: op.op_type });
          conflictsDetected.push(conflict);
        }
        db.branchPos
          .prepare(`UPDATE sync_outbox SET status = 'SYNCED', synced_at = ? WHERE operation_id = ?`)
          .run(nowIso, op.operation_id);
        continue;
      }

      db.runHeadOfficeTx(() => {
        if (op.op_type === SyncOpType.SALE) {
          const sale = payload as unknown as SaleRecord;
          const items = sale.items ?? [];

          // Deduct stock delta without overwriting unrelated fields, and check conflicts per item
          for (const item of items) {
            const medRow = db.headOffice
              .prepare('SELECT selling_price FROM medicines WHERE id = ?')
              .get(item.medicineId) as { selling_price: number } | undefined;

            const batchRow = db.headOffice
              .prepare('SELECT id, quantity, batch_number, expiry_date, recalled_at, status FROM batches WHERE id = ?')
              .get(item.batchId) as {
                id: string;
                quantity: number;
                batch_number: string;
                expiry_date: string;
                recalled_at: string | null;
                status: string;
              } | undefined;

            const newQty = batchRow ? batchRow.quantity - item.baseUnits : -item.baseUnits;

            if (batchRow) {
              const updatedStatus = evaluateBatchStatus({
                expiryDate: batchRow.expiry_date,
                quantity: Math.max(0, newQty),
                status: batchRow.status as BatchStatus,
                recalledAt: batchRow.recalled_at,
              });
              db.headOffice
                .prepare('UPDATE batches SET quantity = ?, status = ?, updated_at = ? WHERE id = ?')
                .run(Math.max(0, newQty), updatedStatus, nowIso, batchRow.id);
            }

            const decisions = evaluateSyncConflicts({
              operationId: op.operation_id,
              isDuplicateOperation: false,
              saleUnitPrice: item.unitPrice,
              centralUnitPrice: medRow?.selling_price,
              saleTimestamp: sale.createdAt,
              batchRecalledAt: batchRow?.recalled_at ?? null,
              resultingCentralStock: newQty,
            });

            for (const d of decisions) {
              const conflict = persistConflict(db, branchId, branchRow.name, op.operation_id, d, {
                invoiceNumber: sale.invoiceNumber,
                medicineId: item.medicineId,
                batchId: item.batchId,
                batchNumber: item.batchNumber,
                baseUnits: item.baseUnits,
                priceDifference: d.priceDifference,
                resultingStock: newQty,
              });
              conflictsDetected.push(conflict);
              domainEvents.publish({
                type: 'CONFLICT_DETECTED',
                payload: { operationId: op.operation_id, conflictType: d.conflictType, branchId },
              });

              if (d.createStockCountTask) {
                db.headOffice
                  .prepare(`
                    INSERT INTO stock_count_tasks (
                      id, branch_id, medicine_id, batch_id, batch_number,
                      expected_qty, reason, status, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
                  `)
                  .run(
                    `sct-${crypto.randomUUID().slice(0, 8)}`,
                    branchId,
                    item.medicineId,
                    item.batchId,
                    item.batchNumber,
                    newQty,
                    `Auto-created after negative stock (${newQty}) on sync of ${sale.invoiceNumber}`,
                    nowIso
                  );
              }
            }
          }

          // Persist sale preserving original POS sale price
          db.headOffice
            .prepare(`
              INSERT OR IGNORE INTO sales (
                id, operation_id, invoice_number, branch_id, cashier_id, cashier_name,
                items_json, subtotal, discount_percent, discount_amount, tax_amount, total_amount,
                payment_method, prescription_json, status, created_offline, checkout_duration_ms, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?)
            `)
            .run(
              sale.id,
              op.operation_id,
              sale.invoiceNumber,
              branchId,
              sale.cashierId,
              sale.cashierName,
              JSON.stringify(items),
              sale.subtotal,
              sale.discountPercent ?? 0,
              sale.discountAmount ?? 0,
              sale.taxAmount ?? 0,
              sale.totalAmount,
              sale.paymentMethod,
              sale.prescription ? JSON.stringify(sale.prescription) : null,
              sale.createdOffline ? 1 : 0,
              sale.checkoutDurationMs ?? 0,
              sale.createdAt
            );

          if (sale.prescription) {
            const rxItems = items.filter((x) => x.prescriptionOnly);
            db.headOffice
              .prepare(`
                INSERT OR IGNORE INTO prescriptions (
                  id, sale_id, invoice_number, branch_id, prescriber_reg_no, patient_name,
                  prescription_date, notes, medicine_ids_json, medicine_summary, dispensed_by, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `)
              .run(
                `rx-${crypto.randomUUID().slice(0, 8)}`,
                sale.id,
                sale.invoiceNumber,
                branchId,
                sale.prescription.prescriberRegNo,
                sale.prescription.patientName,
                sale.prescription.prescriptionDate,
                sale.prescription.notes ?? '',
                JSON.stringify(rxItems.map((x) => x.medicineId)),
                rxItems.map((x) => `${x.medicineName} (${x.baseUnits}u)`).join(', '),
                sale.cashierName,
                sale.createdAt
              );
          }
        } else if (op.op_type === SyncOpType.RETURN) {
          const ret = payload as {
            id: string;
            saleId: string;
            invoiceNumber: string;
            reason: string;
            refundAmount: number;
            restockedUnits: number;
            processedBy: string;
            restockBatchId?: string;
            createdAt: string;
          };
          db.headOffice
            .prepare(`
              INSERT OR IGNORE INTO returns (
                id, operation_id, sale_id, invoice_number, branch_id, reason,
                refund_amount, restocked_units, processed_by, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              ret.id,
              op.operation_id,
              ret.saleId,
              ret.invoiceNumber,
              branchId,
              ret.reason,
              ret.refundAmount,
              ret.restockedUnits,
              ret.processedBy,
              ret.createdAt
            );
          db.headOffice.prepare(`UPDATE sales SET status = 'RETURNED' WHERE id = ?`).run(ret.saleId);
          if (ret.restockBatchId && ret.restockedUnits > 0) {
            db.headOffice
              .prepare(`UPDATE batches SET quantity = quantity + ?, updated_at = ? WHERE id = ?`)
              .run(ret.restockedUnits, nowIso, ret.restockBatchId);
          }
        } else if (op.op_type === SyncOpType.STOCK_RECEIPT) {
          const rec = payload as {
            batchId: string;
            batchNumber: string;
            medicineId: string;
            manufacturingDate: string;
            expiryDate: string;
            quantity: number;
            purchasePrice: number;
            sellingPrice: number;
          };
          const existing = db.headOffice.prepare('SELECT id, quantity FROM batches WHERE id = ?').get(rec.batchId) as
            | { id: string; quantity: number }
            | undefined;
          const status = evaluateBatchStatus({
            expiryDate: rec.expiryDate,
            quantity: rec.quantity + (existing?.quantity ?? 0),
            status: BatchStatus.ACTIVE,
            recalledAt: null,
          });
          if (existing) {
            db.headOffice
              .prepare('UPDATE batches SET quantity = quantity + ?, status = ?, updated_at = ? WHERE id = ?')
              .run(rec.quantity, status, nowIso, rec.batchId);
          } else {
            db.headOffice
              .prepare(`
                INSERT INTO batches (
                  id, batch_number, medicine_id, branch_id, manufacturing_date, expiry_date,
                  quantity, purchase_price, selling_price, status, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `)
              .run(
                rec.batchId,
                rec.batchNumber,
                rec.medicineId,
                branchId,
                rec.manufacturingDate,
                rec.expiryDate,
                rec.quantity,
                rec.purchasePrice,
                rec.sellingPrice,
                status,
                nowIso
              );
          }
        } else if (op.op_type === SyncOpType.STOCK_COUNT || op.op_type === SyncOpType.INVENTORY_ADJUST) {
          const adj = payload as { batchId: string; delta: number };
          db.headOffice
            .prepare('UPDATE batches SET quantity = MAX(0, quantity + ?), updated_at = ? WHERE id = ?')
            .run(adj.delta, nowIso, adj.batchId);
        }

        // Record idempotency acknowledgement
        db.headOffice
          .prepare(`
            INSERT INTO sync_acks (operation_id, branch_id, sequence_no, op_type, acknowledged_at)
            VALUES (?, ?, ?, ?, ?)
          `)
          .run(op.operation_id, branchId, op.sequence_no, op.op_type, nowIso);
      });

      // Mark branch outbox & local sale as synced
      db.runBranchTx(() => {
        db.branchPos
          .prepare(`UPDATE sync_outbox SET status = 'SYNCED', synced_at = ?, last_error = NULL WHERE operation_id = ?`)
          .run(nowIso, op.operation_id);
        if (op.op_type === SyncOpType.SALE) {
          db.branchPos
            .prepare(`UPDATE local_sales SET synced = 1 WHERE operation_id = ?`)
            .run(op.operation_id);
        }
      });

      acknowledgedOperations++;
    } catch (err) {
      const nextRetryCount = op.retry_count + 1;
      const delayMs = calculateBackoffDelayMs(nextRetryCount);
      const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
      db.branchPos
        .prepare(`
          UPDATE sync_outbox
          SET status = 'FAILED', retry_count = ?, next_retry_at = ?, last_error = ?
          WHERE operation_id = ?
        `)
        .run(nextRetryCount, nextRetryAt, err instanceof Error ? err.message : 'Sync failed', op.operation_id);
    }
  }

  // PHASE 2: Head Office -> Branch Incremental Pull (Catalogue, Prices, Recalls, Incoming Batches)
  const syncState = db.branchPos
    .prepare('SELECT last_pulled_version FROM branch_sync_state WHERE branch_id = ?')
    .get(branchId) as { last_pulled_version: number } | undefined;
  const lastVersion = syncState?.last_pulled_version ?? 0;

  const updatedMeds = db.headOffice
    .prepare('SELECT * FROM medicines WHERE version > ? ORDER BY version ASC')
    .all(lastVersion) as Array<Record<string, unknown>>;

  const branchBatches = db.headOffice
    .prepare('SELECT * FROM batches WHERE branch_id = ?')
    .all(branchId) as Array<Record<string, unknown>>;

  let maxVersion = lastVersion;
  let pulledRecalls = 0;
  let pulledBatchUpdates = 0;

  db.runBranchTx(() => {
    const upsertMed = db.branchPos.prepare(`
      INSERT INTO local_medicines (
        id, generic_name, brand_name, strength, dosage_form, manufacturer, barcode, category,
        purchase_price, selling_price, tablets_per_strip, strips_per_box, prescription_only,
        active, lead_time_days, safety_stock, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        generic_name = excluded.generic_name,
        brand_name = excluded.brand_name,
        strength = excluded.strength,
        dosage_form = excluded.dosage_form,
        manufacturer = excluded.manufacturer,
        barcode = excluded.barcode,
        category = excluded.category,
        purchase_price = excluded.purchase_price,
        selling_price = excluded.selling_price,
        tablets_per_strip = excluded.tablets_per_strip,
        strips_per_box = excluded.strips_per_box,
        prescription_only = excluded.prescription_only,
        active = excluded.active,
        lead_time_days = excluded.lead_time_days,
        safety_stock = excluded.safety_stock,
        updated_at = excluded.updated_at,
        version = excluded.version
    `);

    for (const m of updatedMeds) {
      upsertMed.run(
        String(m.id), String(m.generic_name), String(m.brand_name), String(m.strength), String(m.dosage_form),
        String(m.manufacturer), String(m.barcode), String(m.category), Number(m.purchase_price), Number(m.selling_price),
        Number(m.tablets_per_strip), Number(m.strips_per_box), Number(m.prescription_only), Number(m.active),
        Number(m.lead_time_days), Number(m.safety_stock), String(m.updated_at), Number(m.version)
      );
      if (Number(m.version) > maxVersion) maxVersion = Number(m.version);
    }

    // Apply central recall notifications & price/new-batch deltas without clobbering unpushed local stock deltas
    const hasPendingOps = (db.branchPos
      .prepare(`SELECT COUNT(*) as c FROM sync_outbox WHERE branch_id = ? AND status IN ('PENDING', 'FAILED')`)
      .get(branchId) as { c: number }).c > 0;

    for (const hb of branchBatches) {
      const local = db.branchPos
        .prepare('SELECT id, recalled_at, selling_price FROM local_batches WHERE id = ?')
        .get(String(hb.id)) as { id: string; recalled_at: string | null; selling_price: number } | undefined;

      if (!local) {
        db.branchPos
          .prepare(`
            INSERT INTO local_batches (
              id, batch_number, medicine_id, branch_id, manufacturing_date, expiry_date,
              quantity, purchase_price, selling_price, status, recalled_at, recall_reason, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            String(hb.id), String(hb.batch_number), String(hb.medicine_id), String(hb.branch_id),
            String(hb.manufacturing_date), String(hb.expiry_date), Number(hb.quantity),
            Number(hb.purchase_price), Number(hb.selling_price), String(hb.status),
            hb.recalled_at ? String(hb.recalled_at) : null,
            hb.recall_reason ? String(hb.recall_reason) : null,
            String(hb.updated_at)
          );
        pulledBatchUpdates++;
      } else {
        // Propagate recall immediately even if outbox still has chunks
        if (hb.recalled_at && !local.recalled_at) {
          db.branchPos
            .prepare(`
              UPDATE local_batches
              SET status = 'RECALLED', recalled_at = ?, recall_reason = ?, updated_at = ?
              WHERE id = ?
            `)
            .run(String(hb.recalled_at), String(hb.recall_reason ?? ''), nowIso, String(hb.id));
          pulledRecalls++;
        }
        // Propagate price update & converged stock once outbox is clear
        if (!hasPendingOps) {
          db.branchPos
            .prepare(`
              UPDATE local_batches
              SET selling_price = ?, purchase_price = ?, quantity = ?, status = ?, updated_at = ?
              WHERE id = ?
            `)
            .run(Number(hb.selling_price), Number(hb.purchase_price), Number(hb.quantity), String(hb.status), nowIso, String(hb.id));
          pulledBatchUpdates++;
        } else if (Number(hb.selling_price) !== local.selling_price) {
          db.branchPos
            .prepare('UPDATE local_batches SET selling_price = ?, updated_at = ? WHERE id = ?')
            .run(Number(hb.selling_price), nowIso, String(hb.id));
          pulledBatchUpdates++;
        }
      }
    }

    db.branchPos
      .prepare(`
        INSERT INTO branch_sync_state (branch_id, last_pulled_version, last_sync_at, next_sequence_no)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(branch_id) DO UPDATE SET last_pulled_version = ?, last_sync_at = ?
      `)
      .run(branchId, maxVersion, nowIso, maxVersion, nowIso);
  });

  db.headOffice
    .prepare('UPDATE branches SET online = 1, last_sync_at = ? WHERE id = ?')
    .run(nowIso, branchId);

  return {
    branchId,
    pushedOperations: pendingRows.length,
    acknowledgedOperations,
    duplicateRejected,
    conflictsDetected,
    pulledMedicines: updatedMeds.length,
    pulledRecalls,
    pulledBatchUpdates,
    durationMs: Number((performance.now() - start).toFixed(2)),
    resumableCursor: lastSeq,
    syncedAt: nowIso,
  };
}

function persistConflict(
  db: DatabaseCluster,
  branchId: string,
  branchName: string,
  operationId: string,
  decision: {
    conflictType: ConflictType;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    summary: string;
    resolutionRule: string;
  },
  details: Record<string, unknown>
): ConflictRecord {
  const id = `cfl-${crypto.randomUUID().slice(0, 8)}`;
  const nowIso = new Date().toISOString();
  db.headOffice
    .prepare(`
      INSERT INTO conflicts (
        id, operation_id, branch_id, type, severity, summary, resolution_rule, details_json, resolved, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `)
    .run(
      id,
      operationId,
      branchId,
      decision.conflictType,
      decision.severity,
      decision.summary,
      decision.resolutionRule,
      JSON.stringify(details),
      nowIso
    );

  return {
    id,
    operationId,
    branchId,
    branchName,
    type: decision.conflictType,
    severity: decision.severity,
    summary: decision.summary,
    resolutionRule: decision.resolutionRule,
    details,
    resolved: false,
    createdAt: nowIso,
  };
}
