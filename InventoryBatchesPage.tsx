import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PackagePlus, Search } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Batch, BatchStatus, Branch, Medicine } from '../shared/types';
import { formatPackBreakdown } from '../shared/domainEngine';
import {
  KpiStatCard,
  LoadingState,
  PageHeader,
  StatusText,
  btnPrimaryClass,
  inputClass,
} from '../components/UiPrimitives';

interface EnrichedBatch extends Batch {
  medicineName: string;
  genericName: string;
  barcode: string;
  category: string;
  prescriptionOnly: boolean;
  branchName: string;
  daysToExpiry: number;
}

export function InventoryPage() {
  const { workspaceMode, activeBranchId } = useAuth();
  const navigate = useNavigate();

  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [batches, setBatches] = useState<EnrichedBatch[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchFilter, setBranchFilter] = useState(workspaceMode === 'branch' ? activeBranchId : 'ALL');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      apiRequest<{ items: Medicine[] }>('/medicines'),
      apiRequest<{ items: EnrichedBatch[] }>(`/batches?branchId=${encodeURIComponent(branchFilter)}`),
      apiRequest<{ items: Branch[] }>('/branches'),
    ])
      .then(([m, b, br]) => {
        setMedicines(m.items);
        setBatches(b.items);
        setBranches(br.items.filter((x) => !x.isHeadOffice));
      })
      .finally(() => setLoading(false));
  }, [branchFilter]);

  const summaryRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return medicines
      .map((med) => {
        const medBatches = batches.filter((b) => b.medicineId === med.id);
        const sellable = medBatches
          .filter((b) => b.status === BatchStatus.ACTIVE || b.status === BatchStatus.EXPIRING_SOON)
          .reduce((sum, b) => sum + b.quantity, 0);
        const expiringSoon = medBatches
          .filter((b) => b.status === BatchStatus.EXPIRING_SOON)
          .reduce((sum, b) => sum + b.quantity, 0);
        const quarantined = medBatches
          .filter((b) => b.status === BatchStatus.EXPIRED || b.status === BatchStatus.RECALLED)
          .reduce((sum, b) => sum + b.quantity, 0);
        const costValue = Number((sellable * med.purchasePrice).toFixed(2));
        const retailValue = Number((sellable * med.sellingPrice).toFixed(2));
        const threshold = branchFilter === 'ALL' ? med.safetyStock * Math.max(1, branches.length) : med.safetyStock;

        return {
          med,
          sellable,
          expiringSoon,
          quarantined,
          costValue,
          retailValue,
          threshold,
          batchCount: medBatches.length,
        };
      })
      .filter((r) => {
        if (!q) return true;
        return `${r.med.brandName} ${r.med.genericName} ${r.med.category} ${r.med.barcode}`.toLowerCase().includes(q);
      });
  }, [medicines, batches, search, branchFilter, branches.length]);

  const totalCost = summaryRows.reduce((s, r) => s + r.costValue, 0);
  const totalRetail = summaryRows.reduce((s, r) => s + r.retailValue, 0);
  const totalUnits = summaryRows.reduce((s, r) => s + r.sellable, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Consolidated Inventory"
        subtitle="Multi-branch sellable stock, pack hierarchy breakdown, safety thresholds, and real-time valuation."
        actions={
          <button type="button" onClick={() => navigate('/receiving')} className={btnPrimaryClass}>
            <PackagePlus className="w-4 h-4" />
            <span>Receive Stock</span>
          </button>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiStatCard label="Sellable Base Units" value={totalUnits.toLocaleString()} meta="Excludes expired & recalled lots" />
        <KpiStatCard label="Inventory Cost Value" value={`$${totalCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}`} />
        <KpiStatCard label="Potential Retail Value" value={`$${totalRetail.toLocaleString('en-US', { minimumFractionDigits: 2 })}`} tone="primary" />
      </div>

      <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter medicines by name, category, or barcode..."
            className={`${inputClass} pl-9`}
          />
        </div>
        <select
          aria-label="Filter inventory by branch"
          value={branchFilter}
          onChange={(e) => setBranchFilter(e.target.value)}
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium"
        >
          <option value="ALL">All Retail Branches</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <LoadingState />
      ) : (
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-5">Medicine</th>
                  <th className="py-3 px-3">Pack Breakdown</th>
                  <th className="py-3 px-3 text-right">Sellable Units</th>
                  <th className="py-3 px-3 text-right">Expiring &lt;90d</th>
                  <th className="py-3 px-3 text-right">Blocked</th>
                  <th className="py-3 px-3 text-right">Cost Value</th>
                  <th className="py-3 px-5">Stock Health</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {summaryRows.map((r) => (
                  <tr key={r.med.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-3 px-5">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {r.med.brandName} {r.med.strength}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {r.med.genericName} · {r.batchCount} batch(es)
                      </div>
                    </td>
                    <td className="py-3 px-3 font-mono text-xs text-slate-600 dark:text-slate-300">
                      {formatPackBreakdown(r.sellable, r.med.packHierarchy)}
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold">{r.sellable}</td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums text-amber-700 dark:text-amber-400">
                      {r.expiringSoon > 0 ? r.expiringSoon : '0'}
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums text-red-700 dark:text-red-400">
                      {r.quarantined > 0 ? r.quarantined : '0'}
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums">${r.costValue.toFixed(2)}</td>
                    <td className="py-3 px-5">
                      {r.sellable === 0 ? (
                        <StatusText status="danger" label="Out of Stock" />
                      ) : r.sellable <= r.threshold ? (
                        <StatusText status="warning" label={`Low (Min ${r.threshold})`} />
                      ) : (
                        <StatusText status="nominal" label="Healthy" />
                      )}
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

export function BatchesPage() {
  const { workspaceMode, activeBranchId } = useAuth();
  const navigate = useNavigate();

  const [batches, setBatches] = useState<EnrichedBatch[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchFilter, setBranchFilter] = useState(workspaceMode === 'branch' ? activeBranchId : 'ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const loadBatches = useCallback(async () => {
    setLoading(true);
    try {
      const [batRes, brRes] = await Promise.all([
        apiRequest<{ items: EnrichedBatch[] }>(
          `/batches?branchId=${encodeURIComponent(branchFilter)}&status=${encodeURIComponent(statusFilter)}`
        ),
        apiRequest<{ items: Branch[] }>('/branches'),
      ]);
      setBatches(batRes.items);
      setBranches(brRes.items.filter((x) => !x.isHeadOffice));
    } finally {
      setLoading(false);
    }
  }, [branchFilter, statusFilter]);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return batches;
    return batches.filter((b) =>
      `${b.batchNumber} ${b.medicineName} ${b.genericName} ${b.branchName}`.toLowerCase().includes(q)
    );
  }, [batches, search]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Batch Inventory (FEFO Ordered)"
        subtitle="Every unit tracked to a lot number. Sorted earliest expiry first; batches expiring within 90 days are highlighted and expired or recalled batches are strictly blocked."
        actions={
          <button type="button" onClick={() => navigate('/receiving')} className={btnPrimaryClass}>
            <PackagePlus className="w-4 h-4" />
            <span>Receive New Batch</span>
          </button>
        }
      />

      <div className="flex flex-col lg:flex-row gap-3 items-stretch lg:items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search batch number, medicine, or branch..."
            className={`${inputClass} pl-9`}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Filter batches by branch"
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
            className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium"
          >
            <option value="ALL">All Branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
            {['ALL', BatchStatus.ACTIVE, BatchStatus.EXPIRING_SOON, BatchStatus.EXPIRED, BatchStatus.RECALLED].map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  statusFilter === st
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {st === 'ALL' ? 'All' : st.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <LoadingState />
      ) : (
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-5">Batch No</th>
                  <th className="py-3 px-3">Medicine</th>
                  <th className="py-3 px-3">Branch</th>
                  <th className="py-3 px-3">Mfg / Expiry</th>
                  <th className="py-3 px-3 text-right">Qty</th>
                  <th className="py-3 px-3 text-right">Sell Price</th>
                  <th className="py-3 px-5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {filtered.map((b) => (
                  <tr
                    key={b.id}
                    className={
                      b.status === BatchStatus.RECALLED || b.status === BatchStatus.EXPIRED
                        ? 'bg-red-50/40 dark:bg-red-950/20'
                        : b.status === BatchStatus.EXPIRING_SOON
                          ? 'bg-amber-50/50 dark:bg-amber-950/20'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                    }
                  >
                    <td className="py-3 px-5 font-mono text-xs font-bold text-slate-900 dark:text-white">
                      {b.batchNumber}
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-medium text-slate-900 dark:text-slate-100">{b.medicineName}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">{b.genericName}</div>
                    </td>
                    <td className="py-3 px-3 text-xs text-slate-600 dark:text-slate-300">{b.branchName}</td>
                    <td className="py-3 px-3 font-mono text-xs">
                      <div className="text-slate-900 dark:text-slate-100">{b.expiryDate}</div>
                      <div className="text-slate-500 dark:text-slate-400">
                        Mfg {b.manufacturingDate} ·{' '}
                        {b.daysToExpiry <= 0 ? `${Math.abs(b.daysToExpiry)}d ago` : `in ${b.daysToExpiry}d`}
                      </div>
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold">{b.quantity}</td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums">${b.sellingPrice.toFixed(2)}</td>
                    <td className="py-3 px-5">
                      {b.status === BatchStatus.RECALLED ? (
                        <StatusText status="danger" label="Recalled · Blocked" />
                      ) : b.status === BatchStatus.EXPIRED ? (
                        <StatusText status="danger" label="Expired · Blocked" />
                      ) : b.status === BatchStatus.EXPIRING_SOON ? (
                        <StatusText status="warning" label={`Expiring (${b.daysToExpiry}d)`} />
                      ) : b.status === BatchStatus.DEPLETED ? (
                        <StatusText status="muted" label="Depleted" />
                      ) : (
                        <StatusText status="nominal" label="Active · FEFO" />
                      )}
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
