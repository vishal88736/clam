'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { usePathname } from 'next/navigation';
import type {
  AgentRunStep,
  AgentRunSummary,
  AuditLogEntry,
  KillSwitchState,
  TrapPackReport,
} from '@clam/shared';
import type { ClamMascotState } from './ClamMascot';
import { API_BASE, clamApi, type OverviewResponse } from '@/lib/api';

interface ConsoleContextValue {
  overview: OverviewResponse | null;
  liveFeed: AuditLogEntry[];
  killSwitch: KillSwitchState | null;
  latestRun: AgentRunSummary | null;
  liveRunSteps: AgentRunStep[];
  trapReport: TrapPackReport | null;
  sseConnected: boolean;
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  refreshOverview: () => Promise<void>;
  lastEventTick: number;
  mascotState: ClamMascotState;
  pulseMascot: (state: ClamMascotState, durationMs?: number) => void;
  setLatestRun: React.Dispatch<React.SetStateAction<AgentRunSummary | null>>;
  setTrapReport: React.Dispatch<React.SetStateAction<TrapPackReport | null>>;
  clearLiveRunSteps: () => void;
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function ConsoleProvider({ children }: { children: React.ReactNode }) {
  const legacyRoute = usePathname() !== '/';
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [liveFeed, setLiveFeed] = useState<AuditLogEntry[]>([]);
  const [killSwitch, setKillSwitch] = useState<KillSwitchState | null>(null);
  const [latestRun, setLatestRun] = useState<AgentRunSummary | null>(null);
  const [liveRunSteps, setLiveRunSteps] = useState<AgentRunStep[]>([]);
  const [trapReport, setTrapReport] = useState<TrapPackReport | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('light');
  const [lastEventTick, setLastEventTick] = useState(0);
  const [rawMascotState, setRawMascotState] = useState<ClamMascotState>('armed');
  const mascotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pulseMascot = useCallback((state: ClamMascotState, durationMs = 2500) => {
    if (mascotTimerRef.current) {
      clearTimeout(mascotTimerRef.current);
      mascotTimerRef.current = null;
    }
    setRawMascotState(state);
    if (state !== 'armed' && state !== 'halted') {
      mascotTimerRef.current = setTimeout(() => {
        setRawMascotState('armed');
        mascotTimerRef.current = null;
      }, durationMs);
    }
  }, []);

  const clearLiveRunSteps = useCallback(() => {
    setLiveRunSteps([]);
  }, []);

  const refreshOverview = useCallback(async () => {
    try {
      const [ov, audit] = await Promise.all([
        clamApi.getOverview(),
        clamApi.getAuditLogs({ limit: 40 }),
      ]);
      setOverview(ov);
      setLiveFeed(audit.logs);
      if (ov.kill_switch) setKillSwitch(ov.kill_switch);
      if (ov.latest_run) setLatestRun(ov.latest_run);
      if (ov.latest_trap_report) setTrapReport(ov.latest_trap_report);
    } catch {
      // Server may still be starting up; SSE reconnect handles recovery
    }
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem('clam_theme');
    const initial = saved === 'dark' ? 'dark' : 'light';
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
    if (legacyRoute) void refreshOverview();
  }, [legacyRoute, refreshOverview]);

  useEffect(() => {
    if (!legacyRoute) return;
    const es = new EventSource(`${API_BASE}/api/events/stream`);

    es.addEventListener('connected', () => {
      setSseConnected(true);
    });

    es.addEventListener('killswitch.changed', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as { data: KillSwitchState };
        if (parsed?.data) {
          setKillSwitch(parsed.data);
          setLastEventTick((t) => t + 1);
          if (parsed.data.status === 'HALTED') {
            setRawMascotState('halted');
          } else {
            setRawMascotState('armed');
          }
          void clamApi.getOverview().then(setOverview).catch(() => {});
        }
      } catch {
        // ignore
      }
    });

    es.addEventListener('agent.run.step', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as {
          data?: { run_id?: string; step?: AgentRunStep };
        };
        if (parsed?.data?.step) {
          const st = parsed.data.step;
          setLiveRunSteps((prev) => {
            if (st.step === 1) return [st];
            return [...prev, st];
          });
        }
      } catch {
        // ignore
      }
    });

    const handleRunFinished = (event: Event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as { data?: AgentRunSummary };
        if (parsed?.data) {
          setLatestRun(parsed.data);
        }
      } catch {
        // ignore
      }
      setLastEventTick((t) => t + 1);
      void clamApi.getOverview().then(setOverview).catch(() => {});
    };

    es.addEventListener('agent.run.completed', handleRunFinished);
    es.addEventListener('agent.run.aborted', handleRunFinished);

    es.addEventListener('trappack.completed', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as { data?: TrapPackReport };
        if (parsed?.data) {
          setTrapReport(parsed.data);
        }
      } catch {
        // ignore
      }
      setLastEventTick((t) => t + 1);
      void clamApi.getOverview().then(setOverview).catch(() => {});
    });

    es.addEventListener('audit.entry', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as { data: AuditLogEntry };
        if (parsed?.data) {
          const entry = parsed.data;
          setLiveFeed((prev) => [entry, ...prev].slice(0, 60));
          setLastEventTick((t) => t + 1);

          if (
            entry.decision === 'KILL_SWITCH_ENGAGED' ||
            entry.decision === 'CIRCUIT_BREAKER_TRIPPED'
          ) {
            pulseMascot('halted', 2500);
          } else if (entry.decision === 'ALLOW' || entry.decision === 'APPROVED') {
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
  }, [legacyRoute, pulseMascot]);

  const effectiveMascotState: ClamMascotState =
    killSwitch?.status === 'HALTED' ? 'halted' : rawMascotState;

  return (
    <ConsoleContext.Provider
      value={{
        overview,
        liveFeed,
        killSwitch,
        latestRun,
        liveRunSteps,
        trapReport,
        sseConnected,
        theme,
        toggleTheme,
        refreshOverview,
        lastEventTick,
        mascotState: effectiveMascotState,
        pulseMascot,
        setLatestRun,
        setTrapReport,
        clearLiveRunSteps,
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
