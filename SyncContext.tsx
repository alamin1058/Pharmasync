import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiRequest } from '../lib/api';
import { listOfflineOutboxSales, removeOfflineOutboxSale } from '../lib/offlineStore';
import { useAuth } from './AuthContext';

interface SyncContextValue {
  isOfflineSimulated: boolean;
  isOnline: boolean;
  setOfflineSimulated: (offline: boolean) => void;
  pendingOutboxCount: number;
  browserQueueCount: number;
  unresolvedConflicts: number;
  isSyncing: boolean;
  lastSyncedAt: string | null;
  lastSyncMessage: string | null;
  refreshSyncCounters: () => Promise<void>;
  triggerSyncNow: (branchId?: string) => Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { user, activeBranchId } = useAuth();
  const [navigatorOnline, setNavigatorOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [isOfflineSimulated, setOfflineSimulated] = useState(false);
  const [pendingOutboxCount, setPendingOutboxCount] = useState(0);
  const [browserQueueCount, setBrowserQueueCount] = useState(0);
  const [unresolvedConflicts, setUnresolvedConflicts] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [lastSyncMessage, setLastSyncMessage] = useState<string | null>(null);

  const isOnline = navigatorOnline && !isOfflineSimulated;

  useEffect(() => {
    const onOnline = () => setNavigatorOnline(true);
    const onOffline = () => setNavigatorOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const refreshSyncCounters = useCallback(async () => {
    const localQueue = await listOfflineOutboxSales();
    setBrowserQueueCount(localQueue.length);

    if (!user) return;
    try {
      const data = await apiRequest<{
        outbox: Array<{ status: string }>;
        conflicts: Array<{ resolved: boolean }>;
      }>('/sync/status');
      const serverPending = data.outbox.filter((o) => o.status === 'PENDING' || o.status === 'FAILED').length;
      setPendingOutboxCount(serverPending + localQueue.length);
      setUnresolvedConflicts(data.conflicts.filter((c) => !c.resolved).length);
    } catch {
      setPendingOutboxCount(localQueue.length);
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      void refreshSyncCounters();
    }
  }, [user, refreshSyncCounters]);

  const triggerSyncNow = useCallback(
    async (branchId?: string) => {
      if (!user || !isOnline || isSyncing) return;
      setIsSyncing(true);
      setLastSyncMessage(null);
      try {
        // Step 1: Flush browser IndexedDB offline sales queue to branch POS API idempotently
        const queued = await listOfflineOutboxSales();
        let flushedBrowser = 0;
        for (const item of queued) {
          try {
            await apiRequest('/pos/sales', {
              method: 'POST',
              body: { ...item.payload, offlineMode: false },
            });
            await removeOfflineOutboxSale(item.operationId);
            flushedBrowser++;
          } catch {
            // Keep in IndexedDB outbox for exponential backoff retry
          }
        }

        // Step 2: Run server-side bidirectional Branch <-> Head Office synchronization
        const res = await apiRequest<{
          summaries: Array<{
            branchId: string;
            acknowledgedOperations: number;
            pulledRecalls: number;
            pulledMedicines: number;
            conflictsDetected: unknown[];
            durationMs: number;
          }>;
        }>('/sync/run', {
          method: 'POST',
          body: { branchId: branchId || 'ALL' },
        });

        const totalAcked = res.summaries.reduce((s, x) => s + x.acknowledgedOperations, 0) + flushedBrowser;
        const totalRecalls = res.summaries.reduce((s, x) => s + x.pulledRecalls, 0);
        const totalConflicts = res.summaries.reduce((s, x) => s + x.conflictsDetected.length, 0);
        setLastSyncedAt(new Date().toISOString());
        setLastSyncMessage(
          `Synced ${totalAcked} ops · ${totalRecalls} recall updates · ${totalConflicts} conflicts detected`
        );
        await refreshSyncCounters();
      } catch (err) {
        setLastSyncMessage(err instanceof Error ? err.message : 'Sync interrupted — will retry');
      } finally {
        setIsSyncing(false);
      }
    },
    [user, isOnline, isSyncing, refreshSyncCounters]
  );

  // Sync active branch connectivity flag with server when toggled online/offline
  useEffect(() => {
    if (!user || !activeBranchId || !user.permissions.includes('sync:manage')) return;
    apiRequest(`/branches/${activeBranchId}/connectivity`, {
      method: 'PATCH',
      body: { online: isOnline },
    }).catch(() => {});
  }, [isOnline, activeBranchId, user]);

  return (
    <SyncContext.Provider
      value={{
        isOfflineSimulated,
        isOnline,
        setOfflineSimulated,
        pendingOutboxCount,
        browserQueueCount,
        unresolvedConflicts,
        isSyncing,
        lastSyncedAt,
        lastSyncMessage,
        refreshSyncCounters,
        triggerSyncNow,
      }}
    >
      {children}
    </SyncContext.Provider>
  );
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used within SyncProvider');
  return ctx;
}
