import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Building2,
  CheckCircle2,
  Download,
  Moon,
  Plus,
  RefreshCw,
  Shield,
  Sun,
  UserPlus,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { apiRequest, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useSync } from '../context/SyncContext';
import {
  AuditLogEntry,
  AuthUser,
  Branch,
  ConflictRecord,
  Permission,
  UserRole,
} from '../shared/types';
import { receiptPrinter } from '../shared/domainEngine';
import {
  AlertBanner,
  EmptyState,
  KpiStatCard,
  LoadingState,
  Modal,
  PageHeader,
  StatusText,
  btnPrimaryClass,
  btnSecondaryClass,
  inputClass,
} from '../components/UiPrimitives';

// ============================================================================
// BRANCHES MANAGEMENT PAGE
// ============================================================================
export function BranchesPage() {
  const { hasPermission } = useAuth();
  const { triggerSyncNow, isSyncing } = useSync();
  const canManage = hasPermission('branches:manage');

  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', city: '', address: '', phone: '' });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadBranches = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ items: Branch[] }>('/branches');
      setBranches(res.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  const handleToggleOnline = async (br: Branch) => {
    setError(null);
    try {
      await apiRequest(`/branches/${br.id}/connectivity`, {
        method: 'PATCH',
        body: { online: !br.online },
      });
      setSuccess(`${br.name} set to ${!br.online ? 'Online' : 'Offline (72h local mode)'}.`);
      await loadBranches();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update connectivity.');
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await apiRequest('/branches', { method: 'POST', body: form });
      setSuccess(`Registered branch ${form.name}. Initial catalogue synced.`);
      setModalOpen(false);
      setForm({ code: '', name: '', city: '', address: '', phone: '' });
      await loadBranches();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to register branch.');
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Pharmacy Branches"
        subtitle="Manage Head Office and retail pharmacy terminals, connectivity status, and per-branch sync queues."
        actions={
          canManage ? (
            <button type="button" onClick={() => setModalOpen(true)} className={btnPrimaryClass}>
              <Plus className="w-4 h-4" />
              <span>Register Branch</span>
            </button>
          ) : undefined
        }
      />

      {error && <AlertBanner tone="error" message={error} onDismiss={() => setError(null)} />}
      {success && <AlertBanner tone="success" message={success} onDismiss={() => setSuccess(null)} />}

      {loading ? (
        <LoadingState />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {branches.map((b) => (
            <div
              key={b.id}
              className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 flex flex-col justify-between gap-4"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-blue-700 dark:text-blue-400" />
                      <h2 className="text-base font-bold text-slate-900 dark:text-white">{b.name}</h2>
                    </div>
                    <p className="text-xs font-mono text-slate-500 dark:text-slate-400 mt-1">
                      {b.code} · Device {b.deviceId} · {b.isHeadOffice ? 'Central Authority' : 'Retail Branch POS'}
                    </p>
                  </div>
                  <StatusText
                    status={b.online ? 'nominal' : 'warning'}
                    label={b.online ? 'Online' : 'Offline'}
                  />
                </div>

                <div className="mt-3 text-xs text-slate-600 dark:text-slate-300 space-y-1">
                  <p>{b.address}, {b.city}</p>
                  <p className="font-mono">{b.phone}</p>
                  <p className="text-slate-500 dark:text-slate-400 font-mono">
                    Last Sync: {b.lastSyncAt ? new Date(b.lastSyncAt).toLocaleString() : 'Never'} · Pending Ops:{' '}
                    <strong className="text-slate-900 dark:text-white">{b.pendingOpsCount}</strong>
                  </p>
                </div>
              </div>

              {!b.isHeadOffice && (
                <div className="flex items-center gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => void handleToggleOnline(b)}
                    className={btnSecondaryClass}
                  >
                    {b.online ? <WifiOff className="w-3.5 h-3.5" /> : <Wifi className="w-3.5 h-3.5" />}
                    <span>{b.online ? 'Simulate Offline' : 'Bring Online'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={isSyncing}
                    onClick={() => void triggerSyncNow(b.id).then(loadBranches)}
                    className={btnPrimaryClass}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                    <span>Sync Branch</span>
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Modal open={modalOpen} title="Register New Pharmacy Branch" onClose={() => setModalOpen(false)}>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="br-code" className="block text-xs font-medium mb-1">Branch Code *</label>
              <input id="br-code" required placeholder="BR-004" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className={`${inputClass} font-mono`} />
            </div>
            <div>
              <label htmlFor="br-city" className="block text-xs font-medium mb-1">City *</label>
              <input id="br-city" required placeholder="Brookline" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className={inputClass} />
            </div>
          </div>
          <div>
            <label htmlFor="br-name" className="block text-xs font-medium mb-1">Branch Name *</label>
            <input id="br-name" required placeholder="Beacon Street Pharmacy" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} />
          </div>
          <div>
            <label htmlFor="br-addr" className="block text-xs font-medium mb-1">Street Address</label>
            <input id="br-addr" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className={inputClass} />
          </div>
          <div>
            <label htmlFor="br-phone" className="block text-xs font-medium mb-1">Phone Number</label>
            <input id="br-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputClass} />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setModalOpen(false)} className={btnSecondaryClass}>Cancel</button>
            <button type="submit" className={btnPrimaryClass}>Register Branch</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// ============================================================================
// USERS & RBAC ROLES PAGE
// ============================================================================
export function UsersRolesPage() {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [roleMatrix, setRoleMatrix] = useState<Record<string, Permission[]>>({});
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [form, setForm] = useState({
    username: '',
    fullName: '',
    email: '',
    password: '',
    role: UserRole.PHARMACIST,
    branchId: 'br-downtown',
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [uRes, bRes] = await Promise.all([
        apiRequest<{ items: AuthUser[]; roleMatrix: Record<string, Permission[]> }>('/users'),
        apiRequest<{ items: Branch[] }>('/branches'),
      ]);
      setUsers(uRes.items);
      setRoleMatrix(uRes.roleMatrix);
      setBranches(bRes.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load users.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    try {
      await apiRequest('/users', { method: 'POST', body: form });
      setSuccess(`Created ${form.role.replace(/_/g, ' ')} account '${form.username}'.`);
      setModalOpen(false);
      setForm({ username: '', fullName: '', email: '', password: '', role: UserRole.PHARMACIST, branchId: 'br-downtown' });
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create user.');
    }
  };

  const handleToggleActive = async (u: AuthUser) => {
    setError(null);
    try {
      await apiRequest(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } });
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update user status.');
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users & Role-Based Access Control"
        subtitle="Manage pharmacy staff credentials (scrypt salted hashes) and inspect server-enforced endpoint permissions across all 6 roles."
        actions={
          <button type="button" onClick={() => setModalOpen(true)} className={btnPrimaryClass}>
            <UserPlus className="w-4 h-4" />
            <span>Add Staff Member</span>
          </button>
        }
      />

      {error && <AlertBanner tone="error" message={error} onDismiss={() => setError(null)} />}
      {success && <AlertBanner tone="success" message={success} onDismiss={() => setSuccess(null)} />}

      {loading ? (
        <LoadingState />
      ) : (
        <>
          <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-5">Staff Member</th>
                    <th className="py-3 px-3">Username</th>
                    <th className="py-3 px-3">Role</th>
                    <th className="py-3 px-3">Assigned Branch</th>
                    <th className="py-3 px-3">Status</th>
                    <th className="py-3 px-5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="py-3 px-5">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">{u.fullName}</div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">{u.email}</div>
                      </td>
                      <td className="py-3 px-3 font-mono text-xs">{u.username}</td>
                      <td className="py-3 px-3 text-xs font-semibold text-blue-700 dark:text-blue-400">
                        {u.role.replace(/_/g, ' ')}
                      </td>
                      <td className="py-3 px-3 text-xs text-slate-600 dark:text-slate-300">{u.branchName}</td>
                      <td className="py-3 px-3">
                        <StatusText status={u.active ? 'nominal' : 'muted'} label={u.active ? 'Active' : 'Disabled'} />
                      </td>
                      <td className="py-3 px-5 text-right">
                        {u.username !== 'superadmin' && (
                          <button
                            type="button"
                            onClick={() => void handleToggleActive(u)}
                            className="text-xs font-semibold text-slate-700 dark:text-slate-300 hover:underline cursor-pointer"
                          >
                            {u.active ? 'Disable' : 'Activate'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* RBAC Matrix */}
          <section className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5">
            <div className="flex items-center gap-2 mb-4">
              <Shield className="w-4 h-4 text-blue-700 dark:text-blue-400" />
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Server-Enforced RBAC Permission Matrix</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {Object.entries(roleMatrix).map(([role, perms]) => (
                <div key={role} className="rounded-lg border border-slate-200 dark:border-slate-800 p-3.5">
                  <h3 className="text-xs font-bold text-slate-900 dark:text-white">{role.replace(/_/g, ' ')}</h3>
                  <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-400 leading-relaxed font-mono">
                    {perms.join(' · ')}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      <Modal open={modalOpen} title="Create Staff Account" onClose={() => setModalOpen(false)}>
        <form onSubmit={handleCreateUser} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="usr-uname" className="block text-xs font-medium mb-1">Username *</label>
              <input id="usr-uname" required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label htmlFor="usr-role" className="block text-xs font-medium mb-1">Role *</label>
              <select id="usr-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })} className={inputClass}>
                {Object.values(UserRole).map((r) => (
                  <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="usr-name" className="block text-xs font-medium mb-1">Full Name *</label>
            <input id="usr-name" required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} className={inputClass} />
          </div>
          <div>
            <label htmlFor="usr-email" className="block text-xs font-medium mb-1">Email *</label>
            <input id="usr-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputClass} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="usr-branch" className="block text-xs font-medium mb-1">Assigned Branch</label>
              <select id="usr-branch" value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })} className={inputClass}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="usr-pass" className="block text-xs font-medium mb-1">Temporary Password *</label>
              <input id="usr-pass" type="password" minLength={6} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className={inputClass} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setModalOpen(false)} className={btnSecondaryClass}>Cancel</button>
            <button type="submit" className={btnPrimaryClass}>Create Account</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// ============================================================================
// SYNCHRONIZATION & CONFLICT RESOLUTION PAGE
// ============================================================================
export function SyncPage() {
  const { hasPermission } = useAuth();
  const {
    isOnline,
    setOfflineSimulated,
    isSyncing,
    pendingOutboxCount,
    browserQueueCount,
    triggerSyncNow,
    lastSyncMessage,
  } = useSync();

  const [outbox, setOutbox] = useState<
    Array<{
      operationId: string;
      sequenceNo: number;
      branchName: string;
      type: string;
      status: string;
      retryCount: number;
      nextRetryAt: string | null;
      lastError: string | null;
      createdAt: string;
      syncedAt: string | null;
    }>
  >([]);
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [totalAcknowledged, setTotalAcknowledged] = useState(0);
  const [loading, setLoading] = useState(true);

  const loadSync = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{
        outbox: typeof outbox;
        conflicts: ConflictRecord[];
        totalAcknowledged: number;
      }>('/sync/status');
      setOutbox(res.outbox);
      setConflicts(res.conflicts);
      setTotalAcknowledged(res.totalAcknowledged);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSync();
  }, [loadSync]);

  const handleResolveConflict = async (id: string) => {
    await apiRequest(`/sync/conflicts/${id}/resolve`, { method: 'POST' });
    await loadSync();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bidirectional Synchronization & Conflict Center"
        subtitle="Transactional outbox, idempotency key tracking, exponential backoff retries, and deterministic conflict resolution."
        actions={
          <>
            <button
              type="button"
              onClick={() => setOfflineSimulated(isOnline)}
              className={btnSecondaryClass}
            >
              {isOnline ? <WifiOff className="w-4 h-4" /> : <Wifi className="w-4 h-4" />}
              <span>{isOnline ? 'Simulate Outage' : 'Restore Connectivity'}</span>
            </button>
            {hasPermission('sync:manage') && (
              <button
                type="button"
                disabled={!isOnline || isSyncing}
                onClick={() => void triggerSyncNow().then(loadSync)}
                className={btnPrimaryClass}
              >
                <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
                <span>{isSyncing ? 'Synchronizing...' : 'Run Bidirectional Sync'}</span>
              </button>
            )}
          </>
        }
      />

      {lastSyncMessage && <AlertBanner tone="success" message={lastSyncMessage} />}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiStatCard label="Pending Outbox Ops" value={pendingOutboxCount} meta={`Browser IndexedDB: ${browserQueueCount}`} tone={pendingOutboxCount > 0 ? 'warning' : 'success'} />
        <KpiStatCard label="Idempotent Acks" value={totalAcknowledged} meta="Zero duplicates guaranteed" tone="primary" />
        <KpiStatCard label="Open Conflicts" value={conflicts.filter((c) => !c.resolved).length} meta="Deterministic rules applied" tone={conflicts.some((c) => !c.resolved) ? 'danger' : 'success'} />
        <KpiStatCard label="Connectivity State" value={isOnline ? 'ONLINE' : 'OFFLINE'} meta="72h offline POS resilience" tone={isOnline ? 'success' : 'warning'} />
      </div>

      {/* Deterministic Conflict Resolution Rules */}
      <section className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5">
        <h2 className="text-sm font-bold text-slate-900 dark:text-white mb-3">
          Deterministic Conflict Resolution Matrix
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 text-xs">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
            <p className="font-bold text-slate-900 dark:text-slate-100">1. Old Price Sale</p>
            <p className="mt-1 text-slate-600 dark:text-slate-400">
              Preserves the original POS sale price for fiscal receipt integrity and logs the price variance for Head Office reporting.
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
            <p className="font-bold text-slate-900 dark:text-slate-100">2. Negative Stock After Sync</p>
            <p className="mt-1 text-slate-600 dark:text-slate-400">
              Clamps sellable inventory safely and automatically generates an open physical stock-count task for the branch.
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
            <p className="font-bold text-slate-900 dark:text-slate-100">3. Offline Post-Recall Sale</p>
            <p className="mt-1 text-slate-600 dark:text-slate-400">
              Compares sale timestamp against central recall timestamp and raises a CRITICAL pharmacovigilance alert for follow-up.
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
            <p className="font-bold text-slate-900 dark:text-slate-100">4. Duplicate Operation ID</p>
            <p className="mt-1 text-slate-600 dark:text-slate-400">
              Checks Head Office idempotency ack table; safely rejects duplicate replay without duplicating sales or stock deductions.
            </p>
          </div>
        </div>
      </section>

      {loading ? (
        <LoadingState />
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
          {/* Transactional Outbox */}
          <section className="xl:col-span-7 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Branch Transactional Outbox</h2>
            </div>
            {outbox.length === 0 ? (
              <div className="p-6">
                <EmptyState title="Outbox empty" description="Branch operations will be logged here with sequence numbers and idempotency keys." />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                      <th className="py-2.5 px-4">Seq / Operation ID</th>
                      <th className="py-2.5 px-3">Branch</th>
                      <th className="py-2.5 px-3">Type</th>
                      <th className="py-2.5 px-3 text-right">Retries</th>
                      <th className="py-2.5 px-4">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                    {outbox.map((o) => (
                      <tr key={o.operationId}>
                        <td className="py-2.5 px-4 font-mono">
                          <span className="font-bold text-slate-900 dark:text-slate-100">#{o.sequenceNo}</span>{' '}
                          <span className="text-slate-500">{o.operationId.slice(0, 22)}</span>
                        </td>
                        <td className="py-2.5 px-3 text-slate-700 dark:text-slate-300">{o.branchName}</td>
                        <td className="py-2.5 px-3 font-mono">{o.type}</td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums">{o.retryCount}</td>
                        <td className="py-2.5 px-4">
                          <StatusText
                            status={o.status === 'SYNCED' ? 'nominal' : o.status === 'FAILED' ? 'danger' : 'warning'}
                            label={o.status}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Conflict Log */}
          <section className="xl:col-span-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Conflict Resolution Audit Log</h2>
            </div>
            {conflicts.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title="No conflicts detected"
                  description="Synchronize Northgate branch (which holds a seeded offline sale at an older price) to observe deterministic conflict resolution."
                />
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {conflicts.map((c) => (
                  <div key={c.id} className="p-4 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <StatusText
                        status={c.severity === 'CRITICAL' || c.severity === 'HIGH' ? 'danger' : 'warning'}
                        label={`${c.type} · ${c.severity}`}
                      />
                      {c.resolved ? (
                        <StatusText status="nominal" label="Reviewed" />
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleResolveConflict(c.id)}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Mark Resolved</span>
                        </button>
                      )}
                    </div>
                    <p className="text-xs font-medium text-slate-900 dark:text-slate-100">{c.summary}</p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">{c.resolutionRule}</p>
                    <p className="text-[11px] font-mono text-slate-400">
                      {c.branchName} · Op {c.operationId}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// SETTINGS, OBSERVABILITY & OPENAPI PAGE
// ============================================================================
export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [metrics, setMetrics] = useState<Record<string, unknown> | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);

  useEffect(() => {
    Promise.all([
      apiRequest<Record<string, unknown>>('/actuator/ready'),
      apiRequest<Record<string, unknown>>('/actuator/metrics'),
      apiRequest<{ items: AuditLogEntry[] }>('/audit-logs'),
    ])
      .then(([h, m, a]) => {
        setHealth(h);
        setMetrics(m);
        setAuditLogs(a.items);
      })
      .catch(() => {});
  }, []);

  const handleDownloadOpenApi = async () => {
    const spec = await apiRequest<Record<string, unknown>>('/openapi.json');
    const blob = new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pharmasync-openapi-3.1.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="System Settings & Observability"
        subtitle="Theme preferences, thermal printer adapter, Actuator readiness & metrics, OpenAPI 3.1 contract, and security audit log."
        actions={
          <button type="button" onClick={() => void handleDownloadOpenApi()} className={btnSecondaryClass}>
            <Download className="w-4 h-4" />
            <span>Download OpenAPI 3.1 JSON</span>
          </button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Theme & Adapter Preferences */}
        <section className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 space-y-4">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">Display & Hardware Adapters</h2>

          <div className="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-800">
            <div>
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">Interface Theme</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">Persisted locally with zero-flash initial load</p>
            </div>
            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
              <button
                type="button"
                onClick={() => setTheme('light')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer ${
                  theme === 'light' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'
                }`}
              >
                <Sun className="w-3.5 h-3.5" />
                <span>Day</span>
              </button>
              <button
                type="button"
                onClick={() => setTheme('dark')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer ${
                  theme === 'dark' ? 'bg-slate-900 text-white shadow-xs' : 'text-slate-500'
                }`}
              >
                <Moon className="w-3.5 h-3.5" />
                <span>Night</span>
              </button>
            </div>
          </div>

          <div className="py-1">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">Receipt Printer Adapter</p>
            <p className="text-xs font-mono text-slate-500 dark:text-slate-400 mt-1">{receiptPrinter.adapterName}</p>
          </div>

          <div className="py-1">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">Navigation Shortcuts</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Use <span className="font-mono font-semibold">Alt + Left Arrow</span> to go back and{' '}
              <span className="font-mono font-semibold">Alt + Right Arrow</span> to go forward through real browser history.
            </p>
          </div>
        </section>

        {/* Actuator Health & Metrics */}
        <section className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-700 dark:text-blue-400" />
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Actuator Readiness & Metrics</h2>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
              <p className="text-slate-500">Readiness Probe</p>
              <p className="font-mono font-bold text-emerald-700 dark:text-emerald-400 mt-1">
                {String(health?.status ?? 'CHECKING')}
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
              <p className="text-slate-500">POS Checkout p95</p>
              <p className="font-mono font-bold text-slate-900 dark:text-white mt-1 tabular-nums">
                {String(metrics?.posCheckoutP95Ms ?? 0)} ms (Target &lt;300ms)
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
              <p className="text-slate-500">API Requests Served</p>
              <p className="font-mono font-bold text-slate-900 dark:text-white mt-1 tabular-nums">
                {String(metrics?.httpRequestsTotal ?? 0)}
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
              <p className="text-slate-500">Process Memory RSS</p>
              <p className="font-mono font-bold text-slate-900 dark:text-white mt-1 tabular-nums">
                {String(metrics?.memoryUsageMb ?? 0)} MB
              </p>
            </div>
          </div>
        </section>
      </div>

      {/* Security & Operational Audit Log */}
      <section className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">Security & Trace Audit Log</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                <th className="py-2.5 px-5">Timestamp</th>
                <th className="py-2.5 px-3">Trace ID</th>
                <th className="py-2.5 px-3">Actor</th>
                <th className="py-2.5 px-3">Action</th>
                <th className="py-2.5 px-5">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {auditLogs.slice(0, 20).map((log) => (
                <tr key={log.id}>
                  <td className="py-2.5 px-5 font-mono text-slate-500 whitespace-nowrap">
                    {new Date(log.createdAt).toLocaleString()}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-slate-500">{log.traceId}</td>
                  <td className="py-2.5 px-3 font-medium text-slate-900 dark:text-slate-100">
                    {log.actorName} ({log.actorRole})
                  </td>
                  <td className="py-2.5 px-3 font-mono font-semibold text-blue-700 dark:text-blue-400">{log.action}</td>
                  <td className="py-2.5 px-5 text-slate-600 dark:text-slate-300">{log.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
