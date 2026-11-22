import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, RefreshCw, Search, ShieldAlert, TrendingUp } from 'lucide-react';
import { apiRequest, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import { Batch, Branch, Medicine, PrescriptionRecord, RecallRecord, ReorderSuggestion } from '../shared/types';
import {
  AlertBanner,
  EmptyState,
  KpiStatCard,
  LoadingState,
  Modal,
  PageHeader,
  StatusText,
  btnDangerClass,
  btnPrimaryClass,
  btnSecondaryClass,
  inputClass,
} from '../components/UiPrimitives';

// ============================================================================
// MODULE 10: PRESCRIPTION REGISTER PAGE
// ============================================================================
export function PrescriptionsPage() {
  const [records, setRecords] = useState<Array<PrescriptionRecord & { branchName: string }>>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ items: Array<PrescriptionRecord & { branchName: string }> }>(
        `/prescriptions?search=${encodeURIComponent(search)}`
      );
      setRecords(res.items);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Prescription Register"
        subtitle="Audit-compliant register of all prescription-only dispensations linked to prescriber registration numbers and POS invoices."
      />

      <div className="relative max-w-md">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search patient, prescriber reg no, invoice, or medicine..."
          className={`${inputClass} pl-9`}
        />
      </div>

      {loading ? (
        <LoadingState />
      ) : records.length === 0 ? (
        <EmptyState title="No prescription records found" description="Dispensing any Rx-only medicine at POS creates an immutable prescription register entry." />
      ) : (
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-5">Invoice</th>
                  <th className="py-3 px-3">Patient Name</th>
                  <th className="py-3 px-3">Prescriber Reg. No</th>
                  <th className="py-3 px-3">Rx Date</th>
                  <th className="py-3 px-3">Dispensed Rx Medicines</th>
                  <th className="py-3 px-3">Branch</th>
                  <th className="py-3 px-5">Pharmacist</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {records.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-3 px-5 font-mono text-xs font-bold text-slate-900 dark:text-white">{r.invoiceNumber}</td>
                    <td className="py-3 px-3 font-medium text-slate-900 dark:text-slate-100">{r.patientName}</td>
                    <td className="py-3 px-3 font-mono text-xs text-blue-700 dark:text-blue-400 font-semibold">{r.prescriberRegNo}</td>
                    <td className="py-3 px-3 font-mono text-xs text-slate-600 dark:text-slate-300">{r.prescriptionDate}</td>
                    <td className="py-3 px-3 text-xs text-slate-700 dark:text-slate-300">{r.medicineSummary}</td>
                    <td className="py-3 px-3 text-xs text-slate-600 dark:text-slate-400">{r.branchName}</td>
                    <td className="py-3 px-5 text-xs text-slate-600 dark:text-slate-400">{r.dispensedBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// MODULE 9: RECALL MANAGEMENT PAGE
// ============================================================================
export function RecallsPage() {
  const { hasPermission } = useAuth();
  const { triggerSyncNow, isSyncing } = useSync();
  const canRecall = hasPermission('recalls:write');

  const [recalls, setRecalls] = useState<RecallRecord[]>([]);
  const [batches, setBatches] = useState<Array<Batch & { medicineName: string }>>([]);
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  const [selectedBatchKey, setSelectedBatchKey] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [recRes, batRes, medRes] = await Promise.all([
        apiRequest<{ items: RecallRecord[] }>('/recalls'),
        apiRequest<{ items: Array<Batch & { medicineName: string }> }>('/batches'),
        apiRequest<{ items: Medicine[] }>('/medicines'),
      ]);
      setRecalls(recRes.items);
      setBatches(batRes.items);
      setMedicines(medRes.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Unique active batch numbers for recall selector
  const recallableLots = Array.from(
    new Map(
      batches
        .filter((b) => b.status !== 'RECALLED')
        .map((b) => [`${b.batchNumber}::${b.medicineId}`, { batchNumber: b.batchNumber, medicineId: b.medicineId, medicineName: b.medicineName }])
    ).values()
  );

  const handleIssueRecall = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const [batchNumber, medicineId] = selectedBatchKey.split('::');
    if (!batchNumber || !medicineId || !reason.trim()) {
      setError('Select a batch lot and provide a safety recall reason.');
      return;
    }
    try {
      const res = await apiRequest<{ batchNumber: string; notifiedOnlineBranches: number }>('/recalls', {
        method: 'POST',
        body: { batchNumber, medicineId, reason: reason.trim() },
      });
      setSuccess(
        `Central recall issued for lot ${res.batchNumber}. Notified ${res.notifiedOnlineBranches} online branch(es); offline branches will block upon next sync.`
      );
      setModalOpen(false);
      setReason('');
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to issue recall.');
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Medicine Recall Management"
        subtitle="Issue central batch recalls, block recalled lots at branch POS terminals after sync, and track post-recall offline exposure."
        actions={
          <>
            <button
              type="button"
              disabled={isSyncing}
              onClick={() => void triggerSyncNow().then(loadData)}
              className={btnSecondaryClass}
            >
              <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>Push Recalls to Branches</span>
            </button>
            {canRecall && (
              <button
                type="button"
                onClick={() => {
                  if (recallableLots.length > 0) {
                    setSelectedBatchKey(`${recallableLots[0].batchNumber}::${recallableLots[0].medicineId}`);
                  }
                  setModalOpen(true);
                }}
                className={btnDangerClass}
              >
                <ShieldAlert className="w-4 h-4" />
                <span>Issue Batch Recall</span>
              </button>
            )}
          </>
        }
      />

      {error && <AlertBanner tone="error" message={error} onDismiss={() => setError(null)} />}
      {success && <AlertBanner tone="success" message={success} onDismiss={() => setSuccess(null)} />}

      {loading ? (
        <LoadingState />
      ) : recalls.length === 0 ? (
        <EmptyState title="No active recalls" description="All pharmacy batches are currently clear of regulatory or manufacturer recalls." />
      ) : (
        <div className="space-y-5">
          {recalls.map((rec) => (
            <section key={rec.id} className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
              <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-600" />
                    <h2 className="text-base font-bold text-slate-900 dark:text-white">
                      {rec.medicineName} · Lot <span className="font-mono">{rec.batchNumber}</span>
                    </h2>
                  </div>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{rec.reason}</p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono">
                    Recalled {new Date(rec.recalledAt).toLocaleString()} · Issued by {rec.issuedBy}
                  </p>
                </div>

                <div className="grid grid-cols-3 gap-4 shrink-0 text-right">
                  <div>
                    <p className="text-[11px] text-slate-500">Affected Stock</p>
                    <p className="text-lg font-mono font-bold tabular-nums text-slate-900 dark:text-white">
                      {rec.totalAffectedUnits} u
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Sold Post-Recall</p>
                    <p className={`text-lg font-mono font-bold tabular-nums ${rec.unitsSoldAfterRecall > 0 ? 'text-red-600' : 'text-emerald-700 dark:text-emerald-400'}`}>
                      {rec.unitsSoldAfterRecall} u
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Pending Sync</p>
                    <p className={`text-lg font-mono font-bold tabular-nums ${rec.pendingBranches.length > 0 ? 'text-amber-600' : 'text-emerald-700 dark:text-emerald-400'}`}>
                      {rec.pendingBranches.length}
                    </p>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                      <th className="py-2.5 px-5">Branch</th>
                      <th className="py-2.5 px-3 text-right">Quarantined Stock</th>
                      <th className="py-2.5 px-3 text-right">Units Sold After Recall</th>
                      <th className="py-2.5 px-5">Branch POS Sync Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                    {rec.branchBreakdown.map((b) => (
                      <tr key={b.branchId}>
                        <td className="py-2.5 px-5 font-medium text-slate-900 dark:text-slate-100">{b.branchName}</td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums">{b.remainingStock} u</td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums">{b.soldAfterRecall} u</td>
                        <td className="py-2.5 px-5">
                          <StatusText
                            status={b.synced ? 'nominal' : 'warning'}
                            label={b.synced ? 'Blocked at Branch POS' : 'Pending Branch Synchronization'}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      <Modal open={modalOpen} title="Issue Central Safety Recall" onClose={() => setModalOpen(false)}>
        <form onSubmit={handleIssueRecall} className="space-y-4">
          <p className="text-xs text-slate-600 dark:text-slate-400">
            All online branches will immediately block POS dispensing for the recalled lot. Offline branches will enforce the block upon next sync and flag any offline sales made after the recall timestamp.
          </p>
          <div>
            <label htmlFor="recall-lot" className="block text-xs font-medium mb-1">Select Batch Lot ({medicines.length} SKUs monitored)</label>
            <select
              id="recall-lot"
              required
              value={selectedBatchKey}
              onChange={(e) => setSelectedBatchKey(e.target.value)}
              className={inputClass}
            >
              {recallableLots.map((l) => (
                <option key={`${l.batchNumber}::${l.medicineId}`} value={`${l.batchNumber}::${l.medicineId}`}>
                  {l.batchNumber} — {l.medicineName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="recall-reason" className="block text-xs font-medium mb-1">Recall Reason & Regulatory Reference *</label>
            <textarea
              id="recall-reason"
              rows={3}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Manufacturer Class I recall due to potency degradation"
              className={inputClass}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setModalOpen(false)} className={btnSecondaryClass}>Cancel</button>
            <button type="submit" className={btnDangerClass}>Confirm Central Recall</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// ============================================================================
// MODULE 11: REORDER MANAGEMENT PAGE
// ============================================================================
export function ReorderingPage() {
  const navigate = useNavigate();
  const [suggestions, setSuggestions] = useState<ReorderSuggestion[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchFilter, setBranchFilter] = useState('ALL');
  const [onlyNeeded, setOnlyNeeded] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      apiRequest<{ items: ReorderSuggestion[] }>(`/reordering?branchId=${encodeURIComponent(branchFilter)}`),
      apiRequest<{ items: Branch[] }>('/branches'),
    ])
      .then(([r, b]) => {
        setSuggestions(r.items);
        setBranches(b.items.filter((x) => !x.isHeadOffice));
      })
      .finally(() => setLoading(false));
  }, [branchFilter]);

  const visible = onlyNeeded ? suggestions.filter((s) => s.suggestedOrderQty > 0) : suggestions;
  const totalEstimatedSpend = visible.reduce((sum, s) => sum + s.estimatedCost, 0);
  const criticalCount = suggestions.filter((s) => s.urgency === 'CRITICAL').length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Stock Reorder Suggestions"
        subtitle="Calculated dynamically from 30-day branch sales velocity, supplier lead time, safety stock, current stock, and pending incoming transfers."
        actions={
          <button type="button" onClick={() => navigate('/receiving')} className={btnPrimaryClass}>
            <TrendingUp className="w-4 h-4" />
            <span>Receive Purchase Stock</span>
          </button>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiStatCard label="SKUs Requiring Reorder" value={suggestions.filter((s) => s.suggestedOrderQty > 0).length} tone="warning" />
        <KpiStatCard label="Critical Low Stock" value={criticalCount} tone={criticalCount > 0 ? 'danger' : 'success'} />
        <KpiStatCard label="Estimated Replenishment Cost" value={`$${totalEstimatedSpend.toFixed(2)}`} tone="primary" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <select
          aria-label="Filter reorder plan by branch"
          value={branchFilter}
          onChange={(e) => setBranchFilter(e.target.value)}
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium"
        >
          <option value="ALL">All Retail Branches</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>

        <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
          <input type="checkbox" checked={onlyNeeded} onChange={(e) => setOnlyNeeded(e.target.checked)} className="rounded" />
          <span>Show only items with suggested order &gt; 0</span>
        </label>
      </div>

      {loading ? (
        <LoadingState />
      ) : visible.length === 0 ? (
        <EmptyState title="All stock levels healthy" description="No branches currently need replenishment under the active filter." />
      ) : (
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-5">Product & Branch</th>
                  <th className="py-3 px-3 text-right">30d Velocity</th>
                  <th className="py-3 px-3 text-right">Lead Time</th>
                  <th className="py-3 px-3 text-right">Safety Stock</th>
                  <th className="py-3 px-3 text-right">On Hand / In-Transit</th>
                  <th className="py-3 px-3 text-right">Suggested Order</th>
                  <th className="py-3 px-3 text-right">Est. Cost</th>
                  <th className="py-3 px-5">Priority</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {visible.map((s) => (
                  <tr key={`${s.branchId}-${s.medicineId}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-3 px-5">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">{s.medicineName}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">{s.branchName} · {s.category}</div>
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums text-xs">
                      {s.dailySalesVelocity}/day
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums text-xs">{s.leadTimeDays}d</td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums text-xs">{s.safetyStock}</td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums text-xs">
                      {s.currentStock} / +{s.pendingIncomingTransfers}
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums font-bold text-blue-700 dark:text-blue-400">
                      {s.suggestedOrderQty} u
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums">${s.estimatedCost.toFixed(2)}</td>
                    <td className="py-3 px-5">
                      <StatusText
                        status={s.urgency === 'CRITICAL' ? 'danger' : s.urgency === 'LOW' ? 'warning' : 'nominal'}
                        label={s.urgency}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
