import React, { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  BarChart3,
  Bell,
  Building2,
  ClipboardList,
  FileText,
  Layers,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  PackageCheck,
  Pill,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  ShoppingCart,
  Sun,
  TrendingUp,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useSync } from '../context/SyncContext';
import { useSmartHistory } from '../hooks/useSmartHistory';
import { Permission, UserRole } from '../shared/types';
import { apiRequest } from '../lib/api';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  section: 'Operations' | 'Clinical & Safety' | 'Administration';
  permission?: Permission;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, section: 'Operations' },
  { to: '/pos', label: 'Point of Sale', icon: ShoppingCart, section: 'Operations', permission: 'pos:sell' },
  { to: '/medicines', label: 'Medicines', icon: Pill, section: 'Operations' },
  { to: '/inventory', label: 'Inventory', icon: ClipboardList, section: 'Operations' },
  { to: '/batches', label: 'Batches', icon: Layers, section: 'Operations' },
  { to: '/receiving', label: 'Purchases / Receiving', icon: PackageCheck, section: 'Operations', permission: 'inventory:write' },
  { to: '/transfers', label: 'Transfers', icon: ArrowRightLeft, section: 'Operations', permission: 'transfers:manage' },
  { to: '/prescriptions', label: 'Prescriptions', icon: FileText, section: 'Clinical & Safety' },
  { to: '/recalls', label: 'Recalls', icon: ShieldAlert, section: 'Clinical & Safety' },
  { to: '/reordering', label: 'Reordering', icon: TrendingUp, section: 'Clinical & Safety' },
  { to: '/reports', label: 'Reports', icon: BarChart3, section: 'Clinical & Safety' },
  { to: '/branches', label: 'Branches', icon: Building2, section: 'Administration' },
  { to: '/users', label: 'Users & Roles', icon: Users, section: 'Administration', permission: 'users:manage' },
  { to: '/sync', label: 'Synchronization', icon: RefreshCw, section: 'Administration' },
  { to: '/settings', label: 'Settings', icon: Settings, section: 'Administration' },
];

const ROUTE_META: Record<string, { title: string; breadcrumb: string }> = {
  '/dashboard': { title: 'Dashboard', breadcrumb: 'Overview' },
  '/pos': { title: 'Point of Sale', breadcrumb: 'Branch POS Terminal' },
  '/medicines': { title: 'Medicines', breadcrumb: 'Central Catalogue' },
  '/inventory': { title: 'Inventory', breadcrumb: 'Multi-Branch Stock' },
  '/batches': { title: 'Batches', breadcrumb: 'FEFO Batch Ledger' },
  '/receiving': { title: 'Purchases & Receiving', breadcrumb: 'Inbound Stock & Counts' },
  '/transfers': { title: 'Branch Transfers', breadcrumb: 'Inter-Branch Logistics' },
  '/prescriptions': { title: 'Prescriptions', breadcrumb: 'Clinical Register' },
  '/recalls': { title: 'Recall Management', breadcrumb: 'Safety & Pharmacovigilance' },
  '/reordering': { title: 'Reordering', breadcrumb: 'Velocity Replenishment' },
  '/reports': { title: 'Reports & Analytics', breadcrumb: 'Live Database Intelligence' },
  '/branches': { title: 'Branches', breadcrumb: 'Network Directory' },
  '/users': { title: 'Users & Roles', breadcrumb: 'RBAC Access Control' },
  '/sync': { title: 'Synchronization', breadcrumb: 'Outbox & Conflict Engine' },
  '/settings': { title: 'Settings', breadcrumb: 'System & Observability' },
};

export function Layout() {
  const { user, workspaceMode, setWorkspaceMode, activeBranchId, setActiveBranchId, logout, hasPermission } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { isOnline, setOfflineSimulated, pendingOutboxCount, unresolvedConflicts, isSyncing, triggerSyncNow } = useSync();
  const { goBack, goForward, canGoBack, canGoForward } = useSmartHistory('/dashboard');

  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [branches, setBranches] = useState<Array<{ id: string; name: string; code: string; isHeadOffice: boolean }>>([]);
  const [quickAlerts, setQuickAlerts] = useState<Array<{ title: string; detail: string; route: string }>>([]);

  const searchRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiRequest<{ items: Array<{ id: string; name: string; code: string; isHeadOffice: boolean }> }>('/branches')
      .then((res) => setBranches(res.items.filter((b) => !b.isHeadOffice)))
      .catch(() => {});

    apiRequest<{ kpis: { expiringCount: number; expiredCount: number; recalledCount: number; lowStockCount: number } }>(
      '/dashboard?mode=head_office'
    )
      .then((res) => {
        const list: Array<{ title: string; detail: string; route: string }> = [];
        if (res.kpis.recalledCount > 0) {
          list.push({
            title: `${res.kpis.recalledCount} active recalled batch lot(s)`,
            detail: 'Review branch compliance and quarantine stock.',
            route: '/recalls',
          });
        }
        if (res.kpis.expiringCount > 0) {
          list.push({
            title: `${res.kpis.expiringCount} batch(es) expiring within 90 days`,
            detail: 'Prioritized automatically via FEFO dispensing.',
            route: '/batches',
          });
        }
        if (res.kpis.expiredCount > 0) {
          list.push({
            title: `${res.kpis.expiredCount} expired batch(es) blocked at POS`,
            detail: 'Remove from active shelves and log disposal.',
            route: '/batches',
          });
        }
        if (res.kpis.lowStockCount > 0) {
          list.push({
            title: `${res.kpis.lowStockCount} low-stock medicine(s)`,
            detail: 'Inspect 30-day velocity reorder suggestions.',
            route: '/reordering',
          });
        }
        setQuickAlerts(list);
      })
      .catch(() => {});
  }, [location.pathname]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (searchRef.current && !searchRef.current.contains(target)) setSearchOpen(false);
      if (notifRef.current && !notifRef.current.contains(target)) setNotifOpen(false);
      if (profileRef.current && !profileRef.current.contains(target)) setProfileOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const visibleNavItems = useMemo(
    () => NAV_ITEMS.filter((item) => !item.permission || hasPermission(item.permission)),
    [hasPermission]
  );

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return visibleNavItems.filter(
      (item) => item.label.toLowerCase().includes(q) || item.section.toLowerCase().includes(q)
    );
  }, [searchQuery, visibleNavItems]);

  const currentMeta = ROUTE_META[location.pathname] ?? { title: 'PharmaSync', breadcrumb: 'Workspace' };
  const isHoPrivileged = user?.role === UserRole.SUPER_ADMIN || user?.role === UserRole.HEAD_OFFICE_ADMIN;
  const sections: Array<NavItem['section']> = ['Operations', 'Clinical & Safety', 'Administration'];
  const totalAlertCount = quickAlerts.length + (unresolvedConflicts > 0 ? 1 : 0);

  const initials = (user?.fullName || 'PS')
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-[#0B1120] text-slate-900 dark:text-slate-100">
      {/* Mobile Sidebar Backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/60 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Left Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col transition-transform duration-200 lg:static lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-16 px-5 flex items-center justify-between border-b border-slate-200 dark:border-slate-800 shrink-0">
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="flex items-center gap-2.5 text-left cursor-pointer"
          >
            <span className="w-8 h-8 rounded-lg bg-blue-700 dark:bg-blue-600 text-white flex items-center justify-center font-bold text-sm font-display">
              PS
            </span>
            <span className="text-lg font-bold tracking-tight font-display text-slate-900 dark:text-white whitespace-nowrap">
              PharmaSync
            </span>
          </button>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation menu"
            className="lg:hidden p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Workspace Context Selector (Head Office vs Branch POS) */}
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 space-y-2 shrink-0">
          {isHoPrivileged && (
            <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800/80">
              <button
                type="button"
                onClick={() => setWorkspaceMode('head_office')}
                className={`px-2 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  workspaceMode === 'head_office'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                Head Office
              </button>
              <button
                type="button"
                onClick={() => setWorkspaceMode('branch')}
                className={`px-2 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  workspaceMode === 'branch'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                Branch POS
              </button>
            </div>
          )}

          <div>
            <label htmlFor="active-branch-select" className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              Active Branch Terminal
            </label>
            <select
              id="active-branch-select"
              value={activeBranchId}
              onChange={(e) => setActiveBranchId(e.target.value)}
              disabled={!isHoPrivileged && user?.branchId !== 'br-ho'}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-600/30 disabled:opacity-70"
            >
              {branches.length === 0 ? (
                <option value="br-downtown">Downtown Central Pharmacy</option>
              ) : (
                branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {b.name}
                  </option>
                ))
              )}
            </select>
          </div>
        </div>

        {/* Navigation Links */}
        <nav aria-label="Main navigation" className="flex-1 overflow-y-auto px-3 py-3 space-y-5">
          {sections.map((section) => {
            const items = visibleNavItems.filter((i) => i.section === section);
            if (items.length === 0) return null;
            return (
              <div key={section}>
                <p className="px-2.5 mb-1.5 text-[11px] font-semibold text-slate-400 dark:text-slate-500 tracking-wide">
                  {section}
                </p>
                <div className="space-y-0.5">
                  {items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        onClick={() => setSidebarOpen(false)}
                        className={({ isActive }) =>
                          `flex items-center justify-between gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors ${
                            isActive
                              ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
                              : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70 hover:text-slate-900 dark:hover:text-white'
                          }`
                        }
                      >
                        <span className="flex items-center gap-2.5 truncate">
                          <Icon className="w-4 h-4 shrink-0" />
                          <span className="truncate">{item.label}</span>
                        </span>
                        {item.to === '/sync' && pendingOutboxCount > 0 && (
                          <span className="font-mono text-xs font-semibold text-amber-700 dark:text-amber-400 tabular-nums">
                            {pendingOutboxCount}
                          </span>
                        )}
                      </NavLink>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        {/* Bottom Role Summary */}
        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 shrink-0">
          <div className="font-medium text-slate-800 dark:text-slate-200 truncate">{user?.fullName}</div>
          <div className="truncate mt-0.5">{user?.role.replace(/_/g, ' ')}</div>
        </div>
      </aside>

      {/* Main Column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Navigation Bar */}
        <header className="sticky top-0 z-30 h-16 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs border-b border-slate-200 dark:border-slate-800 px-2.5 sm:px-4 lg:px-6 flex items-center justify-between gap-2 sm:gap-3">
          {/* Left: Mobile Menu + Smart Back/Forward Buttons + Breadcrumb */}
          <div className="flex items-center gap-1.5 sm:gap-3 shrink-0 sm:min-w-0 sm:shrink">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-1.5 sm:p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            >
              <Menu className="w-5 h-5" />
            </button>

            {/* Smart Backward & Forward Navigation Controls */}
            <div className="flex items-center gap-1 sm:gap-1.5 shrink-0" role="group" aria-label="History navigation">
              <button
                type="button"
                onClick={goBack}
                disabled={!canGoBack}
                title="Go Back"
                aria-label="Go Back"
                className="w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-700 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={goForward}
                disabled={!canGoForward}
                title="Go Forward"
                aria-label="Go Forward"
                className="w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-700 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 cursor-pointer"
              >
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>

            <div className="min-w-0 hidden sm:block">
              <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <span className="truncate">{workspaceMode === 'head_office' ? 'Head Office' : 'Branch POS'}</span>
                <span aria-hidden="true">/</span>
                <span className="truncate">{currentMeta.breadcrumb}</span>
              </div>
              <p className="text-sm font-bold text-slate-900 dark:text-white truncate">{currentMeta.title}</p>
            </div>
          </div>

          {/* Center-Right: Global Search + Connectivity + Sync + Notifications + Theme + Profile */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {/* Global Search */}
            <div ref={searchRef} className="relative hidden md:block w-56 xl:w-72">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onFocus={() => setSearchOpen(true)}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setSearchOpen(true);
                }}
                placeholder="Jump to module..."
                aria-label="Global navigation search"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 pl-9 pr-3 py-1.5 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600/30"
              />
              {searchOpen && searchQuery.trim() && (
                <div className="absolute right-0 mt-1.5 w-full rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-lg py-1.5 z-50">
                  {searchResults.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-slate-500">No matching modules.</p>
                  ) : (
                    searchResults.map((item) => (
                      <button
                        key={item.to}
                        type="button"
                        onClick={() => {
                          navigate(item.to);
                          setSearchQuery('');
                          setSearchOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-between cursor-pointer"
                      >
                        <span>{item.label}</span>
                        <span className="text-xs text-slate-400">{item.section}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Online / Offline Mode Toggle */}
            <button
              type="button"
              onClick={() => setOfflineSimulated(isOnline)}
              title={isOnline ? 'Connected — click to simulate Offline Mode' : 'Offline Mode — click to reconnect'}
              aria-label={isOnline ? 'Switch to simulated offline mode' : 'Reconnect online'}
              className={`inline-flex items-center justify-center gap-1.5 h-8 sm:h-9 px-2 sm:px-2.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                isOnline
                  ? 'border-emerald-200 dark:border-emerald-900/80 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-950/70'
                  : 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 text-amber-900 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950/80'
              }`}
            >
              {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{isOnline ? 'Online' : 'Offline Mode'}</span>
            </button>

            {/* Sync Status Action */}
            <button
              type="button"
              onClick={() => (isOnline && hasPermission('sync:manage') ? void triggerSyncNow() : navigate('/sync'))}
              disabled={isSyncing}
              title={pendingOutboxCount > 0 ? `${pendingOutboxCount} pending operations — click to sync` : 'Synchronization up to date'}
              aria-label="Synchronize now"
              className="inline-flex items-center justify-center gap-1.5 h-8 sm:h-9 px-2 sm:px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors whitespace-nowrap cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin text-blue-600' : ''}`} />
              {pendingOutboxCount > 0 ? (
                <span className="font-mono tabular-nums">
                  {pendingOutboxCount}
                  <span className="hidden sm:inline"> Pending</span>
                </span>
              ) : (
                <span className="hidden sm:inline font-mono tabular-nums">
                  {isSyncing ? 'Syncing' : 'Synced'}
                </span>
              )}
            </button>

            {/* Notifications */}
            <div ref={notifRef} className="relative">
              <button
                type="button"
                onClick={() => setNotifOpen((o) => !o)}
                aria-label="Notifications"
                title="Notifications"
                className="relative w-8 h-8 sm:w-9 sm:h-9 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
              >
                <Bell className="w-4 h-4" />
                {totalAlertCount > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-[10px] font-bold text-white flex items-center justify-center font-mono tabular-nums">
                    {totalAlertCount}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="absolute right-0 mt-2 w-80 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl z-50 overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900 dark:text-white">Operational Alerts</span>
                    <span className="text-xs text-slate-500 font-mono tabular-nums">{totalAlertCount}</span>
                  </div>
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-y-auto">
                    {unresolvedConflicts > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setNotifOpen(false);
                          navigate('/sync');
                        }}
                        className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/60 flex items-start gap-2.5 cursor-pointer"
                      >
                        <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                        <div>
                          <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                            {unresolvedConflicts} unresolved sync conflict(s)
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            Open Synchronization Center to review.
                          </p>
                        </div>
                      </button>
                    )}
                    {quickAlerts.map((a, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          setNotifOpen(false);
                          navigate(a.route);
                        }}
                        className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/60 flex items-start gap-2.5 cursor-pointer"
                      >
                        <Activity className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                        <div>
                          <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">{a.title}</p>
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{a.detail}</p>
                        </div>
                      </button>
                    ))}
                    {totalAlertCount === 0 && (
                      <p className="px-4 py-6 text-xs text-center text-slate-500">All clinical and stock indicators nominal.</p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Day / Night Mode Toggle */}
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 flex items-center justify-center text-slate-700 dark:text-amber-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            {/* User Profile Menu */}
            <div ref={profileRef} className="relative">
              <button
                type="button"
                onClick={() => setProfileOpen((o) => !o)}
                aria-label="User profile menu"
                className="flex items-center gap-2 pl-1.5 pr-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
              >
                <span className="w-7 h-7 rounded-md bg-blue-700 dark:bg-blue-600 text-white text-xs font-bold flex items-center justify-center">
                  {initials}
                </span>
                <span className="hidden xl:block text-left">
                  <span className="block text-xs font-semibold text-slate-900 dark:text-slate-100 leading-tight max-w-[110px] truncate">
                    {user?.fullName}
                  </span>
                  <span className="block text-[10px] text-slate-500 dark:text-slate-400 leading-tight">
                    {user?.username}
                  </span>
                </span>
              </button>

              {profileOpen && (
                <div className="absolute right-0 mt-2 w-60 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl z-50 py-1.5">
                  <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800">
                    <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">{user?.fullName}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{user?.email}</p>
                    <p className="text-xs text-blue-700 dark:text-blue-400 font-medium mt-1">
                      {user?.role.replace(/_/g, ' ')} · {user?.branchName}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setProfileOpen(false);
                      navigate('/settings');
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2 cursor-pointer"
                  >
                    <Settings className="w-4 h-4" />
                    <span>Settings & API Spec</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setProfileOpen(false);
                      logout();
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 flex items-center gap-2 cursor-pointer"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>Sign Out</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Offline Banner when simulated or disconnected */}
        {!isOnline && (
          <div className="bg-amber-50 dark:bg-amber-950/60 border-b border-amber-200 dark:border-amber-900 px-4 lg:px-6 py-2 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-900 dark:text-amber-200">
            <span className="font-medium">
              Offline-First Terminal Active — Sales, FEFO batch checks, and receipts continue locally in SQLite & IndexedDB outbox (72h resilience).
            </span>
            <button
              type="button"
              onClick={() => setOfflineSimulated(false)}
              className="underline font-semibold hover:text-amber-700 dark:hover:text-amber-100 cursor-pointer"
            >
              Reconnect Online
            </button>
          </div>
        )}

        {/* Main Content Viewport */}
        <main className="flex-1 p-4 lg:p-6 max-w-[1600px] w-full mx-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
