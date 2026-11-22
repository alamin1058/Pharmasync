import { Batch, Medicine, SaleRecord } from '../shared/types';

const DB_NAME = 'pharmasync_branch_offline_v1';
const DB_VERSION = 1;

export interface OfflineOutboxSale {
  operationId: string;
  branchId: string;
  payload: {
    branchId: string;
    items: Array<{ medicineId: string; quantity: number; packUnit: string }>;
    discountPercent: number;
    paymentMethod: 'CASH' | 'CARD' | 'INSURANCE' | 'MOBILE';
    prescription: SaleRecord['prescription'];
    offlineMode: boolean;
    operationId: string;
  };
  localSalePreview: SaleRecord;
  createdAt: string;
  retryCount: number;
}

// Graceful memory fallback if IndexedDB is blocked in a restricted environment
const memoryFallback = {
  medicines: [] as Medicine[],
  batches: [] as Batch[],
  outbox: [] as OfflineOutboxSale[],
};

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('medicines')) db.createObjectStore('medicines', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('batches')) db.createObjectStore('batches', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'operationId' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cacheBranchCatalogue(medicines: Medicine[], batches: Batch[]): Promise<void> {
  memoryFallback.medicines = medicines;
  memoryFallback.batches = batches;
  const db = await openDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    const tx = db.transaction(['medicines', 'batches'], 'readwrite');
    const medStore = tx.objectStore('medicines');
    const batStore = tx.objectStore('batches');
    medStore.clear();
    batStore.clear();
    for (const m of medicines) medStore.put(m);
    for (const b of batches) batStore.put(b);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function getCachedCatalogue(): Promise<{ medicines: Medicine[]; batches: Batch[] }> {
  const db = await openDb();
  if (!db) return { medicines: memoryFallback.medicines, batches: memoryFallback.batches };

  return new Promise((resolve) => {
    const tx = db.transaction(['medicines', 'batches'], 'readonly');
    const medReq = tx.objectStore('medicines').getAll();
    const batReq = tx.objectStore('batches').getAll();
    tx.oncomplete = () => {
      resolve({
        medicines: (medReq.result as Medicine[]) ?? memoryFallback.medicines,
        batches: (batReq.result as Batch[]) ?? memoryFallback.batches,
      });
    };
    tx.onerror = () => resolve({ medicines: memoryFallback.medicines, batches: memoryFallback.batches });
  });
}

export async function queueOfflineOutboxSale(entry: OfflineOutboxSale): Promise<void> {
  memoryFallback.outbox = [entry, ...memoryFallback.outbox.filter((x) => x.operationId !== entry.operationId)];
  const db = await openDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    const tx = db.transaction(['outbox'], 'readwrite');
    tx.objectStore('outbox').put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function listOfflineOutboxSales(): Promise<OfflineOutboxSale[]> {
  const db = await openDb();
  if (!db) return memoryFallback.outbox;

  return new Promise((resolve) => {
    const tx = db.transaction(['outbox'], 'readonly');
    const req = tx.objectStore('outbox').getAll();
    tx.oncomplete = () => {
      const items = (req.result as OfflineOutboxSale[]) ?? memoryFallback.outbox;
      items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      resolve(items);
    };
    tx.onerror = () => resolve(memoryFallback.outbox);
  });
}

export async function removeOfflineOutboxSale(operationId: string): Promise<void> {
  memoryFallback.outbox = memoryFallback.outbox.filter((x) => x.operationId !== operationId);
  const db = await openDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    const tx = db.transaction(['outbox'], 'readwrite');
    tx.objectStore('outbox').delete(operationId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
