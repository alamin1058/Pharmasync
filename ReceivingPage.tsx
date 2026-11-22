import React, { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, PackagePlus } from 'lucide-react';
import { apiRequest, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import { Branch, Medicine, StockCountTask } from '../shared/types';
import {
  AlertBanner,
  EmptyState,
  LoadingState,
  Modal,
  PageHeader,
  StatusText,
  btnPrimaryClass,
  btnSecondaryClass,
  inputClass,
} from '../components/UiPrimitives';

export function ReceivingPage() {
  const { activeBranchId } = useAuth();
  const { isOnline, refreshSyncCounters } = useSync();

  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [tasks, setTasks] = useState<StockCountTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Receive batch form
  const [branchId, setBranchId] = useState(activeBranchId);
  const [medicineId, setMedicineId] = useState('');
  const [batchNumber, setBatchNumber] = useState(() => `BN-${new Date().getFullYear()}${Math.floor(100 + Math.random() * 899)}`);
  const [manufacturingDate, setManufacturingDate] = useState(() => new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10));
  const [expiryDate, setExpiryDate] = useState(() => new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10));
  const [quantity, setQuantity] = useState('120');
  const [saving, setSaving] = useState(false);

  // Stock count modal
  const [countTarget, setCountTarget] = useState<StockCountTask | null>(null);
  const [countedQty, setCountedQty] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, bRes, tRes] = await Promise.all([
        apiRequest<{ items: Medicine[] }>('/medicines'),
        apiRequest<{ items: Branch[] }>('/branches'),
        apiRequest<{ items: StockCountTask[] }>('/stock-counts'),
      ]);
      const retail = bRes.items.filter((b) => !b.isHeadOffice);
      setMedicines(mRes.items.filter((m) => m.active));
      setBranches(retail);
      setTasks(tRes.items);
      if (!medicineId && mRes.items.length > 0) setMedicineId(mRes.items[0].id);
    } finally {
      setLoading(false);
    }
  }, [medicineId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleReceive = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      const res = await apiRequest<{ batchNumber: string; synced: boolean }>('/batches', {
        method: 'POST',
        body: {
          branchId,
          medicineId,
          batchNumber: batchNumber.trim(),
          manufacturingDate,
          expiryDate,
          quantity: Number(quantity),
          forceOffline: !isOnline,
        },
      });
      setSuccess(
        `Received batch ${res.batchNumber} (${quantity} base units) — ${
          res.synced ? 'Synced with Head Office' : 'Queued in Offline Outbox'
        }.`
      );
      setBatchNumber(`BN-${new Date().getFullYear()}${Math.floor(100 + Math.random() * 899)}`);
      await refreshSyncCounters();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to receive batch.');
    } finally {
      setSaving(false);
    }
  };

  const handleCompleteCount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!countTarget) return;
    setError(null);
    try {
      await apiRequest(`/stock-counts/${countTarget.id}/complete`, {
        method: 'POST',
        body: { countedQty: Number(countedQty) },
      });
      setSuccess(`Reconciled batch ${countTarget.batchNumber} to ${countedQty} units.`);
      setCountTarget(null);
      setCountedQty('');
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to complete stock count.');
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Purchases, Stock Receiving & Cycle Counts"
        subtitle="Log inbound supplier batches into branch inventory and reconcile physical stock-count tasks triggered by synchronization."
      />

      {error && <AlertBanner tone="error" message={error} onDismiss={() => setError(null)} />}
      {success && <AlertBanner tone="success" message={success} onDismiss={() => setSuccess(null)} />}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Receive Stock Form */}
        <section className="xl:col-span-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-200 dark:border-slate-800">
            <PackagePlus className="w-4 h-4 text-blue-700 dark:text-blue-400" />
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Receive Supplier Batch</h2>
          </div>

          <form onSubmit={handleReceive} className="mt-4 space-y-4">
            <div>
              <label htmlFor="rcv-branch" className="block text-xs font-medium mb-1">Receiving Branch</label>
              <select id="rcv-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} className={inputClass}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {b.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="rcv-med" className="block text-xs font-medium mb-1">Medicine</label>
              <select id="rcv-med" value={medicineId} onChange={(e) => setMedicineId(e.target.value)} className={inputClass}>
                {medicines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.brandName} {m.strength} ({m.genericName})
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="rcv-bn" className="block text-xs font-medium mb-1">Batch Number *</label>
                <input id="rcv-bn" required value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} className={`${inputClass} font-mono`} />
              </div>
              <div>
                <label htmlFor="rcv-qty" className="block text-xs font-medium mb-1">Quantity (Base Units) *</label>
                <input id="rcv-qty" type="number" min="1" required value={quantity} onChange={(e) => setQuantity(e.target.value)} className={`${inputClass} font-mono`} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="rcv-mfg" className="block text-xs font-medium mb-1">Manufacturing Date *</label>
                <input id="rcv-mfg" type="date" required value={manufacturingDate} onChange={(e) => setManufacturingDate(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label htmlFor="rcv-exp" className="block text-xs font-medium mb-1">Expiry Date *</label>
                <input id="rcv-exp" type="date" required value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} className={inputClass} />
              </div>
            </div>
            <button type="submit" disabled={saving} className={`${btnPrimaryClass} w-full py-2.5`}>
              {saving ? 'Recording Batch...' : isOnline ? 'Receive & Sync Batch' : 'Receive Locally (Offline Queue)'}
            </button>
          </form>
        </section>

        {/* Stock Count & Reconciliation Tasks */}
        <section className="xl:col-span-7 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ClipboardCheck className="w-4 h-4 text-blue-700 dark:text-blue-400" />
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Stock Count & Reconciliation Tasks</h2>
            </div>
            <span className="text-xs font-mono text-slate-500">
              {tasks.filter((t) => t.status === 'OPEN').length} open
            </span>
          </div>

          {loading ? (
            <LoadingState />
          ) : tasks.length === 0 ? (
            <div className="p-6">
              <EmptyState title="No stock count tasks" description="Tasks automatically appear here when transfer discrepancies or negative-stock sync conflicts occur." />
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {tasks.map((t) => (
                <div key={t.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                      <span>{t.medicineName}</span>
                      <span className="font-mono text-xs text-slate-500">· {t.batchNumber}</span>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{t.reason}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono">
                      {t.branchName} · Expected: {t.expectedQty}u
                      {t.countedQty !== null ? ` · Counted: ${t.countedQty}u (Var ${t.variance! >= 0 ? '+' : ''}${t.variance})` : ''}
                    </p>
                  </div>

                  <div className="shrink-0">
                    {t.status === 'OPEN' ? (
                      <button
                        type="button"
                        onClick={() => {
                          setCountTarget(t);
                          setCountedQty(String(Math.max(0, t.expectedQty)));
                        }}
                        className={btnSecondaryClass}
                      >
                        Record Count
                      </button>
                    ) : (
                      <StatusText status="nominal" label="Reconciled" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <Modal open={Boolean(countTarget)} title={`Physical Stock Count — ${countTarget?.batchNumber ?? ''}`} onClose={() => setCountTarget(null)}>
        {countTarget && (
          <form onSubmit={handleCompleteCount} className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Enter the verified physical unit count for <strong>{countTarget.medicineName}</strong> at {countTarget.branchName}. System expected quantity:{' '}
              <span className="font-mono font-bold">{countTarget.expectedQty}</span>.
            </p>
            <div>
              <label htmlFor="counted-qty" className="block text-xs font-medium mb-1">Verified Physical Count *</label>
              <input
                id="counted-qty"
                type="number"
                min="0"
                required
                value={countedQty}
                onChange={(e) => setCountedQty(e.target.value)}
                className={`${inputClass} font-mono`}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCountTarget(null)} className={btnSecondaryClass}>Cancel</button>
              <button type="submit" className={btnPrimaryClass}>Confirm Reconciliation</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
