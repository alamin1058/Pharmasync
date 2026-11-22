import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';

function readHistoryIdx(): number {
  if (typeof window === 'undefined') return 0;
  const state = window.history.state as { idx?: number } | null;
  return typeof state?.idx === 'number' ? state.idx : 0;
}

export function useSmartHistory(fallbackDashboard = '/dashboard') {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();

  const [currentIdx, setCurrentIdx] = useState<number>(() => readHistoryIdx());
  const [maxIdx, setMaxIdx] = useState<number>(() => readHistoryIdx());
  const initialIdxRef = useRef<number>(readHistoryIdx());

  useEffect(() => {
    const idx = readHistoryIdx();
    setCurrentIdx(idx);
    if (navigationType === 'PUSH') {
      // Pushing a new route clears forward browser history
      setMaxIdx(idx);
    } else if (navigationType === 'POP') {
      setMaxIdx((prev) => Math.max(prev, idx));
    } else {
      // REPLACE keeps current index
      setMaxIdx((prev) => Math.max(prev, idx));
    }
  }, [location.key, location.pathname, navigationType]);

  const hasInternalBack = currentIdx > initialIdxRef.current;
  const canGoForward = currentIdx < maxIdx;

  const goBack = useCallback(() => {
    if (hasInternalBack) {
      navigate(-1);
    } else if (location.pathname !== fallbackDashboard) {
      navigate(fallbackDashboard);
    }
  }, [hasInternalBack, navigate, location.pathname, fallbackDashboard]);

  const goForward = useCallback(() => {
    if (canGoForward) {
      navigate(1);
    }
  }, [canGoForward, navigate]);

  // Keyboard shortcuts: Alt + Left Arrow / Alt + Right Arrow
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goBack();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goForward();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goBack, goForward]);

  return {
    goBack,
    goForward,
    hasInternalBack,
    canGoBack: hasInternalBack || location.pathname !== fallbackDashboard,
    canGoForward,
    currentIdx,
    maxIdx,
  };
}
