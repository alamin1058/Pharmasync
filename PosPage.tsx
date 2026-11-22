import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Barcode,
  CheckCircle2,
  FileText,
  Printer,
  RotateCcw,
  Search,
  ShoppingCart,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { apiRequest, ApiError } from '../lib/api';
import {
  cacheBranchCatalogue,
  getCachedCatalogue,
  queueOfflineOutboxSale,
} from '../lib/offlineStore';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import {
  Batch,
  BatchStatus,
  Medicine,
  PackUnit,
  PrescriptionInput,
  SaleLineAllocation,
  SaleRecord,
} from '../shared/types';
import {
  calculateCartTotals,
  convertToBaseUnits,
  evaluateBatchStatus,
  fefoStrategy,
  receiptPrinter,
  validatePrescriptionRequirement,
} from '../shared/domainEngine';
import {
  AlertBanner,
  EmptyState,
  Modal,
  PageHeader,
  StatusText,
  btnDangerClass,
  btnPrimaryClass,
  btnSecondaryClass,
  inputClass,
} from '../components/UiPrimitives';

interface CartItem {
  medicine: Medicine;
  quantity: number;
  packUnit: PackUnit;
}

export function PosPage() {
  const { user, activeBranchId } = useAuth();
  const { isOnline, refreshSyncCounters } = useSync();

  const [activeTab, setActiveTab] = useState<'terminal' | 'history'>('terminal');
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [salesHistory, setSalesHistory] = useState<SaleRecord[]>([]);

  const [barcodeInput, setBarcodeInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [discountPercent, setDiscountPercent] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<'CARD' | 'CASH' | 'INSURANCE' | 'MOBILE'>('CARD');

  // Prescription fields
  const [prescriberRegNo, setPrescriberRegNo] = useState('');
  const [patientName, setPatientName] = useState('');
  const [prescriptionDate, setPrescriptionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [rxNotes, setRxNotes] = useState('');

  // Status & Receipts
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [lastLookupMs, setLastLookupMs] = useState<number | null>(null);
  const [receiptSale, setReceiptSale] = useState<SaleRecord | null>(null);
  const [returnTarget, setReturnTarget] = useState<SaleRecord | null>(null);
  const [returnReason, setReturnReason] = useState('');

  const loadPosData = useCallback(async () => {
    try {
      const [medRes, batRes, salesRes] = await Promise.all([
        apiRequest<{ items: Medicine[] }>('/medicines'),
        apiRequest<{ items: Batch[] }>(`/batches?source=local&branchId=${encodeURIComponent(activeBranchId)}`),
        apiRequest<{ items: SaleRecord[] }>(`/pos/sales?branchId=${encodeURIComponent(activeBranchId)}`),
      ]);
      const activeMeds = medRes.items.filter((m) => m.active);
      setMedicines(activeMeds);
      setBatches(batRes.items);
      setSalesHistory(salesRes.items);
      await cacheBranchCatalogue(activeMeds, batRes.items);
    } catch {
      // Fallback transparently to browser IndexedDB cache when offline
      const cached = await getCachedCatalogue();
      setMedicines(cached.medicines);
      setBatches(cached.batches.filter((b) => b.branchId === activeBranchId));
    }
  }, [activeBranchId]);

  useEffect(() => {
    void loadPosData();
  }, [loadPosData]);

  // Compute live FEFO batch info per medicine
  const medicineStockMap = useMemo(() => {
    const map = new Map<
      string,
      { availableUnits: number; fefoBatch: Batch | null; hasRecalled: boolean; hasExpired: boolean }
    >();
    for (const m of medicines) {
      const medBatches = batches.filter((b) => b.medicineId === m.id);
      const eligible = medBatches
        .filter((b) => {
          const st = evaluateBatchStatus(b);
          return st !== BatchStatus.EXPIRED && st !== BatchStatus.RECALLED && b.quantity > 0;
        })
        .sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());

      map.set(m.id, {
        availableUnits: eligible.reduce((sum, b) => sum + b.quantity, 0),
        fefoBatch: eligible[0] ?? null,
        hasRecalled: medBatches.some((b) => evaluateBatchStatus(b) === BatchStatus.RECALLED && b.quantity > 0),
        hasExpired: medBatches.some((b) => evaluateBatchStatus(b) === BatchStatus.EXPIRED && b.quantity > 0),
      });
    }
    return map;
  }, [medicines, batches]);

  const filteredMedicines = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return medicines;
    return medicines.filter((m) =>
      `${m.brandName} ${m.genericName} ${m.barcode} ${m.strength} ${m.category}`.toLowerCase().includes(q)
    );
  }, [medicines, searchQuery]);

  const addToCart = useCallback(
    (med: Medicine) => {
      setError(null);
      const stock = medicineStockMap.get(med.id);
      if (!stock || stock.availableUnits <= 0) {
        if (stock?.hasRecalled) {
          setError(`Cannot dispense ${med.brandName}: active safety recall blocks this batch.`);
        } else if (stock?.hasExpired) {
          setError(`Cannot dispense ${med.brandName}: available stock is expired.`);
        } else {
          setError(`${med.brandName} is out of stock at this branch.`);
        }
        return;
      }

      setCart((prev) => {
        const idx = prev.findIndex((c) => c.medicine.id === med.id);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = { ...copy[idx], quantity: copy[idx].quantity + 1 };
          return copy;
        }
        return [...prev, { medicine: med, quantity: 1, packUnit: PackUnit.STRIP }];
      });
    },
    [medicineStockMap]
  );

  const handleBarcodeLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = barcodeInput.trim();
    if (!code) return;
    setError(null);
    const start = performance.now();

    // Sub-50ms local lookup first (works offline too!)
    const localMed = medicines.find((m) => m.barcode === code);
    if (localMed) {
      setLastLookupMs(Number((performance.now() - start).toFixed(2)));
      addToCart(localMed);
      setBarcodeInput('');
      return;
    }

    if (isOnline) {
      try {
        const res = await apiRequest<{ medicine: Medicine; lookupMs: number }>(
          `/pos/barcode/${encodeURIComponent(code)}?branchId=${encodeURIComponent(activeBranchId)}`
        );
        setLastLookupMs(res.lookupMs);
        addToCart(res.medicine);
        setBarcodeInput('');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : `Barcode ${code} not found.`);
      }
    } else {
      setError(`Barcode ${code} not found in local branch cache.`);
    }
  };

  // Real-time FEFO preview & cart pricing calculation
  const cartPreview = useMemo(() => {
    const lines: SaleLineAllocation[] = [];
    const warnings: string[] = [];
    let requiresRx = false;

    for (const item of cart) {
      if (item.medicine.prescriptionOnly) requiresRx = true;
      const baseUnits = convertToBaseUnits(item.quantity, item.packUnit, item.medicine.packHierarchy);
      const medBatches = batches.filter((b) => b.medicineId === item.medicine.id);
      try {
        const alloc = fefoStrategy.allocate(medBatches, baseUnits);
        for (const a of alloc.allocations) {
          const unitPrice = a.batch.sellingPrice || item.medicine.sellingPrice;
          lines.push({
            medicineId: item.medicine.id,
            medicineName: `${item.medicine.brandName} ${item.medicine.strength}`,
            batchId: a.batch.id,
            batchNumber: a.batch.batchNumber,
            expiryDate: a.batch.expiryDate,
            packUnit: item.packUnit,
            packQuantity: item.quantity,
            baseUnits: a.unitsAllocated,
            unitPrice,
            lineTotal: Number((a.unitsAllocated * unitPrice).toFixed(2)),
            prescriptionOnly: item.medicine.prescriptionOnly,
          });
        }
      } catch (err) {
        warnings.push(`${item.medicine.brandName}: ${err instanceof Error ? err.message : 'Allocation error'}`);
      }
    }

    const totals = calculateCartTotals(lines, discountPercent);
    return { lines, warnings, requiresRx, totals };
  }, [cart, batches, discountPercent]);

  const handleCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    if (cart.length === 0) {
      setError('Add at least one medicine to the cart before checkout.');
      return;
    }
    if (cartPreview.warnings.length > 0) {
      setError(cartPreview.warnings[0]);
      return;
    }

    const prescription: PrescriptionInput | null = cartPreview.requiresRx
      ? {
          prescriberRegNo: prescriberRegNo.trim(),
          patientName: patientName.trim(),
          prescriptionDate,
          notes: rxNotes.trim(),
        }
      : null;

    const rxCheck = validatePrescriptionRequirement(cartPreview.requiresRx, prescription);
    if (!rxCheck.valid) {
      const firstErr = Object.values(rxCheck.errors)[0];
      setError(firstErr || 'Prescription details are required for Rx-only medicines.');
      return;
    }

    const opId = `op-pos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
      branchId: activeBranchId,
      items: cart.map((c) => ({
        medicineId: c.medicine.id,
        quantity: c.quantity,
        packUnit: c.packUnit,
      })),
      discountPercent,
      paymentMethod,
      prescription,
      offlineMode: !isOnline,
      operationId: opId,
    };

    setSubmitting(true);
    const start = performance.now();

    try {
      const res = await apiRequest<{ sale: SaleRecord; checkoutDurationMs: number }>('/pos/sales', {
        method: 'POST',
        body: payload,
      });

      setReceiptSale(res.sale);
      setCart([]);
      setDiscountPercent(0);
      setPrescriberRegNo('');
      setPatientName('');
      setRxNotes('');
      setSuccessMsg(
        `Invoice ${res.sale.invoiceNumber} completed in ${res.checkoutDurationMs} ms (${
          res.sale.createdOffline ? 'Saved to Offline Outbox' : 'Synced with Head Office'
        }).`
      );
      await loadPosData();
      await refreshSyncCounters();
    } catch (err) {
      // If network is genuinely unreachable, commit offline directly to browser IndexedDB outbox!
      if (!(err instanceof ApiError)) {
        const offlineSale: SaleRecord = {
          id: `sale-idb-${Date.now()}`,
          operationId: opId,
          invoiceNumber: `INV-OFF-${Date.now().toString().slice(-6)}`,
          branchId: activeBranchId,
          cashierId: user?.id ?? 'local',
          cashierName: user?.fullName ?? 'Branch Cashier',
          items: cartPreview.lines,
          subtotal: cartPreview.totals.subtotal,
          discountPercent,
          discountAmount: cartPreview.totals.discountAmount,
          taxAmount: cartPreview.totals.taxAmount,
          totalAmount: cartPreview.totals.totalAmount,
          paymentMethod,
          prescription,
          status: 'COMPLETED',
          createdOffline: true,
          synced: false,
          checkoutDurationMs: Number((performance.now() - start).toFixed(2)),
          createdAt: new Date().toISOString(),
        };
        await queueOfflineOutboxSale({
          operationId: opId,
          branchId: activeBranchId,
          payload,
          localSalePreview: offlineSale,
          createdAt: offlineSale.createdAt,
          retryCount: 0,
        });
        setSalesHistory((prev) => [offlineSale, ...prev]);
        setReceiptSale(offlineSale);
        setCart([]);
        setSuccessMsg(`Network offline — Invoice ${offlineSale.invoiceNumber} saved to IndexedDB Outbox.`);
        await refreshSyncCounters();
      } else {
        setError(err.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleProcessReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnTarget || !returnReason.trim()) return;
    setError(null);
    try {
      await apiRequest('/pos/returns', {
        method: 'POST',
        body: {
          saleId: returnTarget.id,
          reason: returnReason.trim(),
          offlineMode: !isOnline,
        },
      });
      setSuccessMsg(`Refund processed for invoice ${returnTarget.invoiceNumber} and eligible stock restored.`);
      setReturnTarget(null);
      setReturnReason('');
      await loadPosData();
      await refreshSyncCounters();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to process return.');
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Point of Sale Terminal"
        subtitle="Automatic FEFO batch dispensing, barcode lookup, pack conversion, prescription enforcement, and 72-hour offline continuity."
        actions={
          <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
            <button
              type="button"
              onClick={() => setActiveTab('terminal')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                activeTab === 'terminal'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Checkout Terminal
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('history')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                activeTab === 'history'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Sales & Returns ({salesHistory.length})
            </button>
          </div>
        }
      />

      {error && <AlertBanner tone="error" message={error} onDismiss={() => setError(null)} />}
      {successMsg && <AlertBanner tone="success" message={successMsg} onDismiss={() => setSuccessMsg(null)} />}

      {activeTab === 'terminal' ? (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
          {/* Left: Barcode Scanner + Catalogue Picker */}
          <div className="xl:col-span-7 space-y-4">
            {/* Barcode & Search Bar */}
            <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-3">
              <form onSubmit={handleBarcodeLookup} className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <Barcode className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={barcodeInput}
                    onChange={(e) => setBarcodeInput(e.target.value)}
                    placeholder="Scan or enter barcode (e.g. 8901101000028) and press Enter"
                    aria-label="Barcode scanner input"
                    className={`${inputClass} pl-9 font-mono`}
                  />
                </div>
                <button type="submit" className={btnSecondaryClass}>
                  Scan Add
                </button>
              </form>

              <div className="flex items-center justify-between gap-3">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search brand, generic name, strength, or category..."
                    aria-label="Search medicines for POS"
                    className={`${inputClass} pl-9`}
                  />
                </div>
                {lastLookupMs !== null && (
                  <span className="text-xs font-mono tabular-nums text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
                    Lookup: {lastLookupMs} ms
                  </span>
                )}
              </div>
            </div>

            {/* Medicine Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredMedicines.map((med) => {
                const stock = medicineStockMap.get(med.id);
                const avail = stock?.availableUnits ?? 0;
                const fefo = stock?.fefoBatch;
                const fefoStatus = fefo ? evaluateBatchStatus(fefo) : null;
                const isBlocked = avail === 0;

                return (
                  <div
                    key={med.id}
                    className={`rounded-xl border p-4 bg-white dark:bg-slate-900 flex flex-col justify-between gap-3 transition-colors ${
                      isBlocked
                        ? 'border-slate-200 dark:border-slate-800 opacity-75'
                        : 'border-slate-200 dark:border-slate-800 hover:border-blue-400 dark:hover:border-blue-600'
                    }`}
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-bold text-slate-900 dark:text-white leading-snug">
                          {med.brandName} <span className="font-normal text-slate-500">{med.strength}</span>
                        </h3>
                        <span className="font-mono text-sm font-bold tabular-nums text-slate-900 dark:text-slate-100 shrink-0">
                          ${med.sellingPrice.toFixed(2)}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        {med.genericName} · {med.dosageForm} · {med.prescriptionOnly ? 'Rx Required' : 'OTC'}
                      </p>
                      <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-1">
                        Barcode {med.barcode} · Strip={med.packHierarchy.tabletsPerStrip}u · Box=
                        {med.packHierarchy.stripsPerBox * med.packHierarchy.tabletsPerStrip}u
                      </p>
                    </div>

                    <div className="flex items-center justify-between pt-2.5 border-t border-slate-100 dark:border-slate-800">
                      <div className="text-xs">
                        {fefo ? (
                          <div>
                            <span className="font-mono tabular-nums font-semibold text-slate-800 dark:text-slate-200">
                              {avail} u
                            </span>
                            <span className="text-slate-400 mx-1">·</span>
                            <span
                              className={
                                fefoStatus === BatchStatus.EXPIRING_SOON
                                  ? 'text-amber-700 dark:text-amber-400 font-medium font-mono'
                                  : 'text-slate-500 dark:text-slate-400 font-mono'
                              }
                            >
                              FEFO {fefo.batchNumber} ({fefo.expiryDate})
                            </span>
                          </div>
                        ) : stock?.hasRecalled ? (
                          <StatusText status="danger" label="Blocked · Recalled" />
                        ) : stock?.hasExpired ? (
                          <StatusText status="danger" label="Blocked · Expired" />
                        ) : (
                          <StatusText status="muted" label="Out of Stock" />
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => addToCart(med)}
                        aria-label={`Add ${med.brandName} to cart`}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                          isBlocked
                            ? 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                            : 'bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 text-white'
                        }`}
                      >
                        Add
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: Active Checkout Cart & Rx Compliance */}
          <form
            onSubmit={handleCheckout}
            className="xl:col-span-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 space-y-4 sticky top-20"
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <ShoppingCart className="w-4 h-4 text-blue-700 dark:text-blue-400" />
                <h2 className="text-sm font-bold text-slate-900 dark:text-white">Current Sale Cart</h2>
              </div>
              <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                {isOnline ? 'Online Sync' : 'Offline Outbox'}
              </span>
            </div>

            {cart.length === 0 ? (
              <EmptyState
                title="Cart is empty"
                description="Scan a medicine barcode or click Add on any product to automatically allocate FEFO batches."
              />
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-y-auto pr-1">
                {cart.map((item) => {
                  const baseUnits = convertToBaseUnits(item.quantity, item.packUnit, item.medicine.packHierarchy);
                  const allocatedLines = cartPreview.lines.filter((l) => l.medicineId === item.medicine.id);
                  const lineTotal = allocatedLines.reduce((s, l) => s + l.lineTotal, 0);

                  return (
                    <div key={item.medicine.id} className="py-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                            {item.medicine.brandName} {item.medicine.strength}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                            {baseUnits} base units · {item.medicine.prescriptionOnly ? 'Rx Required' : 'OTC'}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setCart((prev) => prev.filter((c) => c.medicine.id !== item.medicine.id))}
                          aria-label={`Remove ${item.medicine.brandName}`}
                          className="p-1 text-slate-400 hover:text-red-600 cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            min={1}
                            max={500}
                            aria-label={`Quantity for ${item.medicine.brandName}`}
                            value={item.quantity}
                            onChange={(e) => {
                              const val = Math.max(1, Number(e.target.value) || 1);
                              setCart((prev) =>
                                prev.map((c) => (c.medicine.id === item.medicine.id ? { ...c, quantity: val } : c))
                              );
                            }}
                            className="w-16 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs font-mono tabular-nums"
                          />
                          <select
                            aria-label={`Pack unit for ${item.medicine.brandName}`}
                            value={item.packUnit}
                            onChange={(e) => {
                              const unit = e.target.value as PackUnit;
                              setCart((prev) =>
                                prev.map((c) => (c.medicine.id === item.medicine.id ? { ...c, packUnit: unit } : c))
                              );
                            }}
                            className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs"
                          >
                            <option value={PackUnit.TABLET}>Unit/Tab (1x)</option>
                            <option value={PackUnit.STRIP}>
                              Strip ({item.medicine.packHierarchy.tabletsPerStrip}x)
                            </option>
                            <option value={PackUnit.BOX}>
                              Box ({item.medicine.packHierarchy.tabletsPerStrip * item.medicine.packHierarchy.stripsPerBox}x)
                            </option>
                          </select>
                        </div>

                        <span className="font-mono text-sm font-bold tabular-nums text-slate-900 dark:text-white">
                          ${lineTotal.toFixed(2)}
                        </span>
                      </div>

                      {allocatedLines.length > 0 && (
                        <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                          FEFO:{' '}
                          {allocatedLines
                            .map((al) => `${al.batchNumber} (${al.baseUnits}u · exp ${al.expiryDate})`)
                            .join(' + ')}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {cartPreview.warnings.length > 0 && (
              <AlertBanner tone="warning" message={cartPreview.warnings.join(' | ')} />
            )}

            {/* Prescription Verification Panel (Required for Rx-Only Items) */}
            {cartPreview.requiresRx && (
              <div className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-950/30 p-3.5 space-y-2.5">
                <div className="flex items-center gap-2 text-xs font-bold text-blue-800 dark:text-blue-300">
                  <FileText className="w-4 h-4" />
                  <span>Prescription Verification Required (Rx-Only Item in Cart)</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label htmlFor="rx-reg" className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Prescriber Reg. Number *
                    </label>
                    <input
                      id="rx-reg"
                      type="text"
                      value={prescriberRegNo}
                      onChange={(e) => setPrescriberRegNo(e.target.value)}
                      placeholder="e.g. MD-MA-44812"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="rx-date" className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Prescription Date *
                    </label>
                    <input
                      id="rx-date"
                      type="date"
                      value={prescriptionDate}
                      onChange={(e) => setPrescriptionDate(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="rx-patient" className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Patient Full Name *
                  </label>
                  <input
                    id="rx-patient"
                    type="text"
                    value={patientName}
                    onChange={(e) => setPatientName(e.target.value)}
                    placeholder="e.g. Margaret Chen"
                    className={inputClass}
                  />
                </div>
              </div>
            )}

            {/* Discount & Payment Method */}
            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
              <div>
                <label htmlFor="pos-discount" className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Discount (%)
                </label>
                <input
                  id="pos-discount"
                  type="number"
                  min={0}
                  max={50}
                  value={discountPercent}
                  onChange={(e) => setDiscountPercent(Math.min(50, Math.max(0, Number(e.target.value) || 0)))}
                  className={`${inputClass} font-mono tabular-nums`}
                />
              </div>
              <div>
                <label htmlFor="pos-payment" className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Payment Method
                </label>
                <select
                  id="pos-payment"
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value as typeof paymentMethod)}
                  className={inputClass}
                >
                  <option value="CARD">Card</option>
                  <option value="CASH">Cash</option>
                  <option value="INSURANCE">Insurance</option>
                  <option value="MOBILE">Mobile Pay</option>
                </select>
              </div>
            </div>

            {/* Totals Breakdown */}
            <div className="space-y-1.5 text-sm pt-2 border-t border-slate-200 dark:border-slate-800">
              <div className="flex justify-between text-slate-600 dark:text-slate-400">
                <span>Subtotal</span>
                <span className="font-mono tabular-nums">${cartPreview.totals.subtotal.toFixed(2)}</span>
              </div>
              {cartPreview.totals.discountAmount > 0 && (
                <div className="flex justify-between text-emerald-700 dark:text-emerald-400">
                  <span>Discount ({discountPercent}%)</span>
                  <span className="font-mono tabular-nums">-${cartPreview.totals.discountAmount.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between text-slate-600 dark:text-slate-400">
                <span>Tax (5%)</span>
                <span className="font-mono tabular-nums">${cartPreview.totals.taxAmount.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-base font-bold text-slate-900 dark:text-white pt-2 border-t border-slate-200 dark:border-slate-800">
                <span>Total Due</span>
                <span className="font-mono tabular-nums">${cartPreview.totals.totalAmount.toFixed(2)}</span>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting || cart.length === 0}
              className={`${btnPrimaryClass} w-full py-2.5`}
            >
              {isOnline ? <CheckCircle2 className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
              <span>
                {submitting
                  ? 'Processing FEFO Sale...'
                  : isOnline
                    ? 'Complete Sale & Print Receipt'
                    : 'Complete Offline Sale (Queue Sync)'}
              </span>
            </button>
          </form>
        </div>
      ) : (
        /* Sales History & Returns Table */
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-5">Invoice</th>
                  <th className="py-3 px-3">Date</th>
                  <th className="py-3 px-3">Items</th>
                  <th className="py-3 px-3">Payment</th>
                  <th className="py-3 px-3">Sync Status</th>
                  <th className="py-3 px-3 text-right">Total</th>
                  <th className="py-3 px-5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {salesHistory.map((sale) => (
                  <tr key={sale.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-3 px-5 font-mono text-xs font-semibold text-slate-900 dark:text-white">
                      {sale.invoiceNumber}
                    </td>
                    <td className="py-3 px-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                      {new Date(sale.createdAt).toLocaleString()}
                    </td>
                    <td className="py-3 px-3 text-xs text-slate-700 dark:text-slate-300">
                      {sale.items.map((i) => `${i.medicineName} (${i.baseUnits}u)`).join(', ')}
                    </td>
                    <td className="py-3 px-3 text-xs text-slate-600 dark:text-slate-400">{sale.paymentMethod}</td>
                    <td className="py-3 px-3">
                      {sale.status === 'RETURNED' ? (
                        <StatusText status="danger" label="Returned" />
                      ) : sale.synced ? (
                        <StatusText status="nominal" label="Synced" />
                      ) : (
                        <StatusText status="warning" label="Offline Queued" />
                      )}
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold">
                      ${sale.totalAmount.toFixed(2)}
                    </td>
                    <td className="py-3 px-5 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setReceiptSale(sale)}
                          className="text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
                        >
                          Receipt
                        </button>
                        {sale.status !== 'RETURNED' && (
                          <button
                            type="button"
                            onClick={() => setReturnTarget(sale)}
                            className="text-xs font-semibold text-red-600 dark:text-red-400 hover:underline cursor-pointer"
                          >
                            Return
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Mock Thermal Printer Receipt Modal */}
      <Modal
        open={Boolean(receiptSale)}
        title={`Thermal Receipt — ${receiptSale?.invoiceNumber ?? ''}`}
        onClose={() => setReceiptSale(null)}
        maxWidth="max-w-md"
      >
        {receiptSale && (
          <div className="space-y-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Adapter: {receiptPrinter.adapterName}
            </p>
            <pre className="p-4 rounded-lg bg-slate-950 text-slate-100 font-mono text-xs overflow-x-auto leading-relaxed">
              {receiptPrinter.formatReceipt(receiptSale, receiptSale.branchName || activeBranchId)}
            </pre>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => window.print()} className={btnSecondaryClass}>
                <Printer className="w-4 h-4" />
                <span>Print Copy</span>
              </button>
              <button type="button" onClick={() => setReceiptSale(null)} className={btnPrimaryClass}>
                Done
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Return Modal */}
      <Modal
        open={Boolean(returnTarget)}
        title={`Process Return — ${returnTarget?.invoiceNumber ?? ''}`}
        onClose={() => setReturnTarget(null)}
      >
        {returnTarget && (
          <form onSubmit={handleProcessReturn} className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Refund total <strong className="font-mono">${returnTarget.totalAmount.toFixed(2)}</strong> and restock non-expired, non-recalled units into local branch inventory.
            </p>
            <div>
              <label htmlFor="return-reason" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Return Reason *
              </label>
              <input
                id="return-reason"
                type="text"
                required
                value={returnReason}
                onChange={(e) => setReturnReason(e.target.value)}
                placeholder="e.g. Patient allergy / wrong pack size"
                className={inputClass}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setReturnTarget(null)} className={btnSecondaryClass}>
                Cancel
              </button>
              <button type="submit" className={btnDangerClass}>
                <RotateCcw className="w-4 h-4" />
                <span>Confirm Refund</span>
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
