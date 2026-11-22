import React from 'react';
import { AlertCircle, CheckCircle2, Inbox, Loader2, X } from 'lucide-react';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between pb-5 border-b border-slate-200 dark:border-slate-800">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function KpiStatCard({
  label,
  value,
  meta,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  meta?: string;
  tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
}) {
  const toneClass = {
    neutral: 'text-slate-900 dark:text-slate-50',
    primary: 'text-blue-700 dark:text-blue-400',
    success: 'text-emerald-700 dark:text-emerald-400',
    warning: 'text-amber-700 dark:text-amber-400',
    danger: 'text-red-700 dark:text-red-400',
  }[tone];

  return (
    <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className={`mt-1.5 text-2xl font-bold font-mono tabular-nums tracking-tight ${toneClass}`}>{value}</p>
      {meta && <p className="mt-1 text-xs leading-snug text-slate-500 dark:text-slate-400">{meta}</p>}
    </div>
  );
}

export function StatusText({
  status,
  label,
}: {
  status: 'nominal' | 'warning' | 'danger' | 'info' | 'muted';
  label: string;
}) {
  const classes = {
    nominal: 'text-emerald-700 dark:text-emerald-400 font-semibold',
    warning: 'text-amber-700 dark:text-amber-400 font-semibold',
    danger: 'text-red-700 dark:text-red-400 font-semibold',
    info: 'text-blue-700 dark:text-blue-400 font-semibold',
    muted: 'text-slate-500 dark:text-slate-400 font-medium',
  }[status];

  return <span className={`text-xs whitespace-nowrap ${classes}`}>{label}</span>;
}

export function LoadingState({ label = 'Loading records...' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-14 text-sm text-slate-500 dark:text-slate-400">
      <Loader2 className="w-4 h-4 animate-spin text-blue-600 dark:text-blue-400" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 text-center rounded-xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/40">
      <Inbox className="w-8 h-8 text-slate-400 dark:text-slate-500 mb-3" />
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 max-w-md">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function AlertBanner({
  tone,
  message,
  onDismiss,
}: {
  tone: 'error' | 'success' | 'warning';
  message: string;
  onDismiss?: () => void;
}) {
  const styles = {
    error: 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900 text-red-800 dark:text-red-300',
    success: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300',
    warning: 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-300',
  }[tone];

  return (
    <div role="alert" className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${styles}`}>
      <div className="flex items-start gap-2.5">
        {tone === 'success' ? (
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
        ) : (
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        )}
        <span>{message}</span>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss message"
          className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  maxWidth = 'max-w-lg',
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={`w-full ${maxWidth} rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl max-h-[90vh] flex flex-col`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export const inputClass =
  'w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600/30 focus:border-blue-600 dark:focus:border-blue-500 transition-colors';

export const btnPrimaryClass =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer';

export const btnSecondaryClass =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer';

export const btnDangerClass =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 hover:bg-red-700 px-4 py-2 text-sm font-medium text-white transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer';
