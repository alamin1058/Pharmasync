import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SyncProvider } from './context/SyncContext';
import { Layout } from './components/Layout';
import { LoadingState } from './components/UiPrimitives';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { PosPage } from './pages/PosPage';
import { MedicinesPage } from './pages/MedicinesPage';
import { BatchesPage, InventoryPage } from './pages/InventoryBatchesPage';
import { ReceivingPage } from './pages/ReceivingPage';
import { TransfersPage } from './pages/TransfersPage';
import { PrescriptionsPage, RecallsPage, ReorderingPage } from './pages/ClinicalSafetyPages';
import { ReportsPage } from './pages/ReportsPage';
import { BranchesPage, SettingsPage, SyncPage, UsersRolesPage } from './pages/AdminPages';
import { Permission } from './shared/types';

function ProtectedRoute({ permission, children }: { permission?: Permission; children: React.ReactNode }) {
  const { user, hasPermission } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (permission && !hasPermission(permission)) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0B1120]">
        <LoadingState label="Starting PharmaSync..." />
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<AuthPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/login" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route
          path="/pos"
          element={
            <ProtectedRoute permission="pos:sell">
              <PosPage />
            </ProtectedRoute>
          }
        />
        <Route path="/medicines" element={<MedicinesPage />} />
        <Route path="/inventory" element={<InventoryPage />} />
        <Route path="/batches" element={<BatchesPage />} />
        <Route
          path="/receiving"
          element={
            <ProtectedRoute permission="inventory:write">
              <ReceivingPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/transfers"
          element={
            <ProtectedRoute permission="transfers:manage">
              <TransfersPage />
            </ProtectedRoute>
          }
        />
        <Route path="/prescriptions" element={<PrescriptionsPage />} />
        <Route path="/recalls" element={<RecallsPage />} />
        <Route path="/reordering" element={<ReorderingPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/branches" element={<BranchesPage />} />
        <Route
          path="/users"
          element={
            <ProtectedRoute permission="users:manage">
              <UsersRolesPage />
            </ProtectedRoute>
          }
        />
        <Route path="/sync" element={<SyncPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <SyncProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </SyncProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
