'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { AuditLogEntry } from '@clam/shared';
import type { ClamMascotState } from './ClamMascot';
import { API_BASE, clamApi, type OverviewResponse } from '@/lib/api';

interface ConsoleContextValue {
  overview: OverviewResponse | null;
  liveFeed: AuditLogEntry[];
  sseConnected: boolean;
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  refreshOverview: () => Promise<void>;
  lastEventTick: number;
  mascotState: ClamMascotState;
  pulseMascot: (state: ClamMascotState, durationMs?: number) => void;
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function ConsoleProvider({ children }: { children: React.ReactNode }) {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [liveFeed, setLiveFeed] = useState<AuditLogEntry[]>([]);
  const [sseConnected, setSseConnected] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [lastEventTick, setLastEventTick] = useState(0);
  const [mascotState, setMascotState] = useState<ClamMascotState>('armed');
  const mascotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pulseMascot = useCallback((state: ClamMascotState, durationMs = 2500) => {
    if (mascotTimerRef.current) {
      clearTimeout(mascotTimerRef.current);
      mascotTimerRef.current = null;
    }
    setMascotState(state);
    if (state !== 'armed') {
      mascotTimerRef.current = setTimeout(() => {
        setMascotState('armed');
        mascotTimerRef.current = null;
      }, durationMs);
    }
  }, []);

  const refreshOverview = useCallback(async () => {
    try {
      const [ov, audit] = await Promise.all([
        clamApi.getOverview(),
        clamApi.getAuditLogs({ limit: 40 }),
      ]);
      setOverview(ov);
      setLiveFeed(audit.logs);
    } catch {
      // Server may still be starting up; SSE reconnect handles recovery
    }
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem('clam_theme');
    const initial = saved === 'light' ? 'light' : 'dark';
    setTheme(initial);
    document.documentElement.setAttribute('data-theme', initial);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      window.localStorage.setItem('clam_theme', next);
      return next;
    });
  }, []);

  useEffect(() => {
    void refreshOverview();
  }, [refreshOverview]);

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/events/stream`);

    es.addEventListener('connected', () => {
      setSseConnected(true);
    });

    es.addEventListener('audit.entry', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as { data: AuditLogEntry };
        if (parsed?.data) {
          const entry = parsed.data;
          setLiveFeed((prev) => [entry, ...prev].slice(0, 60));
          setLastEventTick((t) => t + 1);

          if (entry.decision === 'ALLOW' || entry.decision === 'APPROVED') {
            pulseMascot('allow', 2500);
          } else if (
            entry.decision === 'DENY' ||
            entry.decision === 'REJECTED' ||
            entry.decision === 'EXPIRED'
          ) {
            pulseMascot('blocked', 2500);
          } else if (entry.decision === 'PENDING_APPROVAL') {
            pulseMascot('pending', 2500);
          }

          void clamApi.getOverview().then(setOverview).catch(() => {});
        }
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener('approval.created', () => {
      pulseMascot('pending', 2500);
      setLastEventTick((t) => t + 1);
      void clamApi.getOverview().then(setOverview).catch(() => {});
    });

    es.addEventListener('approval.resolved', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as {
          data?: { approval?: { status?: string } };
        };
        const st = parsed?.data?.approval?.status;
        if (st === 'APPROVED') pulseMascot('allow', 2500);
        else if (st === 'REJECTED') pulseMascot('blocked', 2500);
      } catch {
        // ignore
      }
      setLastEventTick((t) => t + 1);
      void clamApi.getOverview().then(setOverview).catch(() => {});
    });

    const handleRefreshEvent = () => {
      setLastEventTick((t) => t + 1);
      void clamApi.getOverview().then(setOverview).catch(() => {});
    };

    es.addEventListener('approval.expired', handleRefreshEvent);
    es.addEventListener('agent.updated', handleRefreshEvent);
    es.addEventListener('settings.updated', handleRefreshEvent);

    es.onerror = () => {
      setSseConnected(false);
    };

    return () => {
      es.close();
      if (mascotTimerRef.current) clearTimeout(mascotTimerRef.current);
    };
  }, [pulseMascot]);

  return (
    <ConsoleContext.Provider
      value={{
        overview,
        liveFeed,
        sseConnected,
        theme,
        toggleTheme,
        refreshOverview,
        lastEventTick,
        mascotState,
        pulseMascot,
      }}
    >
      {children}
    </ConsoleContext.Provider>
  );
}

export function useConsole() {
  const ctx = useContext(ConsoleContext);
  if (!ctx) throw new Error('useConsole must be used inside ConsoleProvider');
  return ctx;
}
