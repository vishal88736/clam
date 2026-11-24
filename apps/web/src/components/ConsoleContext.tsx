'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import type { AuditLogEntry } from '@clam/shared';
import { API_BASE, clamApi, type OverviewResponse } from '@/lib/api';

interface ConsoleContextValue {
  overview: OverviewResponse | null;
  liveFeed: AuditLogEntry[];
  sseConnected: boolean;
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  refreshOverview: () => Promise<void>;
  lastEventTick: number;
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function ConsoleProvider({ children }: { children: React.ReactNode }) {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [liveFeed, setLiveFeed] = useState<AuditLogEntry[]>([]);
  const [sseConnected, setSseConnected] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [lastEventTick, setLastEventTick] = useState(0);

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
          setLiveFeed((prev) => [parsed.data, ...prev].slice(0, 60));
          setLastEventTick((t) => t + 1);
          void clamApi.getOverview().then(setOverview).catch(() => {});
        }
      } catch {
        // ignore parse errors
      }
    });

    const handleRefreshEvent = () => {
      setLastEventTick((t) => t + 1);
      void clamApi.getOverview().then(setOverview).catch(() => {});
    };

    es.addEventListener('approval.created', handleRefreshEvent);
    es.addEventListener('approval.resolved', handleRefreshEvent);
    es.addEventListener('approval.expired', handleRefreshEvent);
    es.addEventListener('agent.updated', handleRefreshEvent);
    es.addEventListener('settings.updated', handleRefreshEvent);

    es.onerror = () => {
      setSseConnected(false);
    };

    return () => {
      es.close();
    };
  }, []);

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
