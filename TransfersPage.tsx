import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, Plus, Truck } from 'lucide-react';
import { apiRequest, ApiError } from '../lib/api';
import { Batch, BatchStatus, Branch, TransferRecord, TransferStatus } from '../shared/types';
import {
  AlertBanner,
  LoadingState,
  Modal,
  PageHeader,
  StatusText,
  btnPrimaryClass,
  btnSecondaryClass,
  inputClass,
} from '../components/UiPrimitives';

interface EnrichedBatch extends Batch {
  medicineName: string;
}

export function TransfersPage() {
  const [transfers, setTransfers] = useState<TransferRecord[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [sourceBatches, setSourceBatches] = useState<EnrichedBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [sourceBranchId, setSourceBranchId] = useState('br-westside');
  const [destinationBranchId, setDestinationBranchId] = useState('br-downtown');
  const [batchId, setBatchId] = useState('');
  const [transferQuantity, setTransferQuantity] = useState('30');
  const [notes, setNotes] = useState('');

  const [receiveTarget, setReceiveTarget] = useState<TransferRecord | null>(null);
  const [receivedQty, setReceivedQty] = useState('');
  const [receiveNotes, setReceiveNotes] = useState('');

  const loadTransfers = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, bRes] = await Promise.all([
        apiRequest<{ items: TransferRecord[] }>('/transfers'),
        apiRequest<{ items: Branch[] }>('/branches'),
      ]);
      setTransfers(tRes.items);
      setBranches(bRes.items.filter((b) => !b.isHeadOffice));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTransfers();
  }, [loadTransfers]);

  useEffect(() => {
    if (!createOpen) return;
    apiRequest<{ items: EnrichedBatch[] }>(`/batches?branchId=${encodeURIComponent(sourceBranchId)}`)
      .then((res) => {
        const eligible = res.items.filter(
          (b) => b.status !== BatchStatus.EXPIRED && b.status !== BatchStatus.RECALLED && b.quantity > 0
        );
        setSourceBatches(eligible);
        if (eligible.length > 0) setBatchId(eligible[0].id);
        else setBatchId('');
      })
      .catch(() => setSourceBatches([]));
  }, [createOpen, sourceBranchId]);

  const handleCreateTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    try {
      const res = await apiRequest<{ transferNumber: string }>('/transfers', {
        method: 'POST',
        body: {
          sourceBranchId,
          destinationBranchId,
          batchId,
          transferQuantity: Number(transferQuantity),
          notes,
        },
      });
      setSuccess(`Dispatched inter-branch transfer ${res.transferNumber}.`);
      setCreateOpen(false);
      setNotes('');
      await loadTransfers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to dispatch transfer.');
    }
  };

  const handleMarkInTransit = async (trf: TransferRecord) => {
    setError(null);
    try {
      await apiRequest(`/transfers/${trf.id}/transition`, {
        method: 'POST',
        body: { nextStatus: TransferStatus.IN_TRANSIT },
      });
      setSuccess(`Transfer ${trf.transferNumber} marked IN_TRANSIT.`);
      await loadTransfers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to advance transfer.');
    }
  };

  const handleConfirmReceive = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!receiveTarget) return;
    setError(null);
    try {
      const res = await apiRequest<{ discrepancyQuantity: number }>(`/transfers/${receiveTarget.id}/transition`, {
        method: 'POST',
        body: {
          nextStatus: TransferStatus.RECEIVED,
          receivedQuantity: Number(receivedQty),
          notes: receiveNotes.trim() || undefined,
        },
      });
      setSuccess(
        `Received ${receiveTarget.transferNumber} (${receivedQty}u; discrepancy ${
          res.discrepancyQuantity >= 0 ? '+' : ''
        }${res.discrepancyQuantity}u).`
      );
      setReceiveTarget(null);
      setReceiveNotes('');
      await loadTransfers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to receive transfer.');
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Branch-to-Branch Transfers"
        subtitle="Controlled inter-branch stock movement enforcing DISPATCHED -> IN_TRANSIT -> RECEIVED states and quantity discrepancy logging."
        actions={
          <button type="button" onClick={() => setCreateOpen(true)} className={btnPrimaryClass}>
            <Plus className="w-4 h-4" />
            <span>Dispatch Transfer</span>
          </button>
        }
      />

      {error && <AlertBanner tone="error" message={error} onDismiss={() => setError(null)} />}
      {success && <AlertBanner tone="success" message={success} onDismiss={() => setSuccess(null)} />}

      {loading ? (
        <LoadingState />
      ) : (
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-5">Transfer #</th>
                  <th className="py-3 px-3">Route</th>
                  <th className="py-3 px-3">Medicine & Batch</th>
                  <th className="py-3 px-3 text-right">Dispatched</th>
                  <th className="py-3 px-3 text-right">Received</th>
                  <th className="py-3 px-3 text-right">Discrepancy</th>
                  <th className="py-3 px-3">State</th>
                  <th className="py-3 px-5 text-right">Workflow Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {transfers.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-3 px-5">
                      <div className="font-mono text-xs font-bold text-slate-900 dark:text-white">{t.transferNumber}</div>
                      <div className="text-[11px] font-mono text-slate-500">{t.dispatchDate.slice(0, 10)}</div>
                    </td>
                    <td className="py-3 px-3 text-xs">
                      <div className="font-medium text-slate-900 dark:text-slate-100">{t.sourceBranchName}</div>
                      <div className="text-slate-500 dark:text-slate-400">to {t.destinationBranchName}</div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-medium text-slate-900 dark:text-slate-100">{t.medicineName}</div>
                      <div className="font-mono text-xs text-slate-500">{t.batchNumber}</div>
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums">{t.transferQuantity}</td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums">
                      {t.receivedQuantity !== null ? t.receivedQuantity : '—'}
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums">
                      {t.status === TransferStatus.RECEIVED ? (
                        <span className={t.discrepancyQuantity !== 0 ? 'text-amber-700 dark:text-amber-400 font-bold' : 'text-emerald-700 dark:text-emerald-400'}>
                          {t.discrepancyQuantity > 0 ? `+${t.discrepancyQuantity}` : t.discrepancyQuantity}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-3 px-3">
                      {t.status === TransferStatus.RECEIVED ? (
                        <StatusText status="nominal" label="Received" />
                      ) : t.status === TransferStatus.IN_TRANSIT ? (
                        <StatusText status="info" label="In Transit" />
                      ) : (
                        <StatusText status="warning" label="Dispatched" />
                      )}
                    </td>
                    <td className="py-3 px-5 text-right">
                      {t.status === TransferStatus.DISPATCHED && (
                        <button
                          type="button"
                          onClick={() => void handleMarkInTransit(t)}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
                        >
                          <Truck className="w-3.5 h-3.5" />
                          <span>Mark In Transit</span>
                        </button>
                      )}
                      {t.status === TransferStatus.IN_TRANSIT && (
                        <button
                          type="button"
                          onClick={() => {
                            setReceiveTarget(t);
                            setReceivedQty(String(t.transferQuantity));
                          }}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Confirm Receipt</span>
                        </button>
                      )}
                      {t.status === TransferStatus.RECEIVED && (
                        <span className="text-xs text-slate-400">Completed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Dispatch Transfer Modal */}
      <Modal open={createOpen} title="Dispatch Inter-Branch Transfer" onClose={() => setCreateOpen(false)}>
        <form onSubmit={handleCreateTransfer} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="trf-src" className="block text-xs font-medium mb-1">Source Branch</label>
              <select id="trf-src" value={sourceBranchId} onChange={(e) => setSourceBranchId(e.target.value)} className={inputClass}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="trf-dest" className="block text-xs font-medium mb-1">Destination Branch</label>
              <select id="trf-dest" value={destinationBranchId} onChange={(e) => setDestinationBranchId(e.target.value)} className={inputClass}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="trf-batch" className="block text-xs font-medium mb-1">Batch (Non-Expired, Non-Recalled)</label>
            <select id="trf-batch" required value={batchId} onChange={(e) => setBatchId(e.target.value)} className={inputClass}>
              {sourceBatches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.medicineName} — {b.batchNumber} (Avail: {b.quantity}u · Exp {b.expiryDate})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="trf-qty" className="block text-xs font-medium mb-1">Transfer Quantity (Base Units) *</label>
            <input id="trf-qty" type="number" min="1" required value={transferQuantity} onChange={(e) => setTransferQuantity(e.target.value)} className={`${inputClass} font-mono`} />
          </div>
          <div>
            <label htmlFor="trf-notes" className="block text-xs font-medium mb-1">Dispatch Notes</label>
            <input id="trf-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional courier or cold-chain notes" className={inputClass} />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setCreateOpen(false)} className={btnSecondaryClass}>Cancel</button>
            <button type="submit" disabled={!batchId} className={btnPrimaryClass}>
              <ArrowRightLeft className="w-4 h-4" />
              <span>Dispatch</span>
            </button>
          </div>
        </form>
      </Modal>

      {/* Confirm Receive Modal */}
      <Modal open={Boolean(receiveTarget)} title={`Receive Transfer — ${receiveTarget?.transferNumber ?? ''}`} onClose={() => setReceiveTarget(null)}>
        {receiveTarget && (
          <form onSubmit={handleConfirmReceive} className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Dispatched quantity: <strong className="font-mono">{receiveTarget.transferQuantity}</strong> units of{' '}
              <strong>{receiveTarget.medicineName}</strong> (Batch <span className="font-mono">{receiveTarget.batchNumber}</span>).
            </p>
            <div>
              <label htmlFor="trf-rcv-qty" className="block text-xs font-medium mb-1">Received Quantity *</label>
              <input id="trf-rcv-qty" type="number" min="0" required value={receivedQty} onChange={(e) => setReceivedQty(e.target.value)} className={`${inputClass} font-mono`} />
            </div>
            <div>
              <label htmlFor="trf-rcv-notes" className="block text-xs font-medium mb-1">Discrepancy / Inspection Notes</label>
              <input id="trf-rcv-notes" value={receiveNotes} onChange={(e) => setReceiveNotes(e.target.value)} placeholder="Log any damaged or missing units" className={inputClass} />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setReceiveTarget(null)} className={btnSecondaryClass}>Cancel</button>
              <button type="submit" className={btnPrimaryClass}>Confirm Receipt</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
