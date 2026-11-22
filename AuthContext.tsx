import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { AuthUser, Permission, UserRole } from '../shared/types';
import { apiRequest, setAuthToken } from '../lib/api';

export type WorkspaceViewMode = 'head_office' | 'branch';

interface AuthContextValue {
  user: AuthUser | null;
  initialized: boolean | null;
  loading: boolean;
  workspaceMode: WorkspaceViewMode;
  activeBranchId: string;
  setWorkspaceMode: (mode: WorkspaceViewMode) => void;
  setActiveBranchId: (branchId: string) => void;
  bootstrapAdmin: (payload: { password: string; fullName: string; email: string }) => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  hasPermission: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceViewMode>('head_office');
  const [activeBranchId, setActiveBranchId] = useState<string>('br-downtown');

  useEffect(() => {
    let mounted = true;
    apiRequest<{ initialized: boolean }>('/auth/status')
      .then((res) => {
        if (mounted) {
          setInitialized(res.initialized);
          setLoading(false);
        }
      })
      .catch(() => {
        if (mounted) {
          setInitialized(true);
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  const applyAuthenticatedUser = useCallback((token: string, nextUser: AuthUser) => {
    setAuthToken(token);
    setUser(nextUser);
    setInitialized(true);
    const isHoRole = nextUser.role === UserRole.SUPER_ADMIN || nextUser.role === UserRole.HEAD_OFFICE_ADMIN;
    setWorkspaceMode(isHoRole ? 'head_office' : 'branch');
    setActiveBranchId(nextUser.branchId === 'br-ho' ? 'br-downtown' : nextUser.branchId);
  }, []);

  const bootstrapAdmin = useCallback(
    async (payload: { password: string; fullName: string; email: string }) => {
      const res = await apiRequest<{ token: string; user: AuthUser }>('/auth/bootstrap', {
        method: 'POST',
        body: payload,
      });
      applyAuthenticatedUser(res.token, res.user);
    },
    [applyAuthenticatedUser]
  );

  const login = useCallback(
    async (username: string, password: string) => {
      const res = await apiRequest<{ token: string; user: AuthUser }>('/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      applyAuthenticatedUser(res.token, res.user);
    },
    [applyAuthenticatedUser]
  );

  const logout = useCallback(() => {
    setAuthToken(null);
    setUser(null);
  }, []);

  const hasPermission = useCallback(
    (permission: Permission) => {
      if (!user) return false;
      return user.permissions.includes(permission);
    },
    [user]
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        initialized,
        loading,
        workspaceMode,
        activeBranchId,
        setWorkspaceMode,
        setActiveBranchId,
        bootstrapAdmin,
        login,
        logout,
        hasPermission,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
