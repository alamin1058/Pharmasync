import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Edit3, Plus, Search } from 'lucide-react';
import { apiRequest, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Medicine } from '../shared/types';
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

const EMPTY_FORM = {
  genericName: '',
  brandName: '',
  strength: '500 mg',
  dosageForm: 'Tablet',
  manufacturer: '',
  barcode: '',
  category: 'Antibiotics',
  purchasePrice: '0.20',
  sellingPrice: '0.40',
  tabletsPerStrip: '10',
  stripsPerBox: '3',
  prescriptionOnly: false,
  active: true,
  leadTimeDays: '5',
  safetyStock: '100',
};

export function MedicinesPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('medicines:write');

  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [rxFilter, setRxFilter] = useState<'ALL' | 'RX' | 'OTC'>('ALL');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Medicine | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadMedicines = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ items: Medicine[] }>('/medicines');
      setMedicines(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load medicine catalogue.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMedicines();
  }, [loadMedicines]);

  const categories = useMemo(
    () => ['ALL', ...Array.from(new Set(medicines.map((m) => m.category))).sort()],
    [medicines]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return medicines.filter((m) => {
      if (categoryFilter !== 'ALL' && m.category !== categoryFilter) return false;
      if (rxFilter === 'RX' && !m.prescriptionOnly) return false;
      if (rxFilter === 'OTC' && m.prescriptionOnly) return false;
      if (!q) return true;
      return `${m.brandName} ${m.genericName} ${m.barcode} ${m.manufacturer} ${m.strength}`.toLowerCase().includes(q);
    });
  }, [medicines, search, categoryFilter, rxFilter]);

  const openCreate = () => {
    setEditing(null);
    setForm({
      ...EMPTY_FORM,
      barcode: `8901101${Math.floor(100000 + Math.random() * 899999)}`,
    });
    setModalOpen(true);
  };

  const openEdit = (med: Medicine) => {
    setEditing(med);
    setForm({
      genericName: med.genericName,
      brandName: med.brandName,
      strength: med.strength,
      dosageForm: med.dosageForm,
      manufacturer: med.manufacturer,
      barcode: med.barcode,
      category: med.category,
      purchasePrice: String(med.purchasePrice),
      sellingPrice: String(med.sellingPrice),
      tabletsPerStrip: String(med.packHierarchy.tabletsPerStrip),
      stripsPerBox: String(med.packHierarchy.stripsPerBox),
      prescriptionOnly: med.prescriptionOnly,
      active: med.active,
      leadTimeDays: String(med.leadTimeDays),
      safetyStock: String(med.safetyStock),
    });
    setModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      const payload = {
        ...form,
        purchasePrice: Number(form.purchasePrice),
        sellingPrice: Number(form.sellingPrice),
        tabletsPerStrip: Number(form.tabletsPerStrip),
        stripsPerBox: Number(form.stripsPerBox),
        leadTimeDays: Number(form.leadTimeDays),
        safetyStock: Number(form.safetyStock),
      };

      if (editing) {
        await apiRequest(`/medicines/${editing.id}`, { method: 'PUT', body: payload });
        setSuccess(`Updated ${form.brandName} (central catalogue version incremented & synced to online branches).`);
      } else {
        await apiRequest('/medicines', { method: 'POST', body: payload });
        setSuccess(`Added ${form.brandName} to central catalogue.`);
      }
      setModalOpen(false);
      await loadMedicines();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to save medicine.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Medicine Catalogue"
        subtitle="Central formulary with box-strip-tablet pack conversions, central pricing, and prescription classification."
        actions={
          canWrite ? (
            <button type="button" onClick={openCreate} className={btnPrimaryClass}>
              <Plus className="w-4 h-4" />
              <span>Add Medicine</span>
            </button>
          ) : undefined
        }
      />

      {error && <AlertBanner tone="error" message={error} onDismiss={() => setError(null)} />}
      {success && <AlertBanner tone="success" message={success} onDismiss={() => setSuccess(null)} />}

      {/* Filter Bar */}
      <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search generic, brand, barcode, or manufacturer..."
            aria-label="Search medicines"
            className={`${inputClass} pl-9`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Filter by category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200"
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {c === 'ALL' ? 'All Categories' : c}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
            {(['ALL', 'RX', 'OTC'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setRxFilter(tab)}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  rxFilter === tab
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {tab === 'ALL' ? 'All' : tab === 'RX' ? 'Rx Only' : 'OTC'}
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
                  <th className="py-3 px-5">Medicine</th>
                  <th className="py-3 px-3">Barcode</th>
                  <th className="py-3 px-3">Pack Hierarchy</th>
                  <th className="py-3 px-3">Class</th>
                  <th className="py-3 px-3 text-right">Purchase</th>
                  <th className="py-3 px-3 text-right">Selling</th>
                  <th className="py-3 px-3">Status</th>
                  {canWrite && <th className="py-3 px-5 text-right">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {filtered.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-3 px-5">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {m.brandName} <span className="font-normal text-slate-500">{m.strength}</span>
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {m.genericName} · {m.dosageForm} · {m.manufacturer}
                      </div>
                    </td>
                    <td className="py-3 px-3 font-mono text-xs text-slate-600 dark:text-slate-300">{m.barcode}</td>
                    <td className="py-3 px-3 font-mono text-xs text-slate-600 dark:text-slate-300">
                      1 Box = {m.packHierarchy.stripsPerBox} Strip ={' '}
                      {m.packHierarchy.stripsPerBox * m.packHierarchy.tabletsPerStrip} {m.dosageForm}
                    </td>
                    <td className="py-3 px-3">
                      <div className="text-xs text-slate-700 dark:text-slate-300">{m.category}</div>
                      <StatusText status={m.prescriptionOnly ? 'info' : 'muted'} label={m.prescriptionOnly ? 'Rx Only' : 'OTC'} />
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400">
                      ${m.purchasePrice.toFixed(2)}
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-white">
                      ${m.sellingPrice.toFixed(2)}
                    </td>
                    <td className="py-3 px-3">
                      <StatusText status={m.active ? 'nominal' : 'muted'} label={m.active ? `Active · v${m.version}` : 'Inactive'} />
                    </td>
                    {canWrite && (
                      <td className="py-3 px-5 text-right">
                        <button
                          type="button"
                          onClick={() => openEdit(m)}
                          aria-label={`Edit ${m.brandName}`}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          <span>Edit</span>
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        open={modalOpen}
        title={editing ? `Edit Medicine — ${editing.brandName}` : 'Add Medicine to Central Catalogue'}
        onClose={() => setModalOpen(false)}
        maxWidth="max-w-2xl"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="med-brand" className="block text-xs font-medium mb-1">Brand Name *</label>
              <input id="med-brand" required value={form.brandName} onChange={(e) => setForm({ ...form, brandName: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label htmlFor="med-generic" className="block text-xs font-medium mb-1">Generic Name *</label>
              <input id="med-generic" required value={form.genericName} onChange={(e) => setForm({ ...form, genericName: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label htmlFor="med-strength" className="block text-xs font-medium mb-1">Strength</label>
              <input id="med-strength" value={form.strength} onChange={(e) => setForm({ ...form, strength: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label htmlFor="med-form" className="block text-xs font-medium mb-1">Dosage Form</label>
              <input id="med-form" value={form.dosageForm} onChange={(e) => setForm({ ...form, dosageForm: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label htmlFor="med-mfg" className="block text-xs font-medium mb-1">Manufacturer</label>
              <input id="med-mfg" value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label htmlFor="med-barcode" className="block text-xs font-medium mb-1">Barcode *</label>
              <input id="med-barcode" required value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} className={`${inputClass} font-mono`} />
            </div>
            <div>
              <label htmlFor="med-cat" className="block text-xs font-medium mb-1">Category</label>
              <input id="med-cat" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputClass} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="med-buy" className="block text-xs font-medium mb-1">Purchase ($)</label>
                <input id="med-buy" type="number" step="0.01" min="0.01" required value={form.purchasePrice} onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })} className={`${inputClass} font-mono`} />
              </div>
              <div>
                <label htmlFor="med-sell" className="block text-xs font-medium mb-1">Selling ($)</label>
                <input id="med-sell" type="number" step="0.01" min="0.01" required value={form.sellingPrice} onChange={(e) => setForm({ ...form, sellingPrice: e.target.value })} className={`${inputClass} font-mono`} />
              </div>
            </div>
            <div>
              <label htmlFor="med-tps" className="block text-xs font-medium mb-1">Units per Strip</label>
              <input id="med-tps" type="number" min="1" value={form.tabletsPerStrip} onChange={(e) => setForm({ ...form, tabletsPerStrip: e.target.value })} className={`${inputClass} font-mono`} />
            </div>
            <div>
              <label htmlFor="med-spb" className="block text-xs font-medium mb-1">Strips per Box</label>
              <input id="med-spb" type="number" min="1" value={form.stripsPerBox} onChange={(e) => setForm({ ...form, stripsPerBox: e.target.value })} className={`${inputClass} font-mono`} />
            </div>
            <div>
              <label htmlFor="med-lead" className="block text-xs font-medium mb-1">Supplier Lead Time (Days)</label>
              <input id="med-lead" type="number" min="1" value={form.leadTimeDays} onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value })} className={`${inputClass} font-mono`} />
            </div>
            <div>
              <label htmlFor="med-safety" className="block text-xs font-medium mb-1">Safety Stock (Units)</label>
              <input id="med-safety" type="number" min="0" value={form.safetyStock} onChange={(e) => setForm({ ...form, safetyStock: e.target.value })} className={`${inputClass} font-mono`} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6 pt-2">
            <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={form.prescriptionOnly}
                onChange={(e) => setForm({ ...form, prescriptionOnly: e.target.checked })}
                className="rounded border-slate-300"
              />
              <span>Prescription-Only (Rx Required at POS)</span>
            </label>
            <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
                className="rounded border-slate-300"
              />
              <span>Active in Formulary</span>
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
            <button type="button" onClick={() => setModalOpen(false)} className={btnSecondaryClass}>Cancel</button>
            <button type="submit" disabled={saving} className={btnPrimaryClass}>
              {saving ? 'Saving...' : editing ? 'Update Central Record' : 'Create Medicine'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
