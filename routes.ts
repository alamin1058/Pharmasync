import crypto from 'node:crypto';
import express, { Router } from 'express';
import {
  AuthenticatedRequest,
  authenticate,
  hashPassword,
  requirePermission,
  sendProblem,
  signToken,
  verifyPassword,
} from './auth';
import {
  DatabaseCluster,
  getConfiguredEnvAdminPassword,
  mapBatchRow,
  mapBranchRow,
  mapMedicineRow,
  provisionStaffAccounts,
  writeAuditLog,
} from './db';
import { enqueueBranchOperation, synchronizeBranch } from './syncEngine';
import { OPENAPI_SPEC } from './openapi';
import {
  Batch,
  BatchStatus,
  PackUnit,
  PrescriptionInput,
  ROLE_PERMISSIONS,
  SaleItemInput,
  SaleLineAllocation,
  SaleRecord,
  SyncOpType,
  TransferStatus,
  UserRole,
} from '../src/shared/types';
import {
  assertTransferTransition,
  calculateCartTotals,
  calculateReorderSuggestion,
  computeTransferDiscrepancy,
  convertToBaseUnits,
  domainEvents,
  evaluateBatchStatus,
  fefoStrategy,
  validatePrescriptionRequirement,
} from '../src/shared/domainEngine';

export function createApiRouter(db: DatabaseCluster): Router {
  const router = express.Router();
  const startedAt = Date.now();
  let totalRequests = 0;
  let totalCheckouts = 0;
  const checkoutLatenciesMs: number[] = [];

  router.use((req, _res, next) => {
    totalRequests++;
    next();
  });

  // =========================================================================
  // PUBLIC OBSERVABILITY & OPENAPI
  // =========================================================================
  router.get('/openapi.json', (_req, res) => {
    res.json(OPENAPI_SPEC);
  });

  router.get('/actuator/health', (_req, res) => {
    res.json({
      status: 'UP',
      service: 'pharmasync-platform',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/actuator/ready', (_req, res) => {
    try {
      const hoCheck = db.headOffice.prepare('SELECT 1 as ok').get() as { ok: number };
      const brCheck = db.branchPos.prepare('SELECT 1 as ok').get() as { ok: number };
      res.json({
        status: hoCheck.ok === 1 && brCheck.ok === 1 ? 'READY' : 'DEGRADED',
        databases: {
          headOfficeSqlite: 'UP',
          branchPosSqlite: 'UP',
        },
      });
    } catch {
      res.status(503).json({ status: 'DOWN' });
    }
  });

  // =========================================================================
  // AUTHENTICATION & FIRST-RUN ADMIN SETUP
  // =========================================================================
  router.get('/auth/status', (_req, res) => {
    const claimedRow = db.headOffice
      .prepare(`SELECT value FROM system_meta WHERE key = 'admin_claimed'`)
      .get() as { value: string } | undefined;
    const userCount = (db.headOffice.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
    const envConfigured = Boolean(getConfiguredEnvAdminPassword());
    const initialized = userCount > 0 && claimedRow?.value === 'true';
    res.json({
      initialized,
      envConfigured,
      rolesAvailable: Object.values(UserRole),
    });
  });

  router.post('/auth/bootstrap', (req: AuthenticatedRequest, res) => {
    const claimedRow = db.headOffice
      .prepare(`SELECT value FROM system_meta WHERE key = 'admin_claimed'`)
      .get() as { value: string } | undefined;
    const userCount = (db.headOffice.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
    if (userCount > 0 && claimedRow?.value === 'true') {
      sendProblem(res, 409, 'Already Initialized', 'Workspace administrator has already been configured.', undefined, req.traceId);
      return;
    }

    const { password, fullName, email } = req.body ?? {};
    if (typeof password !== 'string' || password.trim().length < 6) {
      sendProblem(
        res,
        400,
        'Validation Failed',
        'Password must be at least 6 characters long.',
        { password: 'Minimum 6 characters required.' },
        req.traceId
      );
      return;
    }

    const safeName = typeof fullName === 'string' && fullName.trim().length >= 2 ? fullName.trim() : 'Dr. Elena Rostova';
    const safeEmail = typeof email === 'string' && email.includes('@') ? email.trim() : 'admin@pharmasync.org';

    db.runHeadOfficeTx(() => {
      provisionStaffAccounts(db.headOffice, password.trim(), safeName, safeEmail);
    });

    const adminRow = db.headOffice
      .prepare(`
        SELECT u.*, b.name as branch_name
        FROM users u JOIN branches b ON b.id = u.branch_id
        WHERE u.username = 'superadmin'
      `)
      .get() as Record<string, unknown>;

    const user = {
      id: String(adminRow.id),
      username: String(adminRow.username),
      fullName: String(adminRow.full_name),
      email: String(adminRow.email),
      role: String(adminRow.role) as UserRole,
      branchId: String(adminRow.branch_id),
      branchName: String(adminRow.branch_name),
      active: true,
      permissions: ROLE_PERMISSIONS[String(adminRow.role) as UserRole],
    };

    writeAuditLog(db.headOffice, {
      traceId: req.traceId ?? 'bootstrap',
      actorId: user.id,
      actorName: user.fullName,
      actorRole: user.role,
      action: 'WORKSPACE_BOOTSTRAP',
      resource: 'system',
      details: 'Initialized Super Admin credentials and 6-role pharmacy staff directory.',
    });

    const token = signToken(user);
    res.status(201).json({ token, user });
  });

  router.post('/auth/login', (req: AuthenticatedRequest, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      sendProblem(res, 400, 'Validation Failed', 'Username and password are required.', undefined, req.traceId);
      return;
    }

    const identifier = username.trim().toLowerCase();
    const envPass = getConfiguredEnvAdminPassword();
    const matchesEnvSecret = (() => {
      if (!envPass) return false;
      const a = Buffer.from(password, 'utf8');
      const b = Buffer.from(envPass, 'utf8');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    })();

    // If workspace is not yet claimed and an operator authenticates with the configured PHARMASYNC_ADMIN_PASSWORD secret,
    // provision the staff accounts on demand with that secret.
    const existingUsers = (db.headOffice.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
    if (existingUsers === 0 && identifier === 'superadmin' && matchesEnvSecret && envPass) {
      db.runHeadOfficeTx(() => {
        provisionStaffAccounts(db.headOffice, envPass, 'Dr. Elena Rostova', 'admin@pharmasync.org');
      });
    }

    const row = db.headOffice
      .prepare(`
        SELECT u.*, b.name as branch_name
        FROM users u JOIN branches b ON b.id = u.branch_id
        WHERE LOWER(u.username) = ? OR LOWER(u.email) = ?
      `)
      .get(identifier, identifier) as Record<string, unknown> | undefined;

    if (!row || !Boolean(row.active)) {
      sendProblem(res, 401, 'Invalid Credentials', 'Invalid username or password.', undefined, req.traceId);
      return;
    }

    const validEnvOverride = String(row.username) === 'superadmin' && matchesEnvSecret;
    const validHash = verifyPassword(password, String(row.password_hash));

    if (!validEnvOverride && !validHash) {
      sendProblem(res, 401, 'Invalid Credentials', 'Invalid username or password.', undefined, req.traceId);
      return;
    }

    const role = String(row.role) as UserRole;
    const user = {
      id: String(row.id),
      username: String(row.username),
      fullName: String(row.full_name),
      email: String(row.email),
      role,
      branchId: String(row.branch_id),
      branchName: String(row.branch_name),
      active: true,
      permissions: ROLE_PERMISSIONS[role] ?? [],
    };

    writeAuditLog(db.headOffice, {
      traceId: req.traceId ?? 'login',
      actorId: user.id,
      actorName: user.fullName,
      actorRole: user.role,
      action: 'USER_LOGIN',
      resource: `user:${user.username}`,
      details: `Authenticated via Bearer JWT for branch ${user.branchName}`,
    });

    const token = signToken(user);
    res.json({ token, user });
  });

  // =========================================================================
  // AUTHENTICATED ROUTES BELOW
  // =========================================================================
  router.use(authenticate);

  router.get('/auth/me', (req: AuthenticatedRequest, res) => {
    res.json({ user: req.user });
  });

  router.get('/actuator/metrics', (_req, res) => {
    const sorted = [...checkoutLatenciesMs].sort((a, b) => a - b);
    const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0;
    const pendingSync = (
      db.branchPos.prepare(`SELECT COUNT(*) as c FROM sync_outbox WHERE status IN ('PENDING', 'FAILED')`).get() as {
        c: number;
      }
    ).c;
    const openConflicts = (
      db.headOffice.prepare('SELECT COUNT(*) as c FROM conflicts WHERE resolved = 0').get() as { c: number }
    ).c;

    res.json({
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      httpRequestsTotal: totalRequests,
      posCheckoutsTotal: totalCheckouts,
      posCheckoutP95Ms: Number(p95.toFixed(2)),
      pendingSyncOperations: pendingSync,
      unresolvedConflicts: openConflicts,
      memoryUsageMb: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1)),
    });
  });

  // =========================================================================
  // MODULE 1: DASHBOARD (HEAD OFFICE & BRANCH)
  // =========================================================================
  router.get('/dashboard', (req: AuthenticatedRequest, res) => {
    const mode = req.query.mode === 'branch' ? 'branch' : 'head_office';
    const branchId = typeof req.query.branchId === 'string' && req.query.branchId ? req.query.branchId : 'br-downtown';
    const todayPrefix = new Date().toISOString().slice(0, 10);
    const monthPrefix = new Date().toISOString().slice(0, 7);

    const medicines = db.headOffice.prepare('SELECT * FROM medicines WHERE active = 1').all() as Array<Record<string, unknown>>;
    const branchRows = db.headOffice.prepare('SELECT * FROM branches ORDER BY is_head_office DESC, code ASC').all() as Array<Record<string, unknown>>;

    const batchesRaw = (
      mode === 'branch'
        ? db.branchPos.prepare('SELECT * FROM local_batches WHERE branch_id = ?').all(branchId)
        : db.headOffice.prepare('SELECT * FROM batches').all()
    ) as Array<Record<string, unknown>>;
    const batches = batchesRaw.map(mapBatchRow);

    const totalStockValue = Number(
      batches
        .filter((b) => b.status !== BatchStatus.EXPIRED && b.status !== BatchStatus.RECALLED)
        .reduce((sum, b) => sum + b.quantity * b.purchasePrice, 0)
        .toFixed(2)
    );

    const expiringBatches = batches.filter((b) => b.status === BatchStatus.EXPIRING_SOON);
    const expiredBatches = batches.filter((b) => b.status === BatchStatus.EXPIRED && b.quantity > 0);
    const recalledBatches = batches.filter((b) => b.status === BatchStatus.RECALLED && b.quantity > 0);

    // Low-stock calculation (branch-level in both modes so Head Office surfaces every branch SKU below safety stock)
    const branchNameMap = new Map(branchRows.map((b) => [String(b.id), String(b.name)]));
    const retailBranchIds = branchRows.filter((b) => !Boolean(b.is_head_office)).map((b) => String(b.id));
    const stockByBranchMed = new Map<string, number>();
    for (const b of batches) {
      if (b.status === BatchStatus.ACTIVE || b.status === BatchStatus.EXPIRING_SOON) {
        const key = `${b.branchId}:${b.medicineId}`;
        stockByBranchMed.set(key, (stockByBranchMed.get(key) ?? 0) + b.quantity);
      }
    }
    const targetBranches = mode === 'branch' ? [branchId] : retailBranchIds;
    const lowStockItems = targetBranches
      .flatMap((bid) =>
        medicines.map((m) => {
          const qty = stockByBranchMed.get(`${bid}:${String(m.id)}`) ?? 0;
          const threshold = Number(m.safety_stock);
          const shortBranch = (branchNameMap.get(bid) ?? bid).split(' ')[0];
          return {
            medicineId: `${String(m.id)}-${bid}`,
            brandName: mode === 'head_office' ? `${String(m.brand_name)} · ${shortBranch}` : String(m.brand_name),
            genericName: String(m.generic_name),
            category: String(m.category),
            currentStock: qty,
            safetyStock: threshold,
          };
        })
      )
      .filter((x) => x.currentStock <= x.safetyStock)
      .sort((a, b) => a.currentStock / Math.max(1, a.safetyStock) - b.currentStock / Math.max(1, b.safetyStock));

    // Sales metrics
    const salesQuery =
      mode === 'branch'
        ? db.branchPos.prepare('SELECT * FROM local_sales WHERE branch_id = ? ORDER BY created_at DESC').all(branchId)
        : db.headOffice.prepare('SELECT * FROM sales ORDER BY created_at DESC').all();
    const salesRows = salesQuery as Array<Record<string, unknown>>;

    const todaySales = Number(
      salesRows
        .filter((s) => String(s.created_at).startsWith(todayPrefix) && String(s.status) !== 'RETURNED')
        .reduce((sum, s) => sum + Number(s.total_amount), 0)
        .toFixed(2)
    );
    const monthlySales = Number(
      salesRows
        .filter((s) => String(s.created_at).startsWith(monthPrefix) && String(s.status) !== 'RETURNED')
        .reduce((sum, s) => sum + Number(s.total_amount), 0)
        .toFixed(2)
    );

    // Sales trend (last 14 days)
    const trendMap = new Map<string, { date: string; revenue: number; transactions: number }>();
    const now = new Date();
    for (let d = 13; d >= 0; d--) {
      const dt = new Date(now.getTime() - d * 86400_000).toISOString().slice(0, 10);
      trendMap.set(dt, { date: dt.slice(5), revenue: 0, transactions: 0 });
    }
    for (const s of salesRows) {
      const dt = String(s.created_at).slice(0, 10);
      const entry = trendMap.get(dt);
      if (entry && String(s.status) !== 'RETURNED') {
        entry.revenue = Number((entry.revenue + Number(s.total_amount)).toFixed(2));
        entry.transactions += 1;
      }
    }

    // Pending sync counts per branch
    const pendingCountsRows = db.branchPos
      .prepare(`SELECT branch_id, COUNT(*) as c FROM sync_outbox WHERE status IN ('PENDING', 'FAILED') GROUP BY branch_id`)
      .all() as Array<{ branch_id: string; c: number }>;
    const pendingByBranch = new Map(pendingCountsRows.map((r) => [r.branch_id, r.c]));
    const totalPendingSync =
      mode === 'branch'
        ? pendingByBranch.get(branchId) ?? 0
        : pendingCountsRows.reduce((sum, r) => sum + r.c, 0);

    const branchMap = new Map(branchRows.map((b) => [String(b.id), String(b.name)]));

    const branchStatusList = branchRows
      .filter((b) => !Boolean(b.is_head_office))
      .map((b) => {
        const bid = String(b.id);
        const branchSalesTotal = salesRows
          .filter((s) => String(s.branch_id) === bid && String(s.status) !== 'RETURNED')
          .reduce((sum, s) => sum + Number(s.total_amount), 0);
        return {
          ...mapBranchRow(b, pendingByBranch.get(bid) ?? 0),
          revenue30d: Number(branchSalesTotal.toFixed(2)),
        };
      });

    // Category stock value breakdown
    const medCatMap = new Map(medicines.map((m) => [String(m.id), String(m.category)]));
    const catValue = new Map<string, number>();
    for (const b of batches) {
      if (b.status === BatchStatus.ACTIVE || b.status === BatchStatus.EXPIRING_SOON) {
        const cat = medCatMap.get(b.medicineId) ?? 'Other';
        catValue.set(cat, Number(((catValue.get(cat) ?? 0) + b.quantity * b.purchasePrice).toFixed(2)));
      }
    }

    const recentTransactions = salesRows.slice(0, 10).map((s) => ({
      id: String(s.id),
      invoiceNumber: String(s.invoice_number),
      branchId: String(s.branch_id),
      branchName: branchMap.get(String(s.branch_id)) ?? String(s.branch_id),
      cashierName: String(s.cashier_name),
      totalAmount: Number(s.total_amount),
      paymentMethod: String(s.payment_method),
      status: String(s.status),
      createdOffline: Boolean(s.created_offline),
      synced: s.synced === undefined ? true : Boolean(s.synced),
      itemCount: (JSON.parse(String(s.items_json)) as unknown[]).length,
      createdAt: String(s.created_at),
    }));

    const openConflicts = (
      db.headOffice.prepare('SELECT COUNT(*) as c FROM conflicts WHERE resolved = 0').get() as { c: number }
    ).c;

    res.json({
      mode,
      branchId,
      kpis: {
        totalMedicines: medicines.length,
        totalBranches: branchRows.filter((b) => !Boolean(b.is_head_office)).length,
        totalStockValue,
        todaySales,
        monthlySales,
        lowStockCount: lowStockItems.length,
        expiringCount: expiringBatches.length,
        expiredCount: expiredBatches.length,
        recalledCount: recalledBatches.length,
        pendingSyncCount: totalPendingSync,
        openConflictsCount: openConflicts,
      },
      salesTrend: Array.from(trendMap.values()),
      categoryValuation: Array.from(catValue.entries())
        .map(([category, value]) => ({ category, value }))
        .sort((a, b) => b.value - a.value),
      branches: branchStatusList,
      lowStockItems: lowStockItems.slice(0, 8),
      recentTransactions,
    });
  });

  // =========================================================================
  // MODULE 2: MEDICINE CATALOGUE
  // =========================================================================
  router.get('/medicines', (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
    const rxOnly = req.query.rxOnly;

    const rows = db.headOffice.prepare('SELECT * FROM medicines ORDER BY brand_name ASC').all() as Array<Record<string, unknown>>;
    let meds = rows.map(mapMedicineRow);

    if (search) {
      meds = meds.filter((m) =>
        `${m.brandName} ${m.genericName} ${m.barcode} ${m.manufacturer} ${m.strength} ${m.category}`
          .toLowerCase()
          .includes(search)
      );
    }
    if (category && category !== 'ALL') {
      meds = meds.filter((m) => m.category === category);
    }
    if (rxOnly === 'true') {
      meds = meds.filter((m) => m.prescriptionOnly);
    } else if (rxOnly === 'false') {
      meds = meds.filter((m) => !m.prescriptionOnly);
    }

    res.json({ items: meds, total: meds.length });
  });

  router.post('/medicines', requirePermission('medicines:write'), (req: AuthenticatedRequest, res) => {
    const b = req.body ?? {};
    const errors: Record<string, string> = {};
    if (!b.genericName?.trim()) errors.genericName = 'Generic name is required.';
    if (!b.brandName?.trim()) errors.brandName = 'Brand name is required.';
    if (!b.barcode?.trim()) errors.barcode = 'Barcode is required.';
    if (!(Number(b.purchasePrice) > 0)) errors.purchasePrice = 'Purchase price must be positive.';
    if (!(Number(b.sellingPrice) > 0)) errors.sellingPrice = 'Selling price must be positive.';

    if (Object.keys(errors).length > 0) {
      sendProblem(res, 400, 'Validation Failed', 'Please fix medicine form errors.', errors, req.traceId);
      return;
    }

    const id = `med-${crypto.randomUUID().slice(0, 8)}`;
    const nowIso = new Date().toISOString();
    const maxVer = (db.headOffice.prepare('SELECT COALESCE(MAX(version), 1) as v FROM medicines').get() as { v: number }).v + 1;

    try {
      db.headOffice
        .prepare(`
          INSERT INTO medicines (
            id, generic_name, brand_name, strength, dosage_form, manufacturer, barcode, category,
            purchase_price, selling_price, tablets_per_strip, strips_per_box, prescription_only,
            active, lead_time_days, safety_stock, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          String(b.genericName).trim(),
          String(b.brandName).trim(),
          String(b.strength || '500 mg').trim(),
          String(b.dosageForm || 'Tablet').trim(),
          String(b.manufacturer || 'Generic Labs').trim(),
          String(b.barcode).trim(),
          String(b.category || 'General').trim(),
          Number(b.purchasePrice),
          Number(b.sellingPrice),
          Math.max(1, Number(b.tabletsPerStrip || 10)),
          Math.max(1, Number(b.stripsPerBox || 3)),
          b.prescriptionOnly ? 1 : 0,
          b.active === false ? 0 : 1,
          Math.max(1, Number(b.leadTimeDays || 5)),
          Math.max(0, Number(b.safetyStock || 60)),
          nowIso,
          maxVer
        );

      // Push immediately to online branches
      const onlineBranches = db.headOffice
        .prepare('SELECT id FROM branches WHERE is_head_office = 0 AND online = 1')
        .all() as Array<{ id: string }>;
      for (const br of onlineBranches) {
        synchronizeBranch(db, br.id);
      }

      writeAuditLog(db.headOffice, {
        traceId: req.traceId ?? 'med-create',
        actorId: req.user!.id,
        actorName: req.user!.fullName,
        actorRole: req.user!.role,
        action: 'MEDICINE_CREATED',
        resource: `medicine:${id}`,
        details: `Created ${b.brandName} (${b.genericName}) @ $${Number(b.sellingPrice).toFixed(2)}`,
      });

      const created = db.headOffice.prepare('SELECT * FROM medicines WHERE id = ?').get(id) as Record<string, unknown>;
      res.status(201).json(mapMedicineRow(created));
    } catch (err) {
      sendProblem(res, 409, 'Conflict', err instanceof Error ? err.message : 'Barcode may already exist.', undefined, req.traceId);
    }
  });

  router.put('/medicines/:id', requirePermission('medicines:write'), (req: AuthenticatedRequest, res) => {
    const medId = req.params.id;
    const existing = db.headOffice.prepare('SELECT * FROM medicines WHERE id = ?').get(medId) as Record<string, unknown> | undefined;
    if (!existing) {
      sendProblem(res, 404, 'Not Found', `Medicine ${medId} not found.`, undefined, req.traceId);
      return;
    }

    const b = req.body ?? {};
    const nowIso = new Date().toISOString();
    const nextVersion = (db.headOffice.prepare('SELECT COALESCE(MAX(version), 1) as v FROM medicines').get() as { v: number }).v + 1;
    const newSellingPrice = b.sellingPrice !== undefined ? Number(b.sellingPrice) : Number(existing.selling_price);
    const newPurchasePrice = b.purchasePrice !== undefined ? Number(b.purchasePrice) : Number(existing.purchase_price);

    db.runHeadOfficeTx(() => {
      db.headOffice
        .prepare(`
          UPDATE medicines SET
            generic_name = ?, brand_name = ?, strength = ?, dosage_form = ?, manufacturer = ?,
            barcode = ?, category = ?, purchase_price = ?, selling_price = ?,
            tablets_per_strip = ?, strips_per_box = ?, prescription_only = ?,
            active = ?, lead_time_days = ?, safety_stock = ?, updated_at = ?, version = ?
          WHERE id = ?
        `)
        .run(
          String(b.genericName ?? existing.generic_name),
          String(b.brandName ?? existing.brand_name),
          String(b.strength ?? existing.strength),
          String(b.dosageForm ?? existing.dosage_form),
          String(b.manufacturer ?? existing.manufacturer),
          String(b.barcode ?? existing.barcode),
          String(b.category ?? existing.category),
          newPurchasePrice,
          newSellingPrice,
          Number(b.tabletsPerStrip ?? existing.tablets_per_strip),
          Number(b.stripsPerBox ?? existing.strips_per_box),
          b.prescriptionOnly !== undefined ? (b.prescriptionOnly ? 1 : 0) : Number(existing.prescription_only),
          b.active !== undefined ? (b.active ? 1 : 0) : Number(existing.active),
          Number(b.leadTimeDays ?? existing.lead_time_days),
          Number(b.safetyStock ?? existing.safety_stock),
          nowIso,
          nextVersion,
          medId
        );

      // Update central batch selling prices for active batches
      db.headOffice
        .prepare(`UPDATE batches SET selling_price = ?, updated_at = ? WHERE medicine_id = ? AND status NOT IN ('EXPIRED', 'RECALLED')`)
        .run(newSellingPrice, nowIso, medId);
    });

    // Propagate to online branches only (offline branches retain old price until next sync, proving Module 7!)
    const onlineBranches = db.headOffice
      .prepare('SELECT id FROM branches WHERE is_head_office = 0 AND online = 1')
      .all() as Array<{ id: string }>;
    for (const br of onlineBranches) {
      synchronizeBranch(db, br.id);
    }

    writeAuditLog(db.headOffice, {
      traceId: req.traceId ?? 'med-update',
      actorId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.role,
      action: 'MEDICINE_UPDATED',
      resource: `medicine:${medId}`,
      details: `Updated central selling price to $${newSellingPrice.toFixed(2)} (v${nextVersion})`,
    });

    const updated = db.headOffice.prepare('SELECT * FROM medicines WHERE id = ?').get(medId) as Record<string, unknown>;
    res.json(mapMedicineRow(updated));
  });

  // =========================================================================
  // MODULE 3: BATCH INVENTORY & RECEIVING
  // =========================================================================
  router.get('/batches', (req, res) => {
    const branchId = typeof req.query.branchId === 'string' && req.query.branchId !== 'ALL' ? req.query.branchId : null;
    const statusFilter = typeof req.query.status === 'string' ? req.query.status : 'ALL';
    const source = req.query.source === 'local' ? 'local' : 'central';

    const medMap = new Map(
      (db.headOffice.prepare('SELECT * FROM medicines').all() as Array<Record<string, unknown>>).map((m) => [
        String(m.id),
        mapMedicineRow(m),
      ])
    );
    const branchMap = new Map(
      (db.headOffice.prepare('SELECT id, name FROM branches').all() as Array<{ id: string; name: string }>).map((b) => [
        b.id,
        b.name,
      ])
    );

    const rows = (
      source === 'local' && branchId
        ? db.branchPos.prepare('SELECT * FROM local_batches WHERE branch_id = ? ORDER BY expiry_date ASC').all(branchId)
        : branchId
          ? db.headOffice.prepare('SELECT * FROM batches WHERE branch_id = ? ORDER BY expiry_date ASC').all(branchId)
          : db.headOffice.prepare('SELECT * FROM batches ORDER BY expiry_date ASC').all()
    ) as Array<Record<string, unknown>>;

    let batches = rows.map((r) => {
      const b = mapBatchRow(r);
      const med = medMap.get(b.medicineId);
      const daysToExpiry = Math.ceil((new Date(b.expiryDate).getTime() - Date.now()) / 86400_000);
      return {
        ...b,
        medicineName: med ? `${med.brandName} ${med.strength}` : b.medicineId,
        genericName: med?.genericName ?? '',
        barcode: med?.barcode ?? '',
        category: med?.category ?? '',
        prescriptionOnly: med?.prescriptionOnly ?? false,
        branchName: branchMap.get(b.branchId) ?? b.branchId,
        daysToExpiry,
      };
    });

    if (statusFilter && statusFilter !== 'ALL') {
      batches = batches.filter((b) => b.status === statusFilter);
    }

    res.json({ items: batches, total: batches.length });
  });

  router.post('/batches', requirePermission('inventory:write'), (req: AuthenticatedRequest, res) => {
    const b = req.body ?? {};
    const errors: Record<string, string> = {};
    if (!b.medicineId) errors.medicineId = 'Medicine is required.';
    if (!b.branchId) errors.branchId = 'Branch is required.';
    if (!b.batchNumber?.trim()) errors.batchNumber = 'Batch number is required.';
    if (!b.manufacturingDate) errors.manufacturingDate = 'Manufacturing date is required.';
    if (!b.expiryDate) errors.expiryDate = 'Expiry date is required.';
    if (!(Number(b.quantity) > 0)) errors.quantity = 'Quantity must be positive.';

    if (Object.keys(errors).length > 0) {
      sendProblem(res, 400, 'Validation Failed', 'Please complete all required batch fields.', errors, req.traceId);
      return;
    }

    const medRow = db.headOffice.prepare('SELECT * FROM medicines WHERE id = ?').get(b.medicineId) as Record<string, unknown> | undefined;
    if (!medRow) {
      sendProblem(res, 404, 'Not Found', 'Medicine not found.', undefined, req.traceId);
      return;
    }

    const batchId = `bat-${crypto.randomUUID().slice(0, 10)}`;
    const opId = `op-rcv-${crypto.randomUUID().slice(0, 10)}`;
    const nowIso = new Date().toISOString();
    const buyPrice = b.purchasePrice ? Number(b.purchasePrice) : Number(medRow.purchase_price);
    const sellPrice = b.sellingPrice ? Number(b.sellingPrice) : Number(medRow.selling_price);
    const status = evaluateBatchStatus({
      expiryDate: String(b.expiryDate),
      quantity: Number(b.quantity),
      status: BatchStatus.ACTIVE,
      recalledAt: null,
    });

    // Write to Branch Local DB + Outbox (Offline-First!)
    db.runBranchTx(() => {
      db.branchPos
        .prepare(`
          INSERT INTO local_batches (
            id, batch_number, medicine_id, branch_id, manufacturing_date, expiry_date,
            quantity, purchase_price, selling_price, status, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          batchId,
          String(b.batchNumber).trim(),
          String(b.medicineId),
          String(b.branchId),
          String(b.manufacturingDate),
          String(b.expiryDate),
          Number(b.quantity),
          buyPrice,
          sellPrice,
          status,
          nowIso
        );
    });

    enqueueBranchOperation(db, String(b.branchId), SyncOpType.STOCK_RECEIPT, opId, {
      batchId,
      batchNumber: String(b.batchNumber).trim(),
      medicineId: String(b.medicineId),
      manufacturingDate: String(b.manufacturingDate),
      expiryDate: String(b.expiryDate),
      quantity: Number(b.quantity),
      purchasePrice: buyPrice,
      sellingPrice: sellPrice,
    });

    // If branch is online, sync immediately to Head Office
    const branchRow = db.headOffice.prepare('SELECT online FROM branches WHERE id = ?').get(String(b.branchId)) as { online: number } | undefined;
    const syncedNow = Boolean(branchRow?.online) && !b.forceOffline;
    if (syncedNow) {
      synchronizeBranch(db, String(b.branchId));
    }

    writeAuditLog(db.headOffice, {
      traceId: req.traceId ?? 'batch-rcv',
      actorId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.role,
      action: 'STOCK_RECEIVED',
      resource: `batch:${b.batchNumber}`,
      details: `Received ${b.quantity} units of ${medRow.brand_name} into ${b.branchId} (${syncedNow ? 'Synced' : 'Queued Offline'})`,
    });

    res.status(201).json({
      id: batchId,
      batchNumber: String(b.batchNumber).trim(),
      status,
      synced: syncedNow,
      operationId: opId,
    });
  });

  // =========================================================================
  // MODULE 4 & 5: POINT OF SALE (ONLINE + OFFLINE-FIRST, FEFO, RX GUARD)
  // =========================================================================
  router.get('/pos/barcode/:code', (req: AuthenticatedRequest, res) => {
    const start = performance.now();
    const branchId = typeof req.query.branchId === 'string' && req.query.branchId ? req.query.branchId : 'br-downtown';
    const code = req.params.code.trim();

    const medRow = db.branchPos
      .prepare('SELECT * FROM local_medicines WHERE barcode = ? AND active = 1')
      .get(code) as Record<string, unknown> | undefined;

    if (!medRow) {
      sendProblem(res, 404, 'Barcode Not Found', `No active medicine matches barcode ${code}.`, undefined, req.traceId);
      return;
    }

    const medicine = mapMedicineRow(medRow);
    const localBatches = (
      db.branchPos
        .prepare('SELECT * FROM local_batches WHERE medicine_id = ? AND branch_id = ? ORDER BY expiry_date ASC')
        .all(medicine.id, branchId) as Array<Record<string, unknown>>
    ).map(mapBatchRow);

    const eligibleBatches = localBatches.filter(
      (b) => b.status !== BatchStatus.EXPIRED && b.status !== BatchStatus.RECALLED && b.quantity > 0
    );

    res.json({
      medicine,
      availableUnits: eligibleBatches.reduce((sum, b) => sum + b.quantity, 0),
      fefoNextBatch: eligibleBatches[0] ?? null,
      allBatches: localBatches,
      lookupMs: Number((performance.now() - start).toFixed(2)),
    });
  });

  router.get('/pos/sales', (req, res) => {
    const branchId = typeof req.query.branchId === 'string' && req.query.branchId !== 'ALL' ? req.query.branchId : null;
    const branchMap = new Map(
      (db.headOffice.prepare('SELECT id, name FROM branches').all() as Array<{ id: string; name: string }>).map((b) => [
        b.id,
        b.name,
      ])
    );

    const rows = (
      branchId
        ? db.branchPos.prepare('SELECT * FROM local_sales WHERE branch_id = ? ORDER BY created_at DESC LIMIT 100').all(branchId)
        : db.headOffice.prepare('SELECT * FROM sales ORDER BY created_at DESC LIMIT 100').all()
    ) as Array<Record<string, unknown>>;

    const sales: SaleRecord[] = rows.map((r) => ({
      id: String(r.id),
      operationId: String(r.operation_id),
      invoiceNumber: String(r.invoice_number),
      branchId: String(r.branch_id),
      branchName: branchMap.get(String(r.branch_id)) ?? String(r.branch_id),
      cashierId: String(r.cashier_id),
      cashierName: String(r.cashier_name),
      items: JSON.parse(String(r.items_json)),
      subtotal: Number(r.subtotal),
      discountPercent: Number(r.discount_percent),
      discountAmount: Number(r.discount_amount),
      taxAmount: Number(r.tax_amount),
      totalAmount: Number(r.total_amount),
      paymentMethod: String(r.payment_method) as SaleRecord['paymentMethod'],
      prescription: r.prescription_json ? JSON.parse(String(r.prescription_json)) : null,
      status: String(r.status) as SaleRecord['status'],
      createdOffline: Boolean(r.created_offline),
      synced: r.synced === undefined ? true : Boolean(r.synced),
      checkoutDurationMs: Number(r.checkout_duration_ms ?? 0),
      createdAt: String(r.created_at),
    }));

    res.json({ items: sales, total: sales.length });
  });

  router.post('/pos/sales', requirePermission('pos:sell'), (req: AuthenticatedRequest, res) => {
    const start = performance.now();
    const {
      branchId = req.user!.branchId === 'br-ho' ? 'br-downtown' : req.user!.branchId,
      items,
      discountPercent = 0,
      paymentMethod = 'CARD',
      prescription = null,
      offlineMode = false,
      operationId: clientOpId,
    } = req.body ?? {};

    if (!Array.isArray(items) || items.length === 0) {
      sendProblem(res, 400, 'Empty Cart', 'At least one medicine item is required to complete a sale.', undefined, req.traceId);
      return;
    }

    const opId = typeof clientOpId === 'string' && clientOpId.trim() ? clientOpId.trim() : `op-sale-${crypto.randomUUID()}`;

    // Idempotency guard on branch local DB
    const existingLocal = db.branchPos.prepare('SELECT * FROM local_sales WHERE operation_id = ?').get(opId) as Record<string, unknown> | undefined;
    if (existingLocal) {
      res.status(200).json({
        duplicate: true,
        sale: {
          id: String(existingLocal.id),
          operationId: opId,
          invoiceNumber: String(existingLocal.invoice_number),
          totalAmount: Number(existingLocal.total_amount),
        },
      });
      return;
    }

    // Resolve medicines, pack unit conversions, Rx compliance, and FEFO allocation
    const allocations: SaleLineAllocation[] = [];
    let requiresRx = false;
    const batchDeductions = new Map<string, number>();

    try {
      for (const rawItem of items as SaleItemInput[]) {
        const medRow = db.branchPos
          .prepare('SELECT * FROM local_medicines WHERE id = ? AND active = 1')
          .get(rawItem.medicineId) as Record<string, unknown> | undefined;
        if (!medRow) {
          throw new Error(`Medicine ${rawItem.medicineId} is unavailable in branch catalogue.`);
        }
        const med = mapMedicineRow(medRow);
        if (med.prescriptionOnly) requiresRx = true;

        const packUnit = (rawItem.packUnit || PackUnit.TABLET) as PackUnit;
        const baseUnits = convertToBaseUnits(Number(rawItem.quantity), packUnit, med.packHierarchy);

        const branchBatches = (
          db.branchPos
            .prepare('SELECT * FROM local_batches WHERE medicine_id = ? AND branch_id = ?')
            .all(med.id, branchId) as Array<Record<string, unknown>>
        ).map((r) => {
          const mapped = mapBatchRow(r);
          // Account for units already reserved earlier in the same cart
          const alreadyTaken = batchDeductions.get(mapped.id) ?? 0;
          return { ...mapped, quantity: Math.max(0, mapped.quantity - alreadyTaken) };
        });

        const fefo = fefoStrategy.allocate(branchBatches, baseUnits);
        for (const alloc of fefo.allocations) {
          batchDeductions.set(alloc.batch.id, (batchDeductions.get(alloc.batch.id) ?? 0) + alloc.unitsAllocated);
          const unitPrice = rawItem.unitPriceOverride ?? alloc.batch.sellingPrice ?? med.sellingPrice;
          allocations.push({
            medicineId: med.id,
            medicineName: `${med.brandName} ${med.strength}`,
            batchId: alloc.batch.id,
            batchNumber: alloc.batch.batchNumber,
            expiryDate: alloc.batch.expiryDate,
            packUnit,
            packQuantity: Number(rawItem.quantity),
            baseUnits: alloc.unitsAllocated,
            unitPrice,
            lineTotal: Number((alloc.unitsAllocated * unitPrice).toFixed(2)),
            prescriptionOnly: med.prescriptionOnly,
          });
        }
      }
    } catch (err) {
      sendProblem(res, 422, 'Dispensing Blocked', err instanceof Error ? err.message : 'Unable to allocate FEFO batch.', undefined, req.traceId);
      return;
    }

    // Strict QA4 Prescription Enforcement
    const rxValidation = validatePrescriptionRequirement(requiresRx, prescription as PrescriptionInput | null);
    if (!rxValidation.valid) {
      sendProblem(
        res,
        422,
        'Prescription Required',
        'Prescription-only medicine requires prescriber registration number, patient name, and prescription date.',
        rxValidation.errors,
        req.traceId
      );
      return;
    }

    const totals = calculateCartTotals(allocations, Number(discountPercent));
    const saleId = `sale-${crypto.randomUUID().slice(0, 10)}`;
    const branchCodeRow = db.headOffice.prepare('SELECT code, name, online FROM branches WHERE id = ?').get(branchId) as
      | { code: string; name: string; online: number }
      | undefined;
    const prefix = branchCodeRow?.code?.replace('BR-', 'B') ?? 'BR';
    const invoiceNumber = `INV-${prefix}-${Date.now().toString().slice(-6)}`;
    const nowIso = new Date().toISOString();
    const isBranchOnline = Boolean(branchCodeRow?.online) && !offlineMode;

    const checkoutMs = Number((performance.now() - start).toFixed(2));
    totalCheckouts++;
    checkoutLatenciesMs.push(checkoutMs);
    if (checkoutLatenciesMs.length > 500) checkoutLatenciesMs.shift();

    const saleRecord: SaleRecord = {
      id: saleId,
      operationId: opId,
      invoiceNumber,
      branchId,
      branchName: branchCodeRow?.name ?? branchId,
      cashierId: req.user!.id,
      cashierName: req.user!.fullName,
      items: allocations,
      subtotal: totals.subtotal,
      discountPercent: Number(discountPercent),
      discountAmount: totals.discountAmount,
      taxAmount: totals.taxAmount,
      totalAmount: totals.totalAmount,
      paymentMethod,
      prescription: requiresRx ? (prescription as PrescriptionInput) : null,
      status: 'COMPLETED',
      createdOffline: !isBranchOnline,
      synced: false,
      checkoutDurationMs: checkoutMs,
      createdAt: nowIso,
    };

    // ATOMIC UNIT OF WORK: Deduct Branch Local Stock + Persist Sale + Enqueue Transactional Outbox
    db.runBranchTx(() => {
      for (const [batId, qtyTaken] of batchDeductions.entries()) {
        db.branchPos
          .prepare('UPDATE local_batches SET quantity = MAX(0, quantity - ?), updated_at = ? WHERE id = ?')
          .run(qtyTaken, nowIso, batId);
      }

      db.branchPos
        .prepare(`
          INSERT INTO local_sales (
            id, operation_id, invoice_number, branch_id, cashier_id, cashier_name,
            items_json, subtotal, discount_percent, discount_amount, tax_amount, total_amount,
            payment_method, prescription_json, status, created_offline, synced, checkout_duration_ms, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, 0, ?, ?)
        `)
        .run(
          saleRecord.id,
          saleRecord.operationId,
          saleRecord.invoiceNumber,
          saleRecord.branchId,
          saleRecord.cashierId,
          saleRecord.cashierName,
          JSON.stringify(saleRecord.items),
          saleRecord.subtotal,
          saleRecord.discountPercent,
          saleRecord.discountAmount,
          saleRecord.taxAmount,
          saleRecord.totalAmount,
          saleRecord.paymentMethod,
          saleRecord.prescription ? JSON.stringify(saleRecord.prescription) : null,
          saleRecord.createdOffline ? 1 : 0,
          checkoutMs,
          nowIso
        );
    });

    enqueueBranchOperation(db, branchId, SyncOpType.SALE, opId, saleRecord as unknown as Record<string, unknown>);

    if (isBranchOnline) {
      synchronizeBranch(db, branchId);
      saleRecord.synced = true;
    }

    domainEvents.publish({
      type: 'SALE_COMPLETED',
      payload: { saleId, branchId, totalAmount: saleRecord.totalAmount },
    });

    res.status(201).json({
      sale: saleRecord,
      checkoutDurationMs: Number((performance.now() - start).toFixed(2)),
    });
  });

  router.post('/pos/returns', requirePermission('pos:return'), (req: AuthenticatedRequest, res) => {
    const { saleId, reason, offlineMode = false } = req.body ?? {};
    if (!saleId || !reason?.trim()) {
      sendProblem(res, 400, 'Validation Failed', 'Sale ID and return reason are required.', undefined, req.traceId);
      return;
    }

    const saleRow = db.branchPos.prepare('SELECT * FROM local_sales WHERE id = ?').get(saleId) as Record<string, unknown> | undefined;
    if (!saleRow) {
      sendProblem(res, 404, 'Sale Not Found', `Sale ${saleId} not found in branch database.`, undefined, req.traceId);
      return;
    }
    if (String(saleRow.status) === 'RETURNED') {
      sendProblem(res, 409, 'Already Returned', 'This invoice has already been refunded.', undefined, req.traceId);
      return;
    }

    const items = JSON.parse(String(saleRow.items_json)) as SaleLineAllocation[];
    const branchId = String(saleRow.branch_id);
    const totalUnits = items.reduce((s, i) => s + i.baseUnits, 0);
    const firstBatchId = items[0]?.batchId;
    const returnId = `ret-${crypto.randomUUID().slice(0, 8)}`;
    const opId = `op-ret-${crypto.randomUUID().slice(0, 8)}`;
    const nowIso = new Date().toISOString();

    db.runBranchTx(() => {
      db.branchPos.prepare(`UPDATE local_sales SET status = 'RETURNED' WHERE id = ?`).run(saleId);
      for (const item of items) {
        // Only restock if batch is neither expired nor recalled
        const b = db.branchPos.prepare('SELECT * FROM local_batches WHERE id = ?').get(item.batchId) as Record<string, unknown> | undefined;
        if (b) {
          const st = evaluateBatchStatus(mapBatchRow(b));
          if (st !== BatchStatus.EXPIRED && st !== BatchStatus.RECALLED) {
            db.branchPos
              .prepare('UPDATE local_batches SET quantity = quantity + ?, updated_at = ? WHERE id = ?')
              .run(item.baseUnits, nowIso, item.batchId);
          }
        }
      }
    });

    enqueueBranchOperation(db, branchId, SyncOpType.RETURN, opId, {
      id: returnId,
      saleId,
      invoiceNumber: String(saleRow.invoice_number),
      reason: reason.trim(),
      refundAmount: Number(saleRow.total_amount),
      restockedUnits: totalUnits,
      restockBatchId: firstBatchId,
      processedBy: req.user!.fullName,
      createdAt: nowIso,
    });

    const branchRow = db.headOffice.prepare('SELECT online FROM branches WHERE id = ?').get(branchId) as { online: number } | undefined;
    if (branchRow?.online && !offlineMode) {
      synchronizeBranch(db, branchId);
    }

    res.status(201).json({
      id: returnId,
      saleId,
      invoiceNumber: String(saleRow.invoice_number),
      refundAmount: Number(saleRow.total_amount),
      restockedUnits: totalUnits,
    });
  });

  // =========================================================================
  // MODULE 8: BRANCH TRANSFERS (DISPATCHED -> IN_TRANSIT -> RECEIVED)
  // =========================================================================
  router.get('/transfers', (_req, res) => {
    const branchMap = new Map(
      (db.headOffice.prepare('SELECT id, name FROM branches').all() as Array<{ id: string; name: string }>).map((b) => [
        b.id,
        b.name,
      ])
    );
    const medMap = new Map(
      (db.headOffice.prepare('SELECT id, brand_name, strength FROM medicines').all() as Array<{ id: string; brand_name: string; strength: string }>).map(
        (m) => [m.id, `${m.brand_name} ${m.strength}`]
      )
    );
    const rows = db.headOffice.prepare('SELECT * FROM transfers ORDER BY dispatch_date DESC').all() as Array<Record<string, unknown>>;
    const items = rows.map((r) => ({
      id: String(r.id),
      transferNumber: String(r.transfer_number),
      sourceBranchId: String(r.source_branch_id),
      sourceBranchName: branchMap.get(String(r.source_branch_id)) ?? String(r.source_branch_id),
      destinationBranchId: String(r.destination_branch_id),
      destinationBranchName: branchMap.get(String(r.destination_branch_id)) ?? String(r.destination_branch_id),
      medicineId: String(r.medicine_id),
      medicineName: medMap.get(String(r.medicine_id)) ?? String(r.medicine_id),
      batchId: String(r.batch_id),
      batchNumber: String(r.batch_number),
      transferQuantity: Number(r.transfer_quantity),
      receivedQuantity: r.received_quantity !== null ? Number(r.received_quantity) : null,
      discrepancyQuantity: Number(r.discrepancy_quantity),
      status: String(r.status) as TransferStatus,
      dispatchDate: String(r.dispatch_date),
      inTransitDate: r.in_transit_date ? String(r.in_transit_date) : null,
      receivedDate: r.received_date ? String(r.received_date) : null,
      dispatchedBy: String(r.dispatched_by),
      receivedBy: r.received_by ? String(r.received_by) : null,
      notes: r.notes ? String(r.notes) : '',
    }));
    res.json({ items, total: items.length });
  });

  router.post('/transfers', requirePermission('transfers:manage'), (req: AuthenticatedRequest, res) => {
    const { sourceBranchId, destinationBranchId, batchId, transferQuantity, notes = '' } = req.body ?? {};
    const qty = Number(transferQuantity);
    if (!sourceBranchId || !destinationBranchId || sourceBranchId === destinationBranchId || !batchId || !(qty > 0)) {
      sendProblem(
        res,
        400,
        'Validation Failed',
        'Distinct source & destination branches, valid batch, and positive quantity are required.',
        undefined,
        req.traceId
      );
      return;
    }

    const batchRow = db.headOffice.prepare('SELECT * FROM batches WHERE id = ? AND branch_id = ?').get(batchId, sourceBranchId) as
      | Record<string, unknown>
      | undefined;
    if (!batchRow) {
      sendProblem(res, 404, 'Batch Not Found', 'Selected batch does not exist at the source branch.', undefined, req.traceId);
      return;
    }
    const batch = mapBatchRow(batchRow);
    if (batch.status === BatchStatus.EXPIRED || batch.status === BatchStatus.RECALLED) {
      sendProblem(res, 422, 'Transfer Blocked', `Cannot transfer ${batch.status.toLowerCase()} batch ${batch.batchNumber}.`, undefined, req.traceId);
      return;
    }
    if (batch.quantity < qty) {
      sendProblem(res, 422, 'Insufficient Stock', `Only ${batch.quantity} units available in batch ${batch.batchNumber}.`, undefined, req.traceId);
      return;
    }

    const id = `trf-${crypto.randomUUID().slice(0, 8)}`;
    const transferNumber = `TRF-2026-${Date.now().toString().slice(-4)}`;
    const nowIso = new Date().toISOString();

    db.runHeadOfficeTx(() => {
      db.headOffice.prepare('UPDATE batches SET quantity = quantity - ?, updated_at = ? WHERE id = ?').run(qty, nowIso, batch.id);
      db.headOffice
        .prepare(`
          INSERT INTO transfers (
            id, transfer_number, source_branch_id, destination_branch_id, medicine_id,
            batch_id, batch_number, transfer_quantity, status, dispatch_date, dispatched_by, notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DISPATCHED', ?, ?, ?)
        `)
        .run(id, transferNumber, sourceBranchId, destinationBranchId, batch.medicineId, batch.id, batch.batchNumber, qty, nowIso, req.user!.fullName, notes);
    });

    // Reflect deduction in source branch local DB if online
    db.branchPos.prepare('UPDATE local_batches SET quantity = MAX(0, quantity - ?), updated_at = ? WHERE id = ?').run(qty, nowIso, batch.id);

    writeAuditLog(db.headOffice, {
      traceId: req.traceId ?? 'trf-create',
      actorId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.role,
      action: 'TRANSFER_DISPATCHED',
      resource: `transfer:${transferNumber}`,
      details: `Dispatched ${qty} units of ${batch.batchNumber} from ${sourceBranchId} to ${destinationBranchId}`,
    });

    res.status(201).json({ id, transferNumber, status: TransferStatus.DISPATCHED });
  });

  router.post('/transfers/:id/transition', requirePermission('transfers:manage'), (req: AuthenticatedRequest, res) => {
    const trfId = req.params.id;
    const { nextStatus, receivedQuantity, notes } = req.body ?? {};
    const row = db.headOffice.prepare('SELECT * FROM transfers WHERE id = ?').get(trfId) as Record<string, unknown> | undefined;
    if (!row) {
      sendProblem(res, 404, 'Not Found', 'Transfer not found.', undefined, req.traceId);
      return;
    }

    const currentStatus = String(row.status) as TransferStatus;
    try {
      assertTransferTransition(currentStatus, nextStatus as TransferStatus);
    } catch (err) {
      sendProblem(res, 422, 'Invalid Transition', err instanceof Error ? err.message : 'Invalid state transition.', undefined, req.traceId);
      return;
    }

    const nowIso = new Date().toISOString();

    if (nextStatus === TransferStatus.IN_TRANSIT) {
      db.headOffice
        .prepare(`UPDATE transfers SET status = 'IN_TRANSIT', in_transit_date = ? WHERE id = ?`)
        .run(nowIso, trfId);
      domainEvents.publish({ type: 'TRANSFER_UPDATED', payload: { transferId: trfId, status: TransferStatus.IN_TRANSIT } });
      res.json({ id: trfId, status: TransferStatus.IN_TRANSIT });
      return;
    }

    // Receiving step: compute discrepancy & credit destination branch batch
    const dispatchedQty = Number(row.transfer_quantity);
    const rcvQty = receivedQuantity !== undefined ? Number(receivedQuantity) : dispatchedQty;
    let discrepancy = 0;
    try {
      discrepancy = computeTransferDiscrepancy(dispatchedQty, rcvQty);
    } catch (err) {
      sendProblem(res, 400, 'Validation Failed', err instanceof Error ? err.message : 'Invalid received quantity.', undefined, req.traceId);
      return;
    }

    const srcBatch = db.headOffice.prepare('SELECT * FROM batches WHERE id = ?').get(String(row.batch_id)) as Record<string, unknown> | undefined;
    const destBranchId = String(row.destination_branch_id);
    const destBatchId = `bat-trf-${trfId.slice(-6)}`;

    db.runHeadOfficeTx(() => {
      db.headOffice
        .prepare(`
          UPDATE transfers
          SET status = 'RECEIVED', received_quantity = ?, discrepancy_quantity = ?,
              received_date = ?, received_by = ?, notes = COALESCE(?, notes)
          WHERE id = ?
        `)
        .run(rcvQty, discrepancy, nowIso, req.user!.fullName, notes ?? null, trfId);

      // Add stock to destination branch under same batch number
      const existingDest = db.headOffice
        .prepare('SELECT id FROM batches WHERE batch_number = ? AND branch_id = ? AND medicine_id = ?')
        .get(String(row.batch_number), destBranchId, String(row.medicine_id)) as { id: string } | undefined;

      if (existingDest) {
        db.headOffice
          .prepare('UPDATE batches SET quantity = quantity + ?, updated_at = ? WHERE id = ?')
          .run(rcvQty, nowIso, existingDest.id);
      } else if (srcBatch) {
        db.headOffice
          .prepare(`
            INSERT INTO batches (
              id, batch_number, medicine_id, branch_id, manufacturing_date, expiry_date,
              quantity, purchase_price, selling_price, status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            destBatchId,
            String(srcBatch.batch_number),
            String(srcBatch.medicine_id),
            destBranchId,
            String(srcBatch.manufacturing_date),
            String(srcBatch.expiry_date),
            rcvQty,
            Number(srcBatch.purchase_price),
            Number(srcBatch.selling_price),
            evaluateBatchStatus({
              expiryDate: String(srcBatch.expiry_date),
              quantity: rcvQty,
              status: BatchStatus.ACTIVE,
              recalledAt: null,
            }),
            nowIso
          );
      }
    });

    // Pull updated batch to destination branch if online
    const destBranch = db.headOffice.prepare('SELECT online FROM branches WHERE id = ?').get(destBranchId) as { online: number } | undefined;
    if (destBranch?.online) {
      synchronizeBranch(db, destBranchId);
    }

    domainEvents.publish({ type: 'TRANSFER_UPDATED', payload: { transferId: trfId, status: TransferStatus.RECEIVED } });
    res.json({ id: trfId, status: TransferStatus.RECEIVED, receivedQuantity: rcvQty, discrepancyQuantity: discrepancy });
  });

  // =========================================================================
  // MODULE 9: RECALL MANAGEMENT
  // =========================================================================
  router.get('/recalls', (_req, res) => {
    const recalls = db.headOffice.prepare('SELECT * FROM recalls ORDER BY recalled_at DESC').all() as Array<Record<string, unknown>>;
    const medMap = new Map(
      (db.headOffice.prepare('SELECT id, brand_name, strength FROM medicines').all() as Array<{ id: string; brand_name: string; strength: string }>).map(
        (m) => [m.id, `${m.brand_name} ${m.strength}`]
      )
    );
    const retailBranches = db.headOffice
      .prepare('SELECT id, name FROM branches WHERE is_head_office = 0')
      .all() as Array<{ id: string; name: string }>;
    const allSales = db.headOffice.prepare('SELECT branch_id, items_json, created_at FROM sales').all() as Array<{
      branch_id: string;
      items_json: string;
      created_at: string;
    }>;

    const items = recalls.map((rec) => {
      const batchNumber = String(rec.batch_number);
      const recalledAtMs = new Date(String(rec.recalled_at)).getTime();
      const hoBatches = db.headOffice
        .prepare('SELECT branch_id, quantity FROM batches WHERE batch_number = ?')
        .all(batchNumber) as Array<{ branch_id: string; quantity: number }>;
      const localRecalled = db.branchPos
        .prepare(`SELECT branch_id, recalled_at FROM local_batches WHERE batch_number = ?`)
        .all(batchNumber) as Array<{ branch_id: string; recalled_at: string | null }>;

      const localSyncedMap = new Map(localRecalled.map((l) => [l.branch_id, Boolean(l.recalled_at)]));
      const stockMap = new Map(hoBatches.map((h) => [h.branch_id, h.quantity]));

      let totalAffectedUnits = 0;
      let unitsSoldAfterRecall = 0;
      const pendingBranches: string[] = [];

      const branchBreakdown = retailBranches.map((br) => {
        const remainingStock = stockMap.get(br.id) ?? 0;
        let soldAfter = 0;
        for (const s of allSales) {
          if (s.branch_id === br.id && new Date(s.created_at).getTime() >= recalledAtMs) {
            const saleItems = JSON.parse(s.items_json) as SaleLineAllocation[];
            for (const si of saleItems) {
              if (si.batchNumber === batchNumber) soldAfter += si.baseUnits;
            }
          }
        }
        const synced = localSyncedMap.get(br.id) ?? true;
        if (!synced && remainingStock > 0) pendingBranches.push(br.name);
        totalAffectedUnits += remainingStock;
        unitsSoldAfterRecall += soldAfter;

        return {
          branchId: br.id,
          branchName: br.name,
          remainingStock,
          soldAfterRecall: soldAfter,
          synced,
        };
      });

      return {
        id: String(rec.id),
        batchNumber,
        medicineId: String(rec.medicine_id),
        medicineName: medMap.get(String(rec.medicine_id)) ?? String(rec.medicine_id),
        reason: String(rec.reason),
        recalledAt: String(rec.recalled_at),
        issuedBy: String(rec.issued_by),
        totalAffectedUnits,
        unitsSoldAfterRecall,
        pendingBranches,
        branchBreakdown,
      };
    });

    res.json({ items, total: items.length });
  });

  router.post('/recalls', requirePermission('recalls:write'), (req: AuthenticatedRequest, res) => {
    const { batchNumber, medicineId, reason, recalledAt } = req.body ?? {};
    if (!batchNumber?.trim() || !medicineId || !reason?.trim()) {
      sendProblem(res, 400, 'Validation Failed', 'Batch number, medicine, and recall reason are required.', undefined, req.traceId);
      return;
    }

    const recallTimestamp = recalledAt && !Number.isNaN(Date.parse(recalledAt)) ? new Date(recalledAt).toISOString() : new Date().toISOString();
    const id = `rec-${crypto.randomUUID().slice(0, 8)}`;

    db.runHeadOfficeTx(() => {
      db.headOffice
        .prepare(`INSERT INTO recalls (id, batch_number, medicine_id, reason, recalled_at, issued_by) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, batchNumber.trim(), medicineId, reason.trim(), recallTimestamp, req.user!.fullName);

      db.headOffice
        .prepare(`
          UPDATE batches
          SET status = 'RECALLED', recalled_at = ?, recall_reason = ?, updated_at = ?
          WHERE batch_number = ? AND medicine_id = ?
        `)
        .run(recallTimestamp, reason.trim(), new Date().toISOString(), batchNumber.trim(), medicineId);
    });

    // Notify all ONLINE branches immediately via sync; offline branches get it on next sync
    const onlineBranches = db.headOffice
      .prepare('SELECT id FROM branches WHERE is_head_office = 0 AND online = 1')
      .all() as Array<{ id: string }>;
    for (const br of onlineBranches) {
      synchronizeBranch(db, br.id);
    }

    domainEvents.publish({
      type: 'BATCH_RECALLED',
      payload: { batchNumber: batchNumber.trim(), medicineId, recalledAt: recallTimestamp },
    });

    writeAuditLog(db.headOffice, {
      traceId: req.traceId ?? 'recall',
      actorId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.role,
      action: 'BATCH_RECALLED',
      resource: `batch:${batchNumber.trim()}`,
      details: `Issued central recall: ${reason.trim()} (notified ${onlineBranches.length} online branches)`,
    });

    res.status(201).json({ id, batchNumber: batchNumber.trim(), recalledAt: recallTimestamp, notifiedOnlineBranches: onlineBranches.length });
  });

  // =========================================================================
  // MODULE 10: PRESCRIPTION REGISTER
  // =========================================================================
  router.get('/prescriptions', (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const branchId = typeof req.query.branchId === 'string' && req.query.branchId !== 'ALL' ? req.query.branchId : null;
    const branchMap = new Map(
      (db.headOffice.prepare('SELECT id, name FROM branches').all() as Array<{ id: string; name: string }>).map((b) => [
        b.id,
        b.name,
      ])
    );

    const rows = (
      branchId
        ? db.headOffice.prepare('SELECT * FROM prescriptions WHERE branch_id = ? ORDER BY created_at DESC').all(branchId)
        : db.headOffice.prepare('SELECT * FROM prescriptions ORDER BY created_at DESC').all()
    ) as Array<Record<string, unknown>>;

    let items = rows.map((r) => ({
      id: String(r.id),
      saleId: String(r.sale_id),
      invoiceNumber: String(r.invoice_number),
      branchId: String(r.branch_id),
      branchName: branchMap.get(String(r.branch_id)) ?? String(r.branch_id),
      prescriberRegNo: String(r.prescriber_reg_no),
      patientName: String(r.patient_name),
      prescriptionDate: String(r.prescription_date),
      notes: r.notes ? String(r.notes) : '',
      medicineIds: JSON.parse(String(r.medicine_ids_json)),
      medicineSummary: String(r.medicine_summary),
      dispensedBy: String(r.dispensed_by),
      createdAt: String(r.created_at),
    }));

    if (search) {
      items = items.filter((p) =>
        `${p.patientName} ${p.prescriberRegNo} ${p.invoiceNumber} ${p.medicineSummary}`.toLowerCase().includes(search)
      );
    }

    res.json({ items, total: items.length });
  });

  // =========================================================================
  // MODULE 11: REORDER MANAGEMENT
  // =========================================================================
  router.get('/reordering', (req, res) => {
    const branchFilter = typeof req.query.branchId === 'string' && req.query.branchId !== 'ALL' ? req.query.branchId : null;
    const retailBranches = db.headOffice
      .prepare('SELECT id, name FROM branches WHERE is_head_office = 0')
      .all() as Array<{ id: string; name: string }>;
    const medicines = (db.headOffice.prepare('SELECT * FROM medicines WHERE active = 1').all() as Array<Record<string, unknown>>).map(
      mapMedicineRow
    );
    const batches = (db.headOffice.prepare('SELECT * FROM batches').all() as Array<Record<string, unknown>>).map(mapBatchRow);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
    const recentSales = db.headOffice
      .prepare(`SELECT branch_id, items_json FROM sales WHERE created_at >= ? AND status != 'RETURNED'`)
      .all(thirtyDaysAgo) as Array<{ branch_id: string; items_json: string }>;
    const incomingTransfers = db.headOffice
      .prepare(`SELECT destination_branch_id, medicine_id, transfer_quantity FROM transfers WHERE status IN ('DISPATCHED', 'IN_TRANSIT')`)
      .all() as Array<{ destination_branch_id: string; medicine_id: string; transfer_quantity: number }>;

    const soldMap = new Map<string, number>();
    for (const s of recentSales) {
      const items = JSON.parse(s.items_json) as SaleLineAllocation[];
      for (const item of items) {
        const key = `${s.branch_id}:${item.medicineId}`;
        soldMap.set(key, (soldMap.get(key) ?? 0) + item.baseUnits);
      }
    }

    const incomingMap = new Map<string, number>();
    for (const t of incomingTransfers) {
      const key = `${t.destination_branch_id}:${t.medicine_id}`;
      incomingMap.set(key, (incomingMap.get(key) ?? 0) + t.transfer_quantity);
    }

    const stockMap = new Map<string, number>();
    for (const b of batches) {
      if (b.status === BatchStatus.ACTIVE || b.status === BatchStatus.EXPIRING_SOON) {
        const key = `${b.branchId}:${b.medicineId}`;
        stockMap.set(key, (stockMap.get(key) ?? 0) + b.quantity);
      }
    }

    const suggestions = [];
    for (const br of retailBranches) {
      if (branchFilter && br.id !== branchFilter) continue;
      for (const med of medicines) {
        const key = `${br.id}:${med.id}`;
        const last30DaysSold = soldMap.get(key) ?? 0;
        const currentStock = stockMap.get(key) ?? 0;
        const pendingIncomingTransfers = incomingMap.get(key) ?? 0;

        const calc = calculateReorderSuggestion({
          last30DaysSold,
          leadTimeDays: med.leadTimeDays,
          safetyStock: med.safetyStock,
          currentStock,
          pendingIncomingTransfers,
        });

        suggestions.push({
          branchId: br.id,
          branchName: br.name,
          medicineId: med.id,
          medicineName: `${med.brandName} ${med.strength}`,
          genericName: med.genericName,
          category: med.category,
          dailySalesVelocity: calc.dailySalesVelocity,
          last30DaysSold,
          leadTimeDays: med.leadTimeDays,
          safetyStock: med.safetyStock,
          currentStock,
          pendingIncomingTransfers,
          suggestedOrderQty: calc.suggestedOrderQty,
          estimatedCost: Number((calc.suggestedOrderQty * med.purchasePrice).toFixed(2)),
          urgency: calc.urgency,
        });
      }
    }

    suggestions.sort((a, b) => b.suggestedOrderQty - a.suggestedOrderQty);
    res.json({ items: suggestions, total: suggestions.length });
  });

  // =========================================================================
  // STOCK COUNTS & RECONCILIATION TASKS
  // =========================================================================
  router.get('/stock-counts', (_req, res) => {
    const branchMap = new Map(
      (db.headOffice.prepare('SELECT id, name FROM branches').all() as Array<{ id: string; name: string }>).map((b) => [
        b.id,
        b.name,
      ])
    );
    const medMap = new Map(
      (db.headOffice.prepare('SELECT id, brand_name, strength FROM medicines').all() as Array<{ id: string; brand_name: string; strength: string }>).map(
        (m) => [m.id, `${m.brand_name} ${m.strength}`]
      )
    );
    const rows = db.headOffice.prepare('SELECT * FROM stock_count_tasks ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
    const items = rows.map((r) => ({
      id: String(r.id),
      branchId: String(r.branch_id),
      branchName: branchMap.get(String(r.branch_id)) ?? String(r.branch_id),
      medicineId: String(r.medicine_id),
      medicineName: medMap.get(String(r.medicine_id)) ?? String(r.medicine_id),
      batchId: String(r.batch_id),
      batchNumber: String(r.batch_number),
      expectedQty: Number(r.expected_qty),
      countedQty: r.counted_qty !== null ? Number(r.counted_qty) : null,
      variance: r.variance !== null ? Number(r.variance) : null,
      reason: String(r.reason),
      status: String(r.status),
      createdAt: String(r.created_at),
      completedAt: r.completed_at ? String(r.completed_at) : null,
    }));
    res.json({ items, total: items.length });
  });

  router.post('/stock-counts/:id/complete', requirePermission('inventory:write'), (req: AuthenticatedRequest, res) => {
    const taskId = req.params.id;
    const countedQty = Number(req.body?.countedQty);
    if (!Number.isFinite(countedQty) || countedQty < 0) {
      sendProblem(res, 400, 'Validation Failed', 'Counted quantity must be zero or positive.', undefined, req.traceId);
      return;
    }

    const task = db.headOffice.prepare('SELECT * FROM stock_count_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
    if (!task) {
      sendProblem(res, 404, 'Not Found', 'Stock count task not found.', undefined, req.traceId);
      return;
    }

    const variance = countedQty - Number(task.expected_qty);
    const nowIso = new Date().toISOString();

    db.runHeadOfficeTx(() => {
      db.headOffice
        .prepare(`UPDATE stock_count_tasks SET counted_qty = ?, variance = ?, status = 'COMPLETED', completed_at = ? WHERE id = ?`)
        .run(countedQty, variance, nowIso, taskId);
      db.headOffice
        .prepare('UPDATE batches SET quantity = ?, updated_at = ? WHERE id = ?')
        .run(countedQty, nowIso, String(task.batch_id));
    });

    db.branchPos
      .prepare('UPDATE local_batches SET quantity = ?, updated_at = ? WHERE id = ?')
      .run(countedQty, nowIso, String(task.batch_id));

    writeAuditLog(db.headOffice, {
      traceId: req.traceId ?? 'stock-count',
      actorId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.role,
      action: 'STOCK_COUNT_COMPLETED',
      resource: `batch:${task.batch_number}`,
      details: `Reconciled batch to ${countedQty} units (variance ${variance >= 0 ? '+' : ''}${variance})`,
    });

    res.json({ id: taskId, countedQty, variance, status: 'COMPLETED' });
  });

  // =========================================================================
  // MODULE 12: REPORTS & ANALYTICS (11 REAL DB REPORTS, PAGINATED & SORTABLE)
  // =========================================================================
  router.get('/reports/:reportType', (req, res) => {
    const reportType = req.params.reportType;
    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const branchId = typeof req.query.branchId === 'string' && req.query.branchId !== 'ALL' ? req.query.branchId : null;
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize || 15)));
    const sortBy = typeof req.query.sortBy === 'string' ? req.query.sortBy : '';
    const sortDir = req.query.sortDir === 'asc' ? 1 : -1;

    const branchMap = new Map(
      (db.headOffice.prepare('SELECT id, name FROM branches').all() as Array<{ id: string; name: string }>).map((b) => [
        b.id,
        b.name,
      ])
    );
    const medMap = new Map(
      (db.headOffice.prepare('SELECT * FROM medicines').all() as Array<Record<string, unknown>>).map((m) => [
        String(m.id),
        mapMedicineRow(m),
      ])
    );

    let rows: Array<Record<string, unknown>> = [];

    const allSales = (
      branchId
        ? db.headOffice.prepare('SELECT * FROM sales WHERE branch_id = ? ORDER BY created_at DESC').all(branchId)
        : db.headOffice.prepare('SELECT * FROM sales ORDER BY created_at DESC').all()
    ) as Array<Record<string, unknown>>;

    if (reportType === 'daily-sales') {
      const grouped = new Map<string, { date: string; invoices: number; units: number; grossSales: number; discounts: number; netRevenue: number }>();
      for (const s of allSales) {
        if (String(s.status) === 'RETURNED') continue;
        const dt = String(s.created_at).slice(0, 10);
        const items = JSON.parse(String(s.items_json)) as SaleLineAllocation[];
        const units = items.reduce((sum, i) => sum + i.baseUnits, 0);
        const cur = grouped.get(dt) ?? { date: dt, invoices: 0, units: 0, grossSales: 0, discounts: 0, netRevenue: 0 };
        cur.invoices += 1;
        cur.units += units;
        cur.grossSales = Number((cur.grossSales + Number(s.subtotal)).toFixed(2));
        cur.discounts = Number((cur.discounts + Number(s.discount_amount)).toFixed(2));
        cur.netRevenue = Number((cur.netRevenue + Number(s.total_amount)).toFixed(2));
        grouped.set(dt, cur);
      }
      rows = Array.from(grouped.values());
    } else if (reportType === 'monthly-sales') {
      const grouped = new Map<string, { month: string; invoices: number; offlineSales: number; netRevenue: number; taxCollected: number }>();
      for (const s of allSales) {
        if (String(s.status) === 'RETURNED') continue;
        const mo = String(s.created_at).slice(0, 7);
        const cur = grouped.get(mo) ?? { month: mo, invoices: 0, offlineSales: 0, netRevenue: 0, taxCollected: 0 };
        cur.invoices += 1;
        cur.offlineSales += Boolean(s.created_offline) ? 1 : 0;
        cur.netRevenue = Number((cur.netRevenue + Number(s.total_amount)).toFixed(2));
        cur.taxCollected = Number((cur.taxCollected + Number(s.tax_amount)).toFixed(2));
        grouped.set(mo, cur);
      }
      rows = Array.from(grouped.values());
    } else if (reportType === 'branch-sales') {
      const grouped = new Map<string, { branch: string; invoices: number; avgTicket: number; offlineCount: number; netRevenue: number }>();
      for (const s of allSales) {
        if (String(s.status) === 'RETURNED') continue;
        const bName = branchMap.get(String(s.branch_id)) ?? String(s.branch_id);
        const cur = grouped.get(bName) ?? { branch: bName, invoices: 0, avgTicket: 0, offlineCount: 0, netRevenue: 0 };
        cur.invoices += 1;
        cur.offlineCount += Boolean(s.created_offline) ? 1 : 0;
        cur.netRevenue = Number((cur.netRevenue + Number(s.total_amount)).toFixed(2));
        cur.avgTicket = Number((cur.netRevenue / cur.invoices).toFixed(2));
        grouped.set(bName, cur);
      }
      rows = Array.from(grouped.values());
    } else if (reportType === 'product-sales') {
      const grouped = new Map<string, { product: string; category: string; unitsSold: number; revenue: number; rxOnly: string }>();
      for (const s of allSales) {
        if (String(s.status) === 'RETURNED') continue;
        const items = JSON.parse(String(s.items_json)) as SaleLineAllocation[];
        for (const item of items) {
          const med = medMap.get(item.medicineId);
          const key = item.medicineName;
          const cur = grouped.get(key) ?? {
            product: key,
            category: med?.category ?? 'General',
            unitsSold: 0,
            revenue: 0,
            rxOnly: item.prescriptionOnly ? 'Rx Only' : 'OTC',
          };
          cur.unitsSold += item.baseUnits;
          cur.revenue = Number((cur.revenue + item.lineTotal).toFixed(2));
          grouped.set(key, cur);
        }
      }
      rows = Array.from(grouped.values());
    } else if (reportType === 'batch-inventory' || reportType === 'expiry') {
      const batchRows = (
        branchId
          ? db.headOffice.prepare('SELECT * FROM batches WHERE branch_id = ? ORDER BY expiry_date ASC').all(branchId)
          : db.headOffice.prepare('SELECT * FROM batches ORDER BY expiry_date ASC').all()
      ) as Array<Record<string, unknown>>;
      rows = batchRows
        .map(mapBatchRow)
        .filter((b) => (reportType === 'expiry' ? b.status === BatchStatus.EXPIRING_SOON || b.status === BatchStatus.EXPIRED : true))
        .map((b) => {
          const med = medMap.get(b.medicineId);
          return {
            batchNumber: b.batchNumber,
            medicine: med ? `${med.brandName} ${med.strength}` : b.medicineId,
            branch: branchMap.get(b.branchId) ?? b.branchId,
            expiryDate: b.expiryDate,
            quantity: b.quantity,
            valuation: Number((b.quantity * b.purchasePrice).toFixed(2)),
            status: b.status,
          };
        });
    } else if (reportType === 'recall') {
      const recRows = db.headOffice.prepare('SELECT * FROM recalls ORDER BY recalled_at DESC').all() as Array<Record<string, unknown>>;
      rows = recRows.map((r) => {
        const med = medMap.get(String(r.medicine_id));
        const stockSum = (
          db.headOffice.prepare('SELECT COALESCE(SUM(quantity), 0) as s FROM batches WHERE batch_number = ?').get(String(r.batch_number)) as {
            s: number;
          }
        ).s;
        return {
          batchNumber: String(r.batch_number),
          medicine: med ? `${med.brandName} ${med.strength}` : String(r.medicine_id),
          reason: String(r.reason),
          recalledAt: String(r.recalled_at).slice(0, 16).replace('T', ' '),
          affectedStock: stockSum,
          issuedBy: String(r.issued_by),
        };
      });
    } else if (reportType === 'prescriptions') {
      const rxRows = (
        branchId
          ? db.headOffice.prepare('SELECT * FROM prescriptions WHERE branch_id = ? ORDER BY created_at DESC').all(branchId)
          : db.headOffice.prepare('SELECT * FROM prescriptions ORDER BY created_at DESC').all()
      ) as Array<Record<string, unknown>>;
      rows = rxRows.map((r) => ({
        invoiceNumber: String(r.invoice_number),
        patientName: String(r.patient_name),
        prescriberRegNo: String(r.prescriber_reg_no),
        prescriptionDate: String(r.prescription_date),
        medicines: String(r.medicine_summary),
        branch: branchMap.get(String(r.branch_id)) ?? String(r.branch_id),
        dispensedBy: String(r.dispensed_by),
      }));
    } else if (reportType === 'stock-valuation') {
      const batchRows = (
        branchId
          ? db.headOffice.prepare('SELECT * FROM batches WHERE branch_id = ?').all(branchId)
          : db.headOffice.prepare('SELECT * FROM batches').all()
      ) as Array<Record<string, unknown>>;
      const byMed = new Map<string, { medicine: string; category: string; units: number; costValue: number; retailValue: number; margin: number }>();
      for (const br of batchRows.map(mapBatchRow)) {
        if (br.status === BatchStatus.EXPIRED || br.status === BatchStatus.RECALLED) continue;
        const med = medMap.get(br.medicineId);
        const name = med ? `${med.brandName} ${med.strength}` : br.medicineId;
        const cur = byMed.get(name) ?? { medicine: name, category: med?.category ?? 'General', units: 0, costValue: 0, retailValue: 0, margin: 0 };
        cur.units += br.quantity;
        cur.costValue = Number((cur.costValue + br.quantity * br.purchasePrice).toFixed(2));
        cur.retailValue = Number((cur.retailValue + br.quantity * br.sellingPrice).toFixed(2));
        cur.margin = Number((cur.retailValue - cur.costValue).toFixed(2));
        byMed.set(name, cur);
      }
      rows = Array.from(byMed.values());
    } else if (reportType === 'transfers') {
      const trfRows = db.headOffice.prepare('SELECT * FROM transfers ORDER BY dispatch_date DESC').all() as Array<Record<string, unknown>>;
      rows = trfRows.map((t) => ({
        transferNumber: String(t.transfer_number),
        source: branchMap.get(String(t.source_branch_id)) ?? String(t.source_branch_id),
        destination: branchMap.get(String(t.destination_branch_id)) ?? String(t.destination_branch_id),
        batchNumber: String(t.batch_number),
        dispatched: Number(t.transfer_quantity),
        received: t.received_quantity !== null ? Number(t.received_quantity) : '-',
        discrepancy: Number(t.discrepancy_quantity),
        status: String(t.status),
      }));
    } else if (reportType === 'sync') {
      const ackRows = db.headOffice.prepare('SELECT * FROM sync_acks ORDER BY acknowledged_at DESC LIMIT 100').all() as Array<Record<string, unknown>>;
      rows = ackRows.map((a) => ({
        operationId: String(a.operation_id),
        branch: branchMap.get(String(a.branch_id)) ?? String(a.branch_id),
        sequenceNo: Number(a.sequence_no),
        type: String(a.op_type),
        acknowledgedAt: String(a.acknowledged_at).slice(0, 19).replace('T', ' '),
      }));
    }

    // Apply search filter
    if (search) {
      rows = rows.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(search)));
    }

    // Apply sort
    if (sortBy && rows.length > 0 && sortBy in rows[0]) {
      rows.sort((a, b) => {
        const av = a[sortBy];
        const bv = b[sortBy];
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir;
        return String(av).localeCompare(String(bv)) * sortDir;
      });
    }

    const total = rows.length;
    const startIdx = (page - 1) * pageSize;
    const paginated = rows.slice(startIdx, startIdx + pageSize);

    res.json({
      reportType,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: paginated,
    });
  });

  // =========================================================================
  // BRANCHES MANAGEMENT
  // =========================================================================
  router.get('/branches', (_req, res) => {
    const rows = db.headOffice.prepare('SELECT * FROM branches ORDER BY is_head_office DESC, code ASC').all() as Array<Record<string, unknown>>;
    const pendingRows = db.branchPos
      .prepare(`SELECT branch_id, COUNT(*) as c FROM sync_outbox WHERE status IN ('PENDING', 'FAILED') GROUP BY branch_id`)
      .all() as Array<{ branch_id: string; c: number }>;
    const pendingMap = new Map(pendingRows.map((p) => [p.branch_id, p.c]));
    const items = rows.map((r) => mapBranchRow(r, pendingMap.get(String(r.id)) ?? 0));
    res.json({ items, total: items.length });
  });

  router.post('/branches', requirePermission('branches:manage'), (req: AuthenticatedRequest, res) => {
    const { code, name, city, address, phone } = req.body ?? {};
    if (!code?.trim() || !name?.trim() || !city?.trim()) {
      sendProblem(res, 400, 'Validation Failed', 'Branch code, name, and city are required.', undefined, req.traceId);
      return;
    }
    const id = `br-${crypto.randomUUID().slice(0, 8)}`;
    const deviceId = `POS-${code.trim().toUpperCase()}`;
    const nowIso = new Date().toISOString();

    try {
      db.headOffice
        .prepare(`
          INSERT INTO branches (id, code, name, city, address, phone, is_head_office, online, last_sync_at, device_id)
          VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
        `)
        .run(id, code.trim().toUpperCase(), name.trim(), city.trim(), (address || '').trim(), (phone || '').trim(), nowIso, deviceId);

      db.branchPos
        .prepare(`INSERT OR IGNORE INTO branch_sync_state (branch_id, last_pulled_version, last_sync_at, next_sequence_no) VALUES (?, 0, ?, 1)`)
        .run(id, nowIso);

      synchronizeBranch(db, id);
      res.status(201).json({ id, code: code.trim().toUpperCase(), name: name.trim(), deviceId });
    } catch (err) {
      sendProblem(res, 409, 'Conflict', err instanceof Error ? err.message : 'Branch code already exists.', undefined, req.traceId);
    }
  });

  router.patch('/branches/:id/connectivity', requirePermission('sync:manage'), (req: AuthenticatedRequest, res) => {
    const branchId = req.params.id;
    const online = Boolean(req.body?.online);
    const result = db.headOffice.prepare('UPDATE branches SET online = ? WHERE id = ?').run(online ? 1 : 0, branchId);
    if (result.changes === 0) {
      sendProblem(res, 404, 'Not Found', 'Branch not found.', undefined, req.traceId);
      return;
    }
    res.json({ branchId, online });
  });

  // =========================================================================
  // USERS & ROLES (RBAC)
  // =========================================================================
  router.get('/users', requirePermission('users:manage'), (_req, res) => {
    const rows = db.headOffice
      .prepare(`
        SELECT u.id, u.username, u.full_name, u.email, u.role, u.branch_id, u.active, u.created_at, b.name as branch_name
        FROM users u JOIN branches b ON b.id = u.branch_id
        ORDER BY u.created_at ASC
      `)
      .all() as Array<Record<string, unknown>>;

    const items = rows.map((r) => ({
      id: String(r.id),
      username: String(r.username),
      fullName: String(r.full_name),
      email: String(r.email),
      role: String(r.role) as UserRole,
      branchId: String(r.branch_id),
      branchName: String(r.branch_name),
      active: Boolean(r.active),
      permissions: ROLE_PERMISSIONS[String(r.role) as UserRole] ?? [],
      createdAt: String(r.created_at),
    }));

    res.json({ items, total: items.length, roleMatrix: ROLE_PERMISSIONS });
  });

  router.post('/users', requirePermission('users:manage'), (req: AuthenticatedRequest, res) => {
    const { username, fullName, email, password, role, branchId } = req.body ?? {};
    if (!username?.trim() || !fullName?.trim() || !email?.includes('@') || typeof password !== 'string' || password.length < 6) {
      sendProblem(res, 400, 'Validation Failed', 'Valid username, full name, email, and 6+ char password are required.', undefined, req.traceId);
      return;
    }
    if (!Object.values(UserRole).includes(role)) {
      sendProblem(res, 400, 'Validation Failed', 'Invalid RBAC role specified.', undefined, req.traceId);
      return;
    }
    // Branch managers cannot escalate privileges to Super Admin or Head Office Admin
    if (
      req.user!.role === UserRole.BRANCH_MANAGER &&
      (role === UserRole.SUPER_ADMIN || role === UserRole.HEAD_OFFICE_ADMIN)
    ) {
      sendProblem(res, 403, 'Forbidden', 'Branch Managers cannot create Head Office or Super Admin accounts.', undefined, req.traceId);
      return;
    }

    const id = `usr-${crypto.randomUUID().slice(0, 8)}`;
    try {
      db.headOffice
        .prepare(`
          INSERT INTO users (id, username, full_name, email, password_hash, role, branch_id, active, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        `)
        .run(id, username.trim().toLowerCase(), fullName.trim(), email.trim().toLowerCase(), hashPassword(password), role, branchId || 'br-downtown', new Date().toISOString());

      writeAuditLog(db.headOffice, {
        traceId: req.traceId ?? 'user-create',
        actorId: req.user!.id,
        actorName: req.user!.fullName,
        actorRole: req.user!.role,
        action: 'USER_CREATED',
        resource: `user:${username.trim().toLowerCase()}`,
        details: `Created ${role} account assigned to ${branchId || 'br-downtown'}`,
      });

      res.status(201).json({ id, username: username.trim().toLowerCase(), role });
    } catch (err) {
      sendProblem(res, 409, 'Conflict', err instanceof Error ? err.message : 'Username or email already exists.', undefined, req.traceId);
    }
  });

  router.patch('/users/:id', requirePermission('users:manage'), (req: AuthenticatedRequest, res) => {
    const userId = req.params.id;
    const { active, role, branchId, newPassword } = req.body ?? {};
    const existing = db.headOffice.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown> | undefined;
    if (!existing) {
      sendProblem(res, 404, 'Not Found', 'User not found.', undefined, req.traceId);
      return;
    }

    db.headOffice
      .prepare('UPDATE users SET active = ?, role = ?, branch_id = ?, password_hash = ? WHERE id = ?')
      .run(
        active !== undefined ? (active ? 1 : 0) : Number(existing.active),
        String(role ?? existing.role),
        String(branchId ?? existing.branch_id),
        typeof newPassword === 'string' && newPassword.length >= 6 ? hashPassword(newPassword) : String(existing.password_hash),
        userId
      );

    res.json({ id: userId, updated: true });
  });

  // =========================================================================
  // MODULE 6 & 7: SYNCHRONIZATION ENGINE & CONFLICT RESOLUTION
  // =========================================================================
  router.get('/sync/status', (req, res) => {
    const branchId = typeof req.query.branchId === 'string' && req.query.branchId !== 'ALL' ? req.query.branchId : null;
    const branchMap = new Map(
      (db.headOffice.prepare('SELECT id, name FROM branches').all() as Array<{ id: string; name: string }>).map((b) => [
        b.id,
        b.name,
      ])
    );

    const outboxRows = (
      branchId
        ? db.branchPos.prepare('SELECT * FROM sync_outbox WHERE branch_id = ? ORDER BY created_at DESC LIMIT 80').all(branchId)
        : db.branchPos.prepare('SELECT * FROM sync_outbox ORDER BY created_at DESC LIMIT 80').all()
    ) as Array<Record<string, unknown>>;

    const conflictRows = (
      branchId
        ? db.headOffice.prepare('SELECT * FROM conflicts WHERE branch_id = ? ORDER BY created_at DESC LIMIT 60').all(branchId)
        : db.headOffice.prepare('SELECT * FROM conflicts ORDER BY created_at DESC LIMIT 60').all()
    ) as Array<Record<string, unknown>>;

    const ackCount = (db.headOffice.prepare('SELECT COUNT(*) as c FROM sync_acks').get() as { c: number }).c;

    res.json({
      outbox: outboxRows.map((o) => ({
        operationId: String(o.operation_id),
        sequenceNo: Number(o.sequence_no),
        branchId: String(o.branch_id),
        branchName: branchMap.get(String(o.branch_id)) ?? String(o.branch_id),
        type: String(o.op_type),
        status: String(o.status),
        retryCount: Number(o.retry_count),
        nextRetryAt: o.next_retry_at ? String(o.next_retry_at) : null,
        lastError: o.last_error ? String(o.last_error) : null,
        createdAt: String(o.created_at),
        syncedAt: o.synced_at ? String(o.synced_at) : null,
      })),
      conflicts: conflictRows.map((c) => ({
        id: String(c.id),
        operationId: String(c.operation_id),
        branchId: String(c.branch_id),
        branchName: branchMap.get(String(c.branch_id)) ?? String(c.branch_id),
        type: String(c.type),
        severity: String(c.severity),
        summary: String(c.summary),
        resolutionRule: String(c.resolution_rule),
        details: JSON.parse(String(c.details_json)),
        resolved: Boolean(c.resolved),
        createdAt: String(c.created_at),
      })),
      totalAcknowledged: ackCount,
    });
  });

  router.post('/sync/run', requirePermission('sync:manage'), (req: AuthenticatedRequest, res) => {
    const { branchId, batchSize = 200 } = req.body ?? {};
    const targetBranches = branchId && branchId !== 'ALL'
      ? [String(branchId)]
      : (db.headOffice.prepare('SELECT id FROM branches WHERE is_head_office = 0').all() as Array<{ id: string }>).map((b) => b.id);

    const summaries = targetBranches.map((bid) => synchronizeBranch(db, bid, Number(batchSize)));

    writeAuditLog(db.headOffice, {
      traceId: req.traceId ?? 'sync-run',
      actorId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.role,
      action: 'SYNC_EXECUTED',
      resource: `branch:${branchId || 'ALL'}`,
      details: `Synchronized ${summaries.length} branch(es); acked ${summaries.reduce((s, x) => s + x.acknowledgedOperations, 0)} ops`,
    });

    res.json({ summaries });
  });

  router.post('/sync/conflicts/:id/resolve', requirePermission('sync:manage'), (req: AuthenticatedRequest, res) => {
    const id = req.params.id;
    db.headOffice.prepare('UPDATE conflicts SET resolved = 1 WHERE id = ?').run(id);
    res.json({ id, resolved: true });
  });

  router.get('/audit-logs', (_req, res) => {
    const rows = db.headOffice.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 80').all() as Array<Record<string, unknown>>;
    res.json({
      items: rows.map((r) => ({
        id: String(r.id),
        traceId: String(r.trace_id),
        actorId: String(r.actor_id),
        actorName: String(r.actor_name),
        actorRole: String(r.actor_role),
        action: String(r.action),
        resource: String(r.resource),
        details: String(r.details),
        createdAt: String(r.created_at),
      })),
    });
  });

  return router;
}
