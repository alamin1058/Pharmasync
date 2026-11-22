import React, { useCallback, useEffect, useState } from 'react';
import { ArrowUpDown, ChevronLeft, ChevronRight, Download, Search } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { Branch } from '../shared/types';
import {
  EmptyState,
  LoadingState,
  PageHeader,
  btnSecondaryClass,
  inputClass,
} from '../components/UiPrimitives';

const REPORT_TABS = [
  { id: 'daily-sales', label: 'Daily Sales' },
  { id: 'monthly-sales', label: 'Monthly Sales' },
  { id: 'branch-sales', label: 'Branch Sales' },
  { id: 'product-sales', label: 'Product Sales' },
  { id: 'batch-inventory', label: 'Batch Inventory' },
  { id: 'expiry', label: 'Expiry Report' },
  { id: 'recall', label: 'Recall Report' },
  { id: 'prescriptions', label: 'Prescription Register' },
  { id: 'stock-valuation', label: 'Stock Valuation' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'sync', label: 'Synchronization' },
];

interface ReportResponse {
  reportType: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  items: Array<Record<string, unknown>>;
}

function formatColLabel(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
}

export function ReportsPage() {
  const [activeReport, setActiveReport] = useState('daily-sales');
  const [branchId, setBranchId] = useState('ALL');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiRequest<{ items: Branch[] }>('/branches')
      .then((res) => setBranches(res.items.filter((b) => !b.isHeadOffice)))
      .catch(() => {});
  }, []);

  const loadReport = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        branchId,
        search,
        page: String(page),
        pageSize: '12',
        ...(sortBy ? { sortBy, sortDir } : {}),
      });
      const res = await apiRequest<ReportResponse>(`/reports/${activeReport}?${qs.toString()}`);
      setReport(res);
    } finally {
      setLoading(false);
    }
  }, [activeReport, branchId, search, sortBy, sortDir, page]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const columns = report && report.items.length > 0 ? Object.keys(report.items[0]) : [];

  const handleSort = (col: string) => {
    if (sortBy === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
    setPage(1);
  };

  const handleExportCsv = () => {
    if (!report || report.items.length === 0) return;
    const cols = Object.keys(report.items[0]);
    const header = cols.join(',');
    const body = report.items
      .map((row) =>
        cols
          .map((c) => {
            const val = String(row[c] ?? '').replace(/"/g, '""');
            return `"${val}"`;
          })
          .join(',')
      )
      .join('\n');
    const blob = new Blob([`${header}\n${body}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pharmasync-${activeReport}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports & Analytics"
        subtitle="Live SQLite database intelligence across all 11 operational, clinical, valuation, and synchronization domains."
        actions={
          <button
            type="button"
            disabled={!report || report.items.length === 0}
            onClick={handleExportCsv}
            className={btnSecondaryClass}
          >
            <Download className="w-4 h-4" />
            <span>Export CSV</span>
          </button>
        }
      />

      {/* Report Selector Tabs */}
      <div className="flex flex-wrap gap-1.5 pb-1">
        {REPORT_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              setActiveReport(tab.id);
              setSortBy('');
              setPage(1);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
              activeReport === tab.id
                ? 'bg-blue-700 dark:bg-blue-600 text-white'
                : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search rows..."
            className={`${inputClass} pl-9`}
          />
        </div>
        <select
          aria-label="Filter report by branch"
          value={branchId}
          onChange={(e) => {
            setBranchId(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium"
        >
          <option value="ALL">All Branches</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </div>

      {/* Data Table */}
      {loading ? (
        <LoadingState />
      ) : !report || report.items.length === 0 ? (
        <EmptyState title="No matching records" description="Try broadening your search or switching branch filters." />
      ) : (
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                  {columns.map((col) => {
                    const isNumericCol =
                      report.items.length > 0 && typeof report.items[0][col] === 'number';
                    return (
                      <th
                        key={col}
                        className={`py-3 px-4 whitespace-nowrap ${isNumericCol ? 'text-right' : 'text-left'}`}
                      >
                        <button
                          type="button"
                          onClick={() => handleSort(col)}
                          className={`inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer ${
                            isNumericCol ? 'justify-end' : ''
                          }`}
                        >
                          <span>{formatColLabel(col)}</span>
                          <ArrowUpDown className="w-3 h-3 opacity-60" />
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {report.items.map((row, rIdx) => (
                  <tr key={rIdx} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    {columns.map((col) => {
                      const val = row[col];
                      const isNum = typeof val === 'number';
                      const isMoney =
                        isNum && /(sales|revenue|value|cost|margin|discounts|tax|ticket|valuation)/i.test(col);
                      return (
                        <td
                          key={col}
                          className={`py-2.5 px-4 ${isNum ? 'font-mono tabular-nums text-right' : 'text-slate-700 dark:text-slate-200'}`}
                        >
                          {isMoney ? `$${val.toFixed(2)}` : String(val ?? '—')}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span className="font-mono tabular-nums">
              Showing page {report.page} of {report.totalPages} ({report.total} total rows)
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={report.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="Previous page"
                className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 disabled:opacity-40 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                disabled={report.page >= report.totalPages}
                onClick={() => setPage((p) => Math.min(report.totalPages, p + 1))}
                aria-label="Next page"
                className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 disabled:opacity-40 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
