import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { RefreshCw, ShoppingCart, ShieldAlert, TrendingUp } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useSync } from '../context/SyncContext';
import {
  AlertBanner,
  KpiStatCard,
  LoadingState,
  PageHeader,
  StatusText,
  btnPrimaryClass,
  btnSecondaryClass,
} from '../components/UiPrimitives';

interface DashboardData {
  mode: 'head_office' | 'branch';
  branchId: string;
  kpis: {
    totalMedicines: number;
    totalBranches: number;
    totalStockValue: number;
    todaySales: number;
    monthlySales: number;
    lowStockCount: number;
    expiringCount: number;
    expiredCount: number;
    recalledCount: number;
    pendingSyncCount: number;
    openConflictsCount: number;
  };
  salesTrend: Array<{ date: string; revenue: number; transactions: number }>;
  categoryValuation: Array<{ category: string; value: number }>;
  branches: Array<{
    id: string;
    code: string;
    name: string;
    city: string;
    online: boolean;
    lastSyncAt: string | null;
    pendingOpsCount: number;
    revenue30d: number;
  }>;
  lowStockItems: Array<{
    medicineId: string;
    brandName: string;
    genericName: string;
    category: string;
    currentStock: number;
    safetyStock: number;
  }>;
  recentTransactions: Array<{
    id: string;
    invoiceNumber: string;
    branchName: string;
    cashierName: string;
    totalAmount: number;
    paymentMethod: string;
    status: string;
    createdOffline: boolean;
    synced: boolean;
    itemCount: number;
    createdAt: string;
  }>;
}

export function DashboardPage() {
  const { workspaceMode, activeBranchId, hasPermission } = useAuth();
  const { theme } = useTheme();
  const { isOnline, isSyncing, triggerSyncNow, lastSyncMessage } = useSync();
  const navigate = useNavigate();

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<DashboardData>(
        `/dashboard?mode=${workspaceMode}&branchId=${encodeURIComponent(activeBranchId)}`
      );
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load dashboard.');
    } finally {
      setLoading(false);
    }
  }, [workspaceMode, activeBranchId]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const axisColor = theme === 'dark' ? '#94A3B8' : '#64748B';
  const gridColor = theme === 'dark' ? '#1E293B' : '#E2E8F0';
  const tooltipStyle = {
    backgroundColor: theme === 'dark' ? '#0F172A' : '#FFFFFF',
    borderColor: theme === 'dark' ? '#334155' : '#E2E8F0',
    color: theme === 'dark' ? '#F8FAFC' : '#0F172A',
    borderRadius: '8px',
    fontSize: '12px',
  };

  if (loading && !data) return <LoadingState label="Loading pharmacy dashboard..." />;

  return (
    <div className="space-y-6">
      <PageHeader
        title={workspaceMode === 'head_office' ? 'Head Office Command Center' : 'Branch Operations Dashboard'}
        subtitle={
          workspaceMode === 'head_office'
            ? 'Central inventory valuation, multi-branch synchronization, recall enforcement, and network sales.'
            : 'Real-time local branch stock, FEFO expiry watch, POS sales velocity, and offline outbox health.'
        }
        actions={
          <>
            {hasPermission('sync:manage') && (
              <button
                type="button"
                disabled={!isOnline || isSyncing}
                onClick={() => void triggerSyncNow().then(loadDashboard)}
                className={btnSecondaryClass}
              >
                <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
                <span>{isSyncing ? 'Syncing...' : 'Sync Network'}</span>
              </button>
            )}
            {hasPermission('pos:sell') && (
              <button type="button" onClick={() => navigate('/pos')} className={btnPrimaryClass}>
                <ShoppingCart className="w-4 h-4" />
                <span>Open POS Terminal</span>
              </button>
            )}
          </>
        }
      />

      {error && <AlertBanner tone="error" message={error} onDismiss={() => setError(null)} />}
      {lastSyncMessage && <AlertBanner tone="success" message={lastSyncMessage} />}

      {data && (
        <>
          {/* Primary Financial & Operational KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
            <KpiStatCard
              label="Today's Sales"
              value={`$${data.kpis.todaySales.toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
              meta={`Month: $${data.kpis.monthlySales.toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
              tone="primary"
            />
            <KpiStatCard
              label="Total Stock Value"
              value={`$${data.kpis.totalStockValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
              meta={`${data.kpis.totalMedicines} active SKUs · ${data.kpis.totalBranches} branches`}
            />
            <KpiStatCard
              label="Expiring (< 90 Days)"
              value={data.kpis.expiringCount}
              meta={`${data.kpis.expiredCount} expired blocked at POS`}
              tone={data.kpis.expiringCount > 0 ? 'warning' : 'success'}
            />
            <KpiStatCard
              label="Recalled Batches"
              value={data.kpis.recalledCount}
              meta={`${data.kpis.lowStockCount} SKUs below safety stock`}
              tone={data.kpis.recalledCount > 0 ? 'danger' : 'success'}
            />
            <KpiStatCard
              label="Pending Sync Ops"
              value={data.kpis.pendingSyncCount}
              meta={`${data.kpis.openConflictsCount} unresolved conflicts`}
              tone={data.kpis.pendingSyncCount > 0 || data.kpis.openConflictsCount > 0 ? 'warning' : 'success'}
            />
          </div>

          {/* Analytics Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <section className="lg:col-span-7 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-bold text-slate-900 dark:text-white">14-Day Sales Revenue</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Net dispensed revenue (USD)</p>
                </div>
                <button
                  type="button"
                  onClick={() => navigate('/reports')}
                  className="text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
                >
                  View Reports
                </button>
              </div>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.salesTrend} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#2563EB" stopOpacity={0.28} />
                        <stop offset="95%" stopColor="#2563EB" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: axisColor, fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis
                      tick={{ fill: axisColor, fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v) => `$${v}`}
                    />
                    <Tooltip contentStyle={tooltipStyle} formatter={(val) => [`$${Number(val).toFixed(2)}`, 'Revenue']} />
                    <Area
                      type="monotone"
                      dataKey="revenue"
                      stroke="#2563EB"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#revGrad)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="lg:col-span-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-bold text-slate-900 dark:text-white">Stock Valuation by Category</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Sellable cost basis (USD)</p>
                </div>
                <button
                  type="button"
                  onClick={() => navigate('/inventory')}
                  className="text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
                >
                  Inventory
                </button>
              </div>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={data.categoryValuation.slice(0, 6)}
                    layout="vertical"
                    margin={{ top: 4, right: 16, left: 16, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} horizontal={false} />
                    <XAxis type="number" tick={{ fill: axisColor, fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis
                      type="category"
                      dataKey="category"
                      width={96}
                      tick={{ fill: axisColor, fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip contentStyle={tooltipStyle} formatter={(val) => [`$${Number(val).toFixed(2)}`, 'Cost Value']} />
                    <Bar dataKey="value" fill="#1D4ED8" radius={[0, 4, 4, 0]} barSize={18} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
          </div>

          {/* Branch Status & Low Stock Split */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <section className="lg:col-span-7 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold text-slate-900 dark:text-white">Branch Connectivity & Sync Status</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Live branch terminals and outbox depth</p>
                </div>
                <button
                  type="button"
                  onClick={() => navigate('/branches')}
                  className="text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
                >
                  Manage Branches
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                      <th className="py-2.5 px-5">Branch</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3 text-right">Pending Ops</th>
                      <th className="py-2.5 px-5 text-right">30d Sales</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                    {data.branches.map((br) => (
                      <tr key={br.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="py-3 px-5">
                          <div className="font-medium text-slate-900 dark:text-slate-100">{br.name}</div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                            {br.code} · {br.city}
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          <StatusText status={br.online ? 'nominal' : 'warning'} label={br.online ? 'Online' : 'Offline'} />
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">
                          {br.pendingOpsCount}
                        </td>
                        <td className="py-3 px-5 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                          ${br.revenue30d.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="lg:col-span-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold text-slate-900 dark:text-white">Low-Stock Watchlist</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Below configured safety stock</p>
                </div>
                <button
                  type="button"
                  onClick={() => navigate('/reordering')}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
                >
                  <TrendingUp className="w-3.5 h-3.5" />
                  <span>Reorder Plan</span>
                </button>
              </div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.lowStockItems.length === 0 ? (
                  <p className="px-5 py-8 text-xs text-center text-slate-500">All SKUs are above safety stock.</p>
                ) : (
                  data.lowStockItems.map((item) => (
                    <div key={item.medicineId} className="px-5 py-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{item.brandName}</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                          {item.genericName} · {item.category}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-mono tabular-nums font-bold text-amber-700 dark:text-amber-400">
                          {item.currentStock} u
                        </p>
                        <p className="text-[11px] font-mono tabular-nums text-slate-500">Min {item.safetyStock}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>

          {/* Recent Transactions */}
          <section className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-slate-900 dark:text-white">Recent Transactions</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">Latest POS invoices across active scope</p>
              </div>
              <button
                type="button"
                onClick={() => navigate('/recalls')}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 dark:text-red-400 hover:underline cursor-pointer"
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>Recall Status</span>
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                    <th className="py-2.5 px-5">Invoice</th>
                    <th className="py-2.5 px-3">Branch</th>
                    <th className="py-2.5 px-3">Cashier</th>
                    <th className="py-2.5 px-3">Mode</th>
                    <th className="py-2.5 px-3">Payment</th>
                    <th className="py-2.5 px-3 text-right">Amount</th>
                    <th className="py-2.5 px-5 text-right">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                  {data.recentTransactions.map((tx) => (
                    <tr key={tx.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="py-3 px-5 font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">
                        {tx.invoiceNumber}
                      </td>
                      <td className="py-3 px-3 text-slate-700 dark:text-slate-300">{tx.branchName}</td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400">{tx.cashierName}</td>
                      <td className="py-3 px-3">
                        <StatusText
                          status={tx.synced ? 'nominal' : 'warning'}
                          label={tx.createdOffline ? (tx.synced ? 'Offline · Synced' : 'Offline · Queued') : 'Online'}
                        />
                      </td>
                      <td className="py-3 px-3 text-xs text-slate-600 dark:text-slate-400">{tx.paymentMethod}</td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                        ${tx.totalAmount.toFixed(2)}
                      </td>
                      <td className="py-3 px-5 text-right font-mono text-xs text-slate-500 dark:text-slate-400">
                        {new Date(tx.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
