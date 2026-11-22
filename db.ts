import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  AuditLogEntry,
  Batch,
  BatchStatus,
  Branch,
  Medicine,
  TransferStatus,
  UserRole,
} from '../src/shared/types';
import { evaluateBatchStatus } from '../src/shared/domainEngine';
import { hashPassword } from './auth';

const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export interface DatabaseCluster {
  headOffice: DatabaseSync;
  branchPos: DatabaseSync;
  runHeadOfficeTx<T>(fn: () => T): T;
  runBranchTx<T>(fn: () => T): T;
  close(): void;
}

function initHeadOfficeSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS system_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      address TEXT NOT NULL,
      phone TEXT NOT NULL,
      is_head_office INTEGER NOT NULL DEFAULT 0,
      online INTEGER NOT NULL DEFAULT 1,
      last_sync_at TEXT,
      device_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      branch_id TEXT NOT NULL REFERENCES branches(id),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS medicines (
      id TEXT PRIMARY KEY,
      generic_name TEXT NOT NULL,
      brand_name TEXT NOT NULL,
      strength TEXT NOT NULL,
      dosage_form TEXT NOT NULL,
      manufacturer TEXT NOT NULL,
      barcode TEXT UNIQUE NOT NULL,
      category TEXT NOT NULL,
      purchase_price REAL NOT NULL,
      selling_price REAL NOT NULL,
      tablets_per_strip INTEGER NOT NULL DEFAULT 10,
      strips_per_box INTEGER NOT NULL DEFAULT 3,
      prescription_only INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      lead_time_days INTEGER NOT NULL DEFAULT 5,
      safety_stock INTEGER NOT NULL DEFAULT 60,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      batch_number TEXT NOT NULL,
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      branch_id TEXT NOT NULL REFERENCES branches(id),
      manufacturing_date TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      purchase_price REAL NOT NULL,
      selling_price REAL NOT NULL,
      status TEXT NOT NULL,
      recalled_at TEXT,
      recall_reason TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ho_batches_med_branch ON batches(medicine_id, branch_id);
    CREATE INDEX IF NOT EXISTS idx_ho_batches_number ON batches(batch_number);

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      operation_id TEXT UNIQUE NOT NULL,
      invoice_number TEXT NOT NULL,
      branch_id TEXT NOT NULL REFERENCES branches(id),
      cashier_id TEXT NOT NULL,
      cashier_name TEXT NOT NULL,
      items_json TEXT NOT NULL,
      subtotal REAL NOT NULL,
      discount_percent REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL,
      payment_method TEXT NOT NULL,
      prescription_json TEXT,
      status TEXT NOT NULL DEFAULT 'COMPLETED',
      created_offline INTEGER NOT NULL DEFAULT 0,
      checkout_duration_ms REAL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ho_sales_branch_date ON sales(branch_id, created_at);

    CREATE TABLE IF NOT EXISTS returns (
      id TEXT PRIMARY KEY,
      operation_id TEXT UNIQUE NOT NULL,
      sale_id TEXT NOT NULL,
      invoice_number TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      refund_amount REAL NOT NULL,
      restocked_units INTEGER NOT NULL,
      processed_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prescriptions (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL,
      invoice_number TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      prescriber_reg_no TEXT NOT NULL,
      patient_name TEXT NOT NULL,
      prescription_date TEXT NOT NULL,
      notes TEXT,
      medicine_ids_json TEXT NOT NULL,
      medicine_summary TEXT NOT NULL,
      dispensed_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      transfer_number TEXT UNIQUE NOT NULL,
      source_branch_id TEXT NOT NULL REFERENCES branches(id),
      destination_branch_id TEXT NOT NULL REFERENCES branches(id),
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      batch_id TEXT NOT NULL,
      batch_number TEXT NOT NULL,
      transfer_quantity INTEGER NOT NULL,
      received_quantity INTEGER,
      discrepancy_quantity INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      dispatch_date TEXT NOT NULL,
      in_transit_date TEXT,
      received_date TEXT,
      dispatched_by TEXT NOT NULL,
      received_by TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS recalls (
      id TEXT PRIMARY KEY,
      batch_number TEXT NOT NULL,
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      reason TEXT NOT NULL,
      recalled_at TEXT NOT NULL,
      issued_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_acks (
      operation_id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      sequence_no INTEGER NOT NULL,
      op_type TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conflicts (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      summary TEXT NOT NULL,
      resolution_rule TEXT NOT NULL,
      details_json TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_count_tasks (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      medicine_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      batch_number TEXT NOT NULL,
      expected_qty INTEGER NOT NULL,
      counted_qty INTEGER,
      variance INTEGER,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      resource TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function initBranchPosSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS local_medicines (
      id TEXT PRIMARY KEY,
      generic_name TEXT NOT NULL,
      brand_name TEXT NOT NULL,
      strength TEXT NOT NULL,
      dosage_form TEXT NOT NULL,
      manufacturer TEXT NOT NULL,
      barcode TEXT UNIQUE NOT NULL,
      category TEXT NOT NULL,
      purchase_price REAL NOT NULL,
      selling_price REAL NOT NULL,
      tablets_per_strip INTEGER NOT NULL DEFAULT 10,
      strips_per_box INTEGER NOT NULL DEFAULT 3,
      prescription_only INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      lead_time_days INTEGER NOT NULL DEFAULT 5,
      safety_stock INTEGER NOT NULL DEFAULT 60,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS local_batches (
      id TEXT PRIMARY KEY,
      batch_number TEXT NOT NULL,
      medicine_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      manufacturing_date TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      purchase_price REAL NOT NULL,
      selling_price REAL NOT NULL,
      status TEXT NOT NULL,
      recalled_at TEXT,
      recall_reason TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_br_batches_med_branch ON local_batches(medicine_id, branch_id);

    CREATE TABLE IF NOT EXISTS local_sales (
      id TEXT PRIMARY KEY,
      operation_id TEXT UNIQUE NOT NULL,
      invoice_number TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      cashier_id TEXT NOT NULL,
      cashier_name TEXT NOT NULL,
      items_json TEXT NOT NULL,
      subtotal REAL NOT NULL,
      discount_percent REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL,
      payment_method TEXT NOT NULL,
      prescription_json TEXT,
      status TEXT NOT NULL DEFAULT 'COMPLETED',
      created_offline INTEGER NOT NULL DEFAULT 0,
      synced INTEGER NOT NULL DEFAULT 0,
      checkout_duration_ms REAL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_outbox (
      operation_id TEXT PRIMARY KEY,
      sequence_no INTEGER NOT NULL,
      branch_id TEXT NOT NULL,
      op_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      synced_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_branch_status ON sync_outbox(branch_id, status, sequence_no);

    CREATE TABLE IF NOT EXISTS branch_sync_state (
      branch_id TEXT PRIMARY KEY,
      last_pulled_version INTEGER NOT NULL DEFAULT 0,
      last_sync_at TEXT,
      next_sequence_no INTEGER NOT NULL DEFAULT 1
    );
  `);
}

function addDays(base: Date, days: number): string {
  const d = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function seedDatabases(ho: DatabaseSync, br: DatabaseSync): void {
  const existingBranches = ho.prepare('SELECT COUNT(*) as c FROM branches').get() as { c: number };
  if (existingBranches.c > 0) return;

  const now = new Date();
  const nowIso = now.toISOString();

  // 1. Seed Branches (Head Office + 3 Retail Pharmacy Branches)
  const branches = [
    {
      id: 'br-ho',
      code: 'HO-000',
      name: 'PharmaSync Central Head Office',
      city: 'Boston',
      address: '100 Harbor Logistics Way, Suite 400',
      phone: '+1 (617) 555-0100',
      isHeadOffice: 1,
      online: 1,
      deviceId: 'HO-CORE-01',
    },
    {
      id: 'br-downtown',
      code: 'BR-001',
      name: 'Downtown Central Pharmacy',
      city: 'Boston',
      address: '245 Boylston Street',
      phone: '+1 (617) 555-0141',
      isHeadOffice: 0,
      online: 1,
      deviceId: 'POS-BOS-01',
    },
    {
      id: 'br-westside',
      code: 'BR-002',
      name: 'Westside Medical Plaza',
      city: 'Cambridge',
      address: '880 Massachusetts Ave',
      phone: '+1 (617) 555-0182',
      isHeadOffice: 0,
      online: 1,
      deviceId: 'POS-CAM-02',
    },
    {
      id: 'br-northgate',
      code: 'BR-003',
      name: 'Northgate Community Clinic',
      city: 'Somerville',
      address: '412 Highland Ave',
      phone: '+1 (617) 555-0193',
      isHeadOffice: 0,
      online: 0, // Starts simulated offline to demonstrate offline branch monitoring
      deviceId: 'POS-SOM-03',
    },
  ];

  const insertBranch = ho.prepare(`
    INSERT INTO branches (id, code, name, city, address, phone, is_head_office, online, last_sync_at, device_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSyncState = br.prepare(`
    INSERT OR IGNORE INTO branch_sync_state (branch_id, last_pulled_version, last_sync_at, next_sequence_no)
    VALUES (?, 1, ?, 1)
  `);

  for (const b of branches) {
    insertBranch.run(b.id, b.code, b.name, b.city, b.address, b.phone, b.isHeadOffice, b.online, nowIso, b.deviceId);
    if (!b.isHeadOffice) {
      insertSyncState.run(b.id, nowIso);
    }
  }

  // 2. Seed 14 Medicines with Pack Hierarchies (Box -> Strip -> Tablet)
  const medicines = [
    { id: 'med-amox500', generic: 'Amoxicillin Trihydrate', brand: 'Amoxil Forte', strength: '500 mg', form: 'Capsule', mfg: 'Novartis Pharma', barcode: '8901101000011', cat: 'Antibiotics', buy: 0.24, sell: 0.45, tps: 10, spb: 3, rx: 1, lead: 5, safety: 120 },
    { id: 'med-para500', generic: 'Paracetamol', brand: 'Panadol Advance', strength: '500 mg', form: 'Tablet', mfg: 'Haleon Healthcare', barcode: '8901101000028', cat: 'Analgesics', buy: 0.06, sell: 0.15, tps: 12, spb: 5, rx: 0, lead: 3, safety: 240 },
    { id: 'med-metf850', generic: 'Metformin Hydrochloride', brand: 'Glucophage XR', strength: '850 mg', form: 'Tablet', mfg: 'Merck Serono', barcode: '8901101000035', cat: 'Endocrinology', buy: 0.14, sell: 0.30, tps: 10, spb: 6, rx: 1, lead: 6, safety: 180 },
    { id: 'med-ator20', generic: 'Atorvastatin Calcium', brand: 'Lipitor', strength: '20 mg', form: 'Tablet', mfg: 'Pfizer Labs', barcode: '8901101000042', cat: 'Cardiovascular', buy: 0.32, sell: 0.65, tps: 10, spb: 3, rx: 1, lead: 7, safety: 120 },
    { id: 'med-omep20', generic: 'Omeprazole', brand: 'Losec MUPS', strength: '20 mg', form: 'Capsule', mfg: 'AstraZeneca', barcode: '8901101000059', cat: 'Gastroenterology', buy: 0.18, sell: 0.38, tps: 14, spb: 2, rx: 0, lead: 4, safety: 112 },
    { id: 'med-cet10', generic: 'Cetirizine Dihydrochloride', brand: 'Zyrtec', strength: '10 mg', form: 'Tablet', mfg: 'Johnson & Johnson', barcode: '8901101000066', cat: 'Allergy', buy: 0.09, sell: 0.22, tps: 10, spb: 3, rx: 0, lead: 4, safety: 150 },
    { id: 'med-azith250', generic: 'Azithromycin', brand: 'Zithromax', strength: '250 mg', form: 'Tablet', mfg: 'Pfizer Labs', barcode: '8901101000073', cat: 'Antibiotics', buy: 0.85, sell: 1.65, tps: 6, spb: 2, rx: 1, lead: 5, safety: 60 },
    { id: 'med-amlod5', generic: 'Amlodipine Besylate', brand: 'Norvasc', strength: '5 mg', form: 'Tablet', mfg: 'Viatris Inc.', barcode: '8901101000080', cat: 'Cardiovascular', buy: 0.12, sell: 0.28, tps: 10, spb: 3, rx: 1, lead: 5, safety: 150 },
    { id: 'med-ibup400', generic: 'Ibuprofen', brand: 'Advil Liqui-Gels', strength: '400 mg', form: 'Softgel', mfg: 'Haleon Healthcare', barcode: '8901101000097', cat: 'Analgesics', buy: 0.11, sell: 0.25, tps: 10, spb: 4, rx: 0, lead: 3, safety: 200 },
    { id: 'med-salb100', generic: 'Salbutamol Sulfate', brand: 'Ventolin HFA', strength: '100 mcg', form: 'Inhaler', mfg: 'GSK Respiratory', barcode: '8901101000103', cat: 'Respiratory', buy: 4.80, sell: 8.90, tps: 1, spb: 5, rx: 1, lead: 7, safety: 25 },
    { id: 'med-los50', generic: 'Losartan Potassium', brand: 'Cozaar', strength: '50 mg', form: 'Tablet', mfg: 'Organon Pharma', barcode: '8901101000110', cat: 'Cardiovascular', buy: 0.22, sell: 0.48, tps: 10, spb: 3, rx: 1, lead: 6, safety: 120 },
    { id: 'med-vitd1000', generic: 'Cholecalciferol (Vit D3)', brand: 'OsteoD3', strength: '1000 IU', form: 'Softgel', mfg: 'Bayer Health', barcode: '8901101000127', cat: 'Vitamins', buy: 0.08, sell: 0.20, tps: 15, spb: 2, rx: 0, lead: 4, safety: 150 },
    { id: 'med-insglar', generic: 'Insulin Glargine', brand: 'Lantus SoloStar', strength: '100 U/mL', form: 'Pen', mfg: 'Sanofi Diabetes', barcode: '8901101000134', cat: 'Endocrinology', buy: 18.50, sell: 29.00, tps: 1, spb: 5, rx: 1, lead: 5, safety: 15 },
    { id: 'med-ors20', generic: 'Oral Rehydration Salts', brand: 'ElectroLyte Plus', strength: '20.5 g', form: 'Sachet', mfg: 'Abbott Nutrition', barcode: '8901101000141', cat: 'Hydration', buy: 0.35, sell: 0.75, tps: 10, spb: 2, rx: 0, lead: 3, safety: 80 },
  ];

  const insertHoMed = ho.prepare(`
    INSERT INTO medicines (
      id, generic_name, brand_name, strength, dosage_form, manufacturer, barcode, category,
      purchase_price, selling_price, tablets_per_strip, strips_per_box, prescription_only,
      active, lead_time_days, safety_stock, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)
  `);
  const insertBrMed = br.prepare(`
    INSERT INTO local_medicines (
      id, generic_name, brand_name, strength, dosage_form, manufacturer, barcode, category,
      purchase_price, selling_price, tablets_per_strip, strips_per_box, prescription_only,
      active, lead_time_days, safety_stock, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)
  `);

  for (const m of medicines) {
    insertHoMed.run(m.id, m.generic, m.brand, m.strength, m.form, m.mfg, m.barcode, m.cat, m.buy, m.sell, m.tps, m.spb, m.rx, m.lead, m.safety, nowIso);
    insertBrMed.run(m.id, m.generic, m.brand, m.strength, m.form, m.mfg, m.barcode, m.cat, m.buy, m.sell, m.tps, m.spb, m.rx, m.lead, m.safety, nowIso);
  }

  // 3. Seed Batches across the 3 retail branches (FEFO pairs, Expiring < 90d, 2 Expired, 1 Recalled)
  const retailBranches = ['br-downtown', 'br-westside', 'br-northgate'];
  const insertHoBatch = ho.prepare(`
    INSERT INTO batches (
      id, batch_number, medicine_id, branch_id, manufacturing_date, expiry_date,
      quantity, purchase_price, selling_price, status, recalled_at, recall_reason, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBrBatch = br.prepare(`
    INSERT INTO local_batches (
      id, batch_number, medicine_id, branch_id, manufacturing_date, expiry_date,
      quantity, purchase_price, selling_price, status, recalled_at, recall_reason, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const writeBatch = (
    id: string,
    batchNumber: string,
    med: (typeof medicines)[number],
    branchId: string,
    mfgOffset: number,
    expOffset: number,
    qty: number,
    recalledAt: string | null = null,
    recallReason: string | null = null
  ) => {
    const mfgDate = addDays(now, mfgOffset);
    const expDate = addDays(now, expOffset);
    const status = evaluateBatchStatus(
      { expiryDate: expDate, quantity: qty, status: recalledAt ? BatchStatus.RECALLED : BatchStatus.ACTIVE, recalledAt },
      now
    );
    insertHoBatch.run(id, batchNumber, med.id, branchId, mfgDate, expDate, qty, med.buy, med.sell, status, recalledAt, recallReason, nowIso);
    insertBrBatch.run(id, batchNumber, med.id, branchId, mfgDate, expDate, qty, med.buy, med.sell, status, recalledAt, recallReason, nowIso);
  };

  medicines.forEach((med, idx) => {
    retailBranches.forEach((branchId, bIdx) => {
      // Primary longer-dated batch
      const baseQty = med.form === 'Inhaler' || med.form === 'Pen' ? 24 + bIdx * 8 : 220 + ((idx * 37 + bIdx * 53) % 240);
      // Make a couple items intentionally low stock in downtown so Reordering shows realistic suggestions
      const adjustedQty = branchId === 'br-downtown' && (med.id === 'med-amox500' || med.id === 'med-salb100' || med.id === 'med-insglar')
        ? Math.floor(med.safety * 0.45)
        : baseQty;

      writeBatch(
        `bat-${med.id}-${branchId}-a`,
        `BN-${202600 + idx * 10 + 1}`,
        med,
        branchId,
        -180,
        360 + idx * 15,
        adjustedQty
      );

      // Earlier-expiring FEFO batch (within 90 days for first 5 meds)
      if (idx < 6) {
        const expDays = idx < 4 ? 32 + idx * 14 : 140 + idx * 10;
        writeBatch(
          `bat-${med.id}-${branchId}-b`,
          `BN-${202500 + idx * 10 + 2}`,
          med,
          branchId,
          -340,
          expDays,
          med.form === 'Inhaler' ? 8 : 65
        );
      }
    });
  });

  // Add 2 Expired batches (strictly blocked from POS sales)
  writeBatch('bat-expired-para', 'BN-EXP-2025A', medicines[1], 'br-downtown', -720, -14, 48);
  writeBatch('bat-expired-omep', 'BN-EXP-2025B', medicines[4], 'br-westside', -700, -5, 28);

  // Add 1 Recalled batch across branches (Losartan BN-REC-8841)
  const recallTime = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const recallReason = 'FDA Class II voluntary recall — nitrosamine impurity detected in lot BN-REC-8841';
  writeBatch('bat-recalled-los-dt', 'BN-REC-8841', medicines[10], 'br-downtown', -210, 290, 90, recallTime, recallReason);
  writeBatch('bat-recalled-los-ws', 'BN-REC-8841', medicines[10], 'br-westside', -210, 290, 60, recallTime, recallReason);
  // Northgate is offline, so its local copy hasn't received the recall flag yet until sync!
  const ngExp = addDays(now, 290);
  const ngMfg = addDays(now, -210);
  insertHoBatch.run('bat-recalled-los-ng', 'BN-REC-8841', medicines[10].id, 'br-northgate', ngMfg, ngExp, 45, medicines[10].buy, medicines[10].sell, BatchStatus.RECALLED, recallTime, recallReason, nowIso);
  insertBrBatch.run('bat-recalled-los-ng', 'BN-REC-8841', medicines[10].id, 'br-northgate', ngMfg, ngExp, 45, medicines[10].buy, medicines[10].sell, BatchStatus.ACTIVE, null, null, nowIso);

  ho.prepare(`
    INSERT INTO recalls (id, batch_number, medicine_id, reason, recalled_at, issued_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('rec-001', 'BN-REC-8841', medicines[10].id, recallReason, recallTime, 'Dr. Elena Rostova (HO Admin)');

  // 4. Seed realistic historical 30-day sales + prescriptions so dashboards, velocity & reports show live DB data
  const insertHoSale = ho.prepare(`
    INSERT INTO sales (
      id, operation_id, invoice_number, branch_id, cashier_id, cashier_name,
      items_json, subtotal, discount_percent, discount_amount, tax_amount, total_amount,
      payment_method, prescription_json, status, created_offline, checkout_duration_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?)
  `);
  const insertBrSale = br.prepare(`
    INSERT INTO local_sales (
      id, operation_id, invoice_number, branch_id, cashier_id, cashier_name,
      items_json, subtotal, discount_percent, discount_amount, tax_amount, total_amount,
      payment_method, prescription_json, status, created_offline, synced, checkout_duration_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, 1, ?, ?)
  `);
  const insertRx = ho.prepare(`
    INSERT INTO prescriptions (
      id, sale_id, invoice_number, branch_id, prescriber_reg_no, patient_name,
      prescription_date, notes, medicine_ids_json, medicine_summary, dispensed_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const samplePatients = [
    { name: 'Margaret Chen', reg: 'MD-MA-44812' },
    { name: 'David Kowalski', reg: 'MD-MA-31904' },
    { name: 'Amina Patel', reg: 'NP-MA-77215' },
    { name: 'Carlos Mendoza', reg: 'MD-MA-55190' },
    { name: 'Hannah Okafor', reg: 'DO-MA-60341' },
  ];
  const methods: Array<'CASH' | 'CARD' | 'INSURANCE' | 'MOBILE'> = ['CARD', 'CASH', 'INSURANCE', 'MOBILE'];

  for (let i = 0; i < 28; i++) {
    const dayAgo = i < 4 ? 0 : i - 3;
    const saleDate = new Date(now.getTime() - dayAgo * 24 * 60 * 60 * 1000 - (i % 7) * 3600_000);
    const saleIso = saleDate.toISOString();
    const branchId = retailBranches[i % 3];
    const medA = medicines[i % medicines.length];
    const medB = medicines[(i + 3) % medicines.length];
    const qtyA = medA.form === 'Inhaler' || medA.form === 'Pen' ? 2 : 20 + (i % 3) * 10;
    const qtyB = medB.form === 'Inhaler' || medB.form === 'Pen' ? 1 : 10 + (i % 2) * 10;

    const items = [
      {
        medicineId: medA.id,
        medicineName: `${medA.brand} ${medA.strength}`,
        batchId: `bat-${medA.id}-${branchId}-a`,
        batchNumber: `BN-${202600 + (i % medicines.length) * 10 + 1}`,
        expiryDate: addDays(now, 360 + (i % medicines.length) * 15),
        packUnit: 'TABLET',
        packQuantity: qtyA,
        baseUnits: qtyA,
        unitPrice: medA.sell,
        lineTotal: Number((qtyA * medA.sell).toFixed(2)),
        prescriptionOnly: medA.rx === 1,
      },
      {
        medicineId: medB.id,
        medicineName: `${medB.brand} ${medB.strength}`,
        batchId: `bat-${medB.id}-${branchId}-a`,
        batchNumber: `BN-${202600 + ((i + 3) % medicines.length) * 10 + 1}`,
        expiryDate: addDays(now, 360 + ((i + 3) % medicines.length) * 15),
        packUnit: 'TABLET',
        packQuantity: qtyB,
        baseUnits: qtyB,
        unitPrice: medB.sell,
        lineTotal: Number((qtyB * medB.sell).toFixed(2)),
        prescriptionOnly: medB.rx === 1,
      },
    ];
    const subtotal = Number((items[0].lineTotal + items[1].lineTotal).toFixed(2));
    const discountPct = i % 5 === 0 ? 5 : 0;
    const discountAmt = Number(((subtotal * discountPct) / 100).toFixed(2));
    const taxAmt = Number(((subtotal - discountAmt) * 0.05).toFixed(2));
    const totalAmt = Number((subtotal - discountAmt + taxAmt).toFixed(2));
    const hasRx = medA.rx === 1 || medB.rx === 1;
    const pat = samplePatients[i % samplePatients.length];
    const rxObj = hasRx
      ? {
          prescriberRegNo: pat.reg,
          patientName: pat.name,
          prescriptionDate: saleIso.slice(0, 10),
          notes: 'Dispensed per valid clinical prescription',
        }
      : null;

    const saleId = `sale-seed-${String(i + 1).padStart(3, '0')}`;
    const opId = `op-seed-${String(i + 1).padStart(3, '0')}`;
    const invNo = `INV-${branchId === 'br-downtown' ? 'DT' : branchId === 'br-westside' ? 'WS' : 'NG'}-${1001 + i}`;
    const cashierName = branchId === 'br-downtown' ? 'Marcus Vance' : branchId === 'br-westside' ? 'Priya Nair' : 'Liam Brooks';
    const method = methods[i % methods.length];
    const offline = i % 6 === 0 ? 1 : 0;
    const duration = 42 + (i % 9) * 11;

    insertHoSale.run(
      saleId, opId, invNo, branchId, 'usr-pharm', cashierName, JSON.stringify(items),
      subtotal, discountPct, discountAmt, taxAmt, totalAmt, method,
      rxObj ? JSON.stringify(rxObj) : null, offline, duration, saleIso
    );
    insertBrSale.run(
      saleId, opId, invNo, branchId, 'usr-pharm', cashierName, JSON.stringify(items),
      subtotal, discountPct, discountAmt, taxAmt, totalAmt, method,
      rxObj ? JSON.stringify(rxObj) : null, offline, duration, saleIso
    );
    ho.prepare(`
      INSERT OR IGNORE INTO sync_acks (operation_id, branch_id, sequence_no, op_type, acknowledged_at)
      VALUES (?, ?, ?, 'SALE', ?)
    `).run(opId, branchId, i + 1, saleIso);

    if (rxObj) {
      insertRx.run(
        `rx-seed-${String(i + 1).padStart(3, '0')}`,
        saleId,
        invNo,
        branchId,
        rxObj.prescriberRegNo,
        rxObj.patientName,
        rxObj.prescriptionDate,
        rxObj.notes,
        JSON.stringify(items.filter((x) => x.prescriptionOnly).map((x) => x.medicineId)),
        items.filter((x) => x.prescriptionOnly).map((x) => `${x.medicineName} (${x.baseUnits}u)`).join(', '),
        cashierName,
        saleIso
      );
    }
  }

  // 5. Seed 2 Branch Transfers (1 IN_TRANSIT, 1 RECEIVED with minor discrepancy)
  const insertTransfer = ho.prepare(`
    INSERT INTO transfers (
      id, transfer_number, source_branch_id, destination_branch_id, medicine_id,
      batch_id, batch_number, transfer_quantity, received_quantity, discrepancy_quantity,
      status, dispatch_date, in_transit_date, received_date, dispatched_by, received_by, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertTransfer.run(
    'trf-001',
    'TRF-2026-001',
    'br-westside',
    'br-downtown',
    'med-amox500',
    'bat-med-amox500-br-westside-a',
    'BN-202601',
    90,
    null,
    0,
    TransferStatus.IN_TRANSIT,
    addDays(now, -2) + 'T09:15:00.000Z',
    addDays(now, -1) + 'T11:30:00.000Z',
    null,
    'Sophia Lin',
    null,
    'Urgent stock rebalancing for Downtown Amoxil Forte demand'
  );
  insertTransfer.run(
    'trf-002',
    'TRF-2026-002',
    'br-downtown',
    'br-westside',
    'med-para500',
    'bat-med-para500-br-downtown-a',
    'BN-202611',
    120,
    118,
    -2,
    TransferStatus.RECEIVED,
    addDays(now, -5) + 'T14:00:00.000Z',
    addDays(now, -4) + 'T08:00:00.000Z',
    addDays(now, -3) + 'T16:20:00.000Z',
    'Noah Patel',
    'Sophia Lin',
    '2 tablets damaged in transit packaging — logged on discrepancy report'
  );

  // 6. Seed 1 pending offline outbox operation on Northgate (to demonstrate live sync queue)
  const ngOpId = 'op-ng-pending-001';
  const ngSalePayload = {
    id: 'sale-ng-offline-001',
    operationId: ngOpId,
    invoiceNumber: 'INV-NG-2091',
    branchId: 'br-northgate',
    cashierId: 'usr-cashier',
    cashierName: 'Liam Brooks',
    items: [
      {
        medicineId: 'med-para500',
        medicineName: 'Panadol Advance 500 mg',
        batchId: 'bat-med-para500-br-northgate-a',
        batchNumber: 'BN-202611',
        expiryDate: addDays(now, 375),
        packUnit: 'STRIP',
        packQuantity: 2,
        baseUnits: 24,
        unitPrice: 0.14, // Slightly older offline price vs central $0.15 -> triggers OLD_PRICE_SALE rule on sync!
        lineTotal: 3.36,
        prescriptionOnly: false,
      },
    ],
    subtotal: 3.36,
    discountPercent: 0,
    discountAmount: 0,
    taxAmount: 0.17,
    totalAmount: 3.53,
    paymentMethod: 'CASH',
    prescription: null,
    createdOffline: true,
    checkoutDurationMs: 54,
    createdAt: new Date(now.getTime() - 4 * 3600_000).toISOString(),
  };

  br.prepare(`
    INSERT INTO local_sales (
      id, operation_id, invoice_number, branch_id, cashier_id, cashier_name,
      items_json, subtotal, discount_percent, discount_amount, tax_amount, total_amount,
      payment_method, prescription_json, status, created_offline, synced, checkout_duration_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 'CASH', NULL, 'COMPLETED', 1, 0, 54, ?)
  `).run(
    ngSalePayload.id, ngSalePayload.operationId, ngSalePayload.invoiceNumber, ngSalePayload.branchId,
    ngSalePayload.cashierId, ngSalePayload.cashierName, JSON.stringify(ngSalePayload.items),
    ngSalePayload.subtotal, ngSalePayload.taxAmount, ngSalePayload.totalAmount, ngSalePayload.createdAt
  );

  br.prepare(`
    INSERT INTO sync_outbox (
      operation_id, sequence_no, branch_id, op_type, payload_json, status, retry_count, next_retry_at, last_error, created_at
    ) VALUES (?, 1, 'br-northgate', 'SALE', ?, 'PENDING', 0, NULL, NULL, ?)
  `).run(ngOpId, JSON.stringify(ngSalePayload), ngSalePayload.createdAt);

  // 7. Seed 1 Open Stock Count Task
  ho.prepare(`
    INSERT INTO stock_count_tasks (
      id, branch_id, medicine_id, batch_id, batch_number, expected_qty, counted_qty, variance, reason, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'OPEN', ?)
  `).run(
    'sct-001',
    'br-westside',
    'med-para500',
    'bat-med-para500-br-westside-a',
    'BN-202611',
    275,
    'Scheduled cycle count following transfer TRF-2026-002 discrepancy',
    nowIso
  );

  // Staff accounts are provisioned on first-run admin setup (/api/auth/bootstrap)
  // or when an operator explicitly authenticates with a configured PHARMASYNC_ADMIN_PASSWORD secret.
}

export function provisionStaffAccounts(
  ho: DatabaseSync,
  password: string,
  adminFullName: string,
  adminEmail: string
): void {
  const nowIso = new Date().toISOString();
  const accounts = [
    { id: 'usr-super', username: 'superadmin', fullName: adminFullName || 'Dr. Elena Rostova', email: adminEmail || 'admin@pharmasync.org', role: UserRole.SUPER_ADMIN, branchId: 'br-ho' },
    { id: 'usr-hoadmin', username: 'hoadmin', fullName: 'Julian Vance', email: 'ho.admin@pharmasync.org', role: UserRole.HEAD_OFFICE_ADMIN, branchId: 'br-ho' },
    { id: 'usr-manager', username: 'manager', fullName: 'Sophia Lin', email: 'manager.dt@pharmasync.org', role: UserRole.BRANCH_MANAGER, branchId: 'br-downtown' },
    { id: 'usr-pharm', username: 'pharmacist', fullName: 'Marcus Vance, PharmD', email: 'pharmacist.dt@pharmasync.org', role: UserRole.PHARMACIST, branchId: 'br-downtown' },
    { id: 'usr-cashier', username: 'cashier', fullName: 'Priya Nair', email: 'cashier.dt@pharmasync.org', role: UserRole.CASHIER, branchId: 'br-downtown' },
    { id: 'usr-inv', username: 'inventory', fullName: 'Noah Patel', email: 'inventory.dt@pharmasync.org', role: UserRole.INVENTORY_STAFF, branchId: 'br-downtown' },
  ];

  const stmt = ho.prepare(`
    INSERT OR IGNORE INTO users (id, username, full_name, email, password_hash, role, branch_id, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);

  for (const acc of accounts) {
    // Each account gets a unique random salt via hashPassword
    stmt.run(acc.id, acc.username, acc.fullName, acc.email, hashPassword(password), acc.role, acc.branchId, nowIso);
  }
  ho.prepare(`INSERT OR REPLACE INTO system_meta (key, value) VALUES ('admin_claimed', 'true')`).run();
}

export function getConfiguredEnvAdminPassword(): string | null {
  const raw = process.env.PHARMASYNC_ADMIN_PASSWORD?.trim();
  if (!raw || raw.length < 6) return null;
  if (
    raw === 'undefined' ||
    raw === 'null' ||
    raw === 'CHANGE_ME' ||
    /^MY_[A-Z0-9_]+$/i.test(raw) ||
    /^(Secret|Dummy|Sample|Placeholder)\d{1,4}$/i.test(raw)
  ) {
    return null;
  }
  return raw;
}

export function createDatabaseCluster(customDir?: string): DatabaseCluster {
  const dir = customDir ?? DATA_DIR;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const headOffice = new DatabaseSync(path.join(dir, 'head_office.db'));
  const branchPos = new DatabaseSync(path.join(dir, 'branch_pos.db'));

  initHeadOfficeSchema(headOffice);
  initBranchPosSchema(branchPos);
  seedDatabases(headOffice, branchPos);

  const runTx = <T>(db: DatabaseSync, fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  return {
    headOffice,
    branchPos,
    runHeadOfficeTx: <T>(fn: () => T) => runTx(headOffice, fn),
    runBranchTx: <T>(fn: () => T) => runTx(branchPos, fn),
    close() {
      headOffice.close();
      branchPos.close();
    },
  };
}

// Repository helper mappers
export function mapMedicineRow(row: Record<string, unknown>): Medicine {
  return {
    id: String(row.id),
    genericName: String(row.generic_name),
    brandName: String(row.brand_name),
    strength: String(row.strength),
    dosageForm: String(row.dosage_form),
    manufacturer: String(row.manufacturer),
    barcode: String(row.barcode),
    category: String(row.category),
    purchasePrice: Number(row.purchase_price),
    sellingPrice: Number(row.selling_price),
    packHierarchy: {
      tabletsPerStrip: Number(row.tablets_per_strip),
      stripsPerBox: Number(row.strips_per_box),
    },
    prescriptionOnly: Boolean(row.prescription_only),
    active: Boolean(row.active),
    leadTimeDays: Number(row.lead_time_days),
    safetyStock: Number(row.safety_stock),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

export function mapBatchRow(row: Record<string, unknown>): Batch {
  const raw: Batch = {
    id: String(row.id),
    batchNumber: String(row.batch_number),
    medicineId: String(row.medicine_id),
    branchId: String(row.branch_id),
    manufacturingDate: String(row.manufacturing_date),
    expiryDate: String(row.expiry_date),
    quantity: Number(row.quantity),
    purchasePrice: Number(row.purchase_price),
    sellingPrice: Number(row.selling_price),
    status: String(row.status) as BatchStatus,
    recalledAt: row.recalled_at ? String(row.recalled_at) : null,
    recallReason: row.recall_reason ? String(row.recall_reason) : null,
    updatedAt: String(row.updated_at),
  };
  raw.status = evaluateBatchStatus(raw);
  return raw;
}

export function mapBranchRow(row: Record<string, unknown>, pendingOpsCount = 0): Branch {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    city: String(row.city),
    address: String(row.address),
    phone: String(row.phone),
    isHeadOffice: Boolean(row.is_head_office),
    online: Boolean(row.online),
    lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
    pendingOpsCount,
    deviceId: String(row.device_id),
  };
}

export function writeAuditLog(
  ho: DatabaseSync,
  entry: Omit<AuditLogEntry, 'id' | 'createdAt'>
): void {
  ho.prepare(`
    INSERT INTO audit_logs (id, trace_id, actor_id, actor_name, actor_role, action, resource, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `aud-${crypto.randomUUID().slice(0, 12)}`,
    entry.traceId,
    entry.actorId,
    entry.actorName,
    entry.actorRole,
    entry.action,
    entry.resource,
    entry.details,
    new Date().toISOString()
  );
}
