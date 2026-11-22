import React, { useState } from 'react';
import { Lock, Moon, ShieldCheck, Sun, UserCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { ApiError } from '../lib/api';
import { AlertBanner, btnPrimaryClass, inputClass } from '../components/UiPrimitives';

const ROLE_USERNAMES = [
  { username: 'superadmin', label: 'Super Admin', scope: 'All Branches & RBAC' },
  { username: 'hoadmin', label: 'Head Office Admin', scope: 'Catalogue, Prices & Recalls' },
  { username: 'manager', label: 'Branch Manager', scope: 'Downtown Branch Ops' },
  { username: 'pharmacist', label: 'Pharmacist', scope: 'POS & Prescriptions' },
  { username: 'cashier', label: 'Cashier', scope: 'POS Checkout & Returns' },
  { username: 'inventory', label: 'Inventory Staff', scope: 'Receiving & Transfers' },
];

export function AuthPage() {
  const { initialized, bootstrapAdmin, login } = useAuth();
  const { theme, toggleTheme } = useTheme();

  // First-run setup form
  const [fullName, setFullName] = useState('Dr. Elena Rostova');
  const [email, setEmail] = useState('admin@pharmasync.org');
  const [setupPassword, setSetupPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Login form
  const [username, setUsername] = useState('superadmin');
  const [password, setPassword] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLoginOverride, setShowLoginOverride] = useState(false);

  const handleBootstrap = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (setupPassword.trim().length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (setupPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await bootstrapAdmin({
        fullName: fullName.trim(),
        email: email.trim(),
        password: setupPassword,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to initialize workspace.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError('Please enter your username and password.');
      return;
    }
    setSubmitting(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid username or password.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#0B1120] flex flex-col justify-between">
      {/* Top minimal bar */}
      <div className="px-6 py-4 flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-lg bg-blue-700 dark:bg-blue-600 text-white flex items-center justify-center font-bold text-sm font-display">
            PS
          </span>
          <span className="text-lg font-bold tracking-tight font-display text-slate-900 dark:text-white">
            PharmaSync
          </span>
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
        >
          {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-300" /> : <Moon className="w-4 h-4" />}
          <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
        </button>
      </div>

      {/* Main Centered Split Card */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-12 rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl">
          {/* Left Context Panel */}
          <div className="lg:col-span-5 bg-slate-900 dark:bg-slate-950 text-slate-100 p-8 flex flex-col justify-between">
            <div>
              <p className="text-xs font-semibold text-blue-400 tracking-wide">Enterprise Pharmacy Platform</p>
              <h1 className="mt-3 text-2xl font-bold tracking-tight text-white">
                Offline-First Inventory & Point of Sale
              </h1>
              <p className="mt-3 text-sm text-slate-300 leading-relaxed">
                Engineered for multi-branch pharmacy networks that cannot stop dispensing during 72-hour connectivity outages.
              </p>

              <dl className="mt-8 space-y-4 text-sm">
                <div className="border-t border-slate-800 pt-3">
                  <dt className="font-semibold text-white">FEFO & Safety Guards</dt>
                  <dd className="text-xs text-slate-400 mt-0.5">
                    Automatic First-Expiry-First-Out allocation, zero expired dispensing, and central recall enforcement.
                  </dd>
                </div>
                <div className="border-t border-slate-800 pt-3">
                  <dt className="font-semibold text-white">Resumable Synchronization</dt>
                  <dd className="text-xs text-slate-400 mt-0.5">
                    Transactional outbox with idempotency keys and deterministic conflict reconciliation.
                  </dd>
                </div>
                <div className="border-t border-slate-800 pt-3">
                  <dt className="font-semibold text-white">Role-Based Access Control</dt>
                  <dd className="text-xs text-slate-400 mt-0.5">
                    Six verified pharmacy roles protected with scrypt hashing and server-side JWT authorization.
                  </dd>
                </div>
              </dl>
            </div>

            <div className="mt-8 pt-4 border-t border-slate-800 text-xs text-slate-400">
              Head Office + 3 Retail Branches · Dual SQLite + IndexedDB Outbox
            </div>
          </div>

          {/* Right Form Panel */}
          <div className="lg:col-span-7 p-8">
            {initialized === false && !showLoginOverride ? (
              <div>
                <div className="flex items-center gap-2 text-blue-700 dark:text-blue-400 text-xs font-semibold">
                  <ShieldCheck className="w-4 h-4" />
                  <span>First-Run Workspace Initialization</span>
                </div>
                <h2 className="mt-2 text-xl font-bold text-slate-900 dark:text-white">
                  Claim Super Admin Account
                </h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  Set your initial workspace password to securely initialize the Head Office Super Admin and the six branch staff role accounts.
                </p>

                {error && (
                  <div className="mt-4">
                    <AlertBanner tone="error" message={error} onDismiss={() => setError(null)} />
                  </div>
                )}

                <form onSubmit={handleBootstrap} className="mt-6 space-y-4">
                  <div>
                    <label htmlFor="setup-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Administrator Full Name
                    </label>
                    <input
                      id="setup-name"
                      type="text"
                      required
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="setup-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Administrator Email
                    </label>
                    <input
                      id="setup-email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="setup-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Create Password
                      </label>
                      <input
                        id="setup-password"
                        type="password"
                        required
                        minLength={6}
                        placeholder="Minimum 6 characters"
                        value={setupPassword}
                        onChange={(e) => setSetupPassword(e.target.value)}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label htmlFor="setup-confirm" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Confirm Password
                      </label>
                      <input
                        id="setup-confirm"
                        type="password"
                        required
                        minLength={6}
                        placeholder="Repeat password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        className={inputClass}
                      />
                    </div>
                  </div>

                  <button type="submit" disabled={submitting} className={`${btnPrimaryClass} w-full py-2.5`}>
                    <UserCheck className="w-4 h-4" />
                    <span>{submitting ? 'Initializing Workspace...' : 'Initialize PharmaSync & Sign In'}</span>
                  </button>
                </form>

                <div className="mt-4 text-center">
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setShowLoginOverride(true);
                    }}
                    className="text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-blue-700 dark:hover:text-blue-400 transition-colors cursor-pointer"
                  >
                    Configured an environment admin secret? Sign in directly
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-2 text-blue-700 dark:text-blue-400 text-xs font-semibold">
                  <Lock className="w-4 h-4" />
                  <span>Secure Staff Authentication</span>
                </div>
                <h2 className="mt-2 text-xl font-bold text-slate-900 dark:text-white">Sign in to PharmaSync</h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  Authenticate with your Head Office or Branch staff username and password.
                </p>

                {error && (
                  <div className="mt-4">
                    <AlertBanner tone="error" message={error} onDismiss={() => setError(null)} />
                  </div>
                )}

                <form onSubmit={handleLogin} className="mt-6 space-y-4">
                  <div>
                    <label htmlFor="login-username" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Username or Email
                    </label>
                    <input
                      id="login-username"
                      type="text"
                      required
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="e.g. superadmin, pharmacist, cashier"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="login-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Password
                    </label>
                    <input
                      id="login-password"
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter your staff password"
                      className={inputClass}
                    />
                  </div>

                  <button type="submit" disabled={submitting} className={`${btnPrimaryClass} w-full py-2.5`}>
                    <span>{submitting ? 'Signing in...' : 'Sign In'}</span>
                  </button>
                </form>

                {/* Quick Role Username Selector (selects username only — password still verified by server) */}
                <div className="mt-6 pt-5 border-t border-slate-200 dark:border-slate-800">
                  <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2.5">
                    Select Staff Role Username
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {ROLE_USERNAMES.map((r) => (
                      <button
                        key={r.username}
                        type="button"
                        onClick={() => setUsername(r.username)}
                        className={`text-left px-3 py-2 rounded-lg border text-xs transition-colors cursor-pointer ${
                          username === r.username
                            ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 text-blue-800 dark:text-blue-200'
                            : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/70 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        <span className="block font-semibold truncate">{r.label}</span>
                        <span className="block text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5">
                          {r.username}
                        </span>
                      </button>
                    ))}
                  </div>
                  {initialized === false && (
                    <div className="mt-4 text-center">
                      <button
                        type="button"
                        onClick={() => {
                          setError(null);
                          setShowLoginOverride(false);
                        }}
                        className="text-xs font-medium text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
                      >
                        Back to First-Run Workspace Setup
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="px-6 py-3 text-center text-xs text-slate-500 dark:text-slate-400 border-t border-slate-200 dark:border-slate-800">
        PharmaSync · Multi-Branch Pharmacy Inventory & POS · Open-Source Local-First Edition
      </footer>
    </div>
  );
}
