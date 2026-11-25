'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  Bot,
  CheckSquare,
  FileSearch,
  Moon,
  Power,
  Settings,
  ShieldOff,
  Sun,
} from 'lucide-react';
import { ClamMascot } from './ClamMascot';
import { useConsole } from './ConsoleContext';
import { clamApi } from '@/lib/api';

const NAV_ITEMS = [
  { href: '/console', label: 'Overview', icon: Activity },
  { href: '/agents', label: 'Agents & Rules', icon: Bot },
  { href: '/approvals', label: 'Approval Queue', icon: CheckSquare },
  { href: '/audit', label: 'Audit Ledger', icon: FileSearch },
  { href: '/settings', label: 'Connections', icon: Settings },
];

const POSTURE_BADGE: Record<string, { label: string; cls: string }> = {
  armed: {
    label: 'ARMED',
    cls: 'bg-emerald-fill text-emerald-matte border-emerald-matte/30',
  },
  allow: {
    label: 'ALLOWED',
    cls: 'bg-emerald-fill text-emerald-matte border-emerald-matte/30',
  },
  blocked: {
    label: 'BLOCKED',
    cls: 'bg-crimson-fill text-crimson-matte border-crimson-matte/30',
  },
  pending: {
    label: 'ASK FIRST',
    cls: 'bg-amber-fill text-amber-matte border-amber-matte/30',
  },
  halted: {
    label: 'HALTED',
    cls: 'bg-crimson-fill text-crimson-matte border-crimson-matte/45',
  },
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const {
    overview,
    killSwitch,
    sseConnected,
    theme,
    toggleTheme,
    mascotState,
    refreshOverview,
  } = useConsole();
  const [switchingMode, setSwitchingMode] = useState(false);
  const [killBusy, setKillBusy] = useState(false);
  const [showResumeModal, setShowResumeModal] = useState(false);
  const [resumeReason, setResumeReason] = useState('Operator verified safety posture and cleared latch.');

  const isHalted = killSwitch?.status === 'HALTED';

  const handleEngageKillSwitch = useCallback(async () => {
    if (killBusy) return;
    setKillBusy(true);
    try {
      await clamApi.engageKillSwitch({
        trigger_mode: 'manual_ui',
        engaged_by: 'console_operator',
        reason: 'Emergency Kill Switch engaged from Console top bar (Shift+K)',
      });
      await refreshOverview();
    } finally {
      setKillBusy(false);
    }
  }, [killBusy, refreshOverview]);

  const handleResumeKillSwitch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resumeReason.trim() || killBusy) return;
    setKillBusy(true);
    try {
      await clamApi.resumeKillSwitch({
        reason: resumeReason.trim(),
        resumed_by: 'console_operator',
      });
      setShowResumeModal(false);
      await refreshOverview();
    } finally {
      setKillBusy(false);
    }
  };

  useEffect(() => {
    if ((pathname === '/' || pathname === '/about')) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '/' && pathname !== '/audit') {
        e.preventDefault();
        router.push('/audit');
      } else if (e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (isHalted) {
          setShowResumeModal(true);
        } else {
          void handleEngageKillSwitch();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pathname, router, isHalted, handleEngageKillSwitch]);

  const activeAgents = overview?.active_agents_count ?? 0;
  const pendingCount = overview?.pending_approvals_count ?? 0;
  const mailMode = overview?.mail_mode ?? 'sandbox';
  const gmailConnected = overview?.gmail_status?.connected ?? false;
  const posture = POSTURE_BADGE[mascotState] ?? POSTURE_BADGE.armed;

  async function handleMailModeToggle() {
    if (switchingMode) return;
    const target = mailMode === 'sandbox' ? 'gmail' : 'sandbox';
    if (target === 'gmail' && !gmailConnected) {
      router.push('/settings');
      return;
    }
    setSwitchingMode(true);
    try {
      await clamApi.setMailMode(target);
      await refreshOverview();
    } catch {
      router.push('/settings');
    } finally {
      setSwitchingMode(false);
    }
  }

  if ((pathname === '/' || pathname === '/about')) return children;

  return (
    <div className="min-h-screen flex bg-canvas text-ink-primary">
      {/* Left Sidebar (#101114) */}
      <aside className="w-[236px] shrink-0 h-screen sticky top-0 border-r border-hairline bg-sidebar hidden md:flex flex-col justify-between overflow-y-auto">
        <div>
          <div className="h-[52px] px-4 border-b border-hairline flex items-center gap-2.5">
            <Link href="/" className="flex items-center gap-2.5">
              <ClamMascot variant="glyph" size={26} />
              <div>
                <div className="text-[14px] font-semibold tracking-display leading-none">
                  Clam
                </div>
                <div className="text-[10px] font-mono text-ink-muted tracking-wider mt-0.5">
                  MCP FIREWALL
                </div>
              </div>
            </Link>
          </div>

          <nav className="p-2.5 space-y-0.5" aria-label="Primary Navigation">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`btn-tactile flex items-center justify-between px-3 py-2 rounded-md text-[13px] font-medium ${
                    active
                      ? 'bg-elevated text-ink-primary border border-hairline shadow-bento'
                      : 'text-ink-secondary hover:text-ink-primary hover:bg-elevated/50 border border-transparent'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className="w-4 h-4 shrink-0" />
                    {item.label}
                  </span>

                  {item.href === '/agents' && (
                    <span className="px-1.5 py-0.5 rounded border border-hairline bg-surface font-mono text-[10px] text-ink-secondary tabular-nums leading-none">
                      {activeAgents}
                    </span>
                  )}

                  {item.href === '/approvals' && (
                    <span
                      className={`px-1.5 py-0.5 rounded font-mono text-[10px] tabular-nums leading-none ${
                        pendingCount > 0
                          ? 'bg-amber-fill text-amber-matte border border-amber-matte/30'
                          : 'border border-hairline bg-surface text-ink-muted'
                      }`}
                    >
                      {pendingCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Bottom Recessed Memory Boundary Card (28px live synced mascot) */}
        <div className="p-3">
          <div className="rounded-lg border border-hairline bg-surface p-3.5 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ClamMascot state={mascotState} size={28} />
                <span className="text-[10px] font-mono uppercase tracking-wider text-ink-muted">
                  Memory Boundary
                </span>
              </div>
              <span
                className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${posture.cls}`}
              >
                {posture.label}
              </span>
            </div>
            <p className="text-[11px] text-ink-secondary leading-relaxed">
              {isHalted
                ? 'Emergency Kill Switch latched. In-flight runs aborted; /mcp locked (423).'
                : 'RAM-only email proxy. OAuth credentials AES-256-GCM sealed. 0 bytes retained.'}
            </p>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Utility Rail */}
        <header className="h-[52px] shrink-0 border-b border-hairline bg-sidebar px-4 lg:px-6 flex items-center justify-between gap-3">
          {/* Mobile nav pills */}
          <div className="flex items-center gap-1.5 md:hidden overflow-x-auto">
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap ${
                    active
                      ? 'bg-elevated text-ink-primary border border-hairline'
                      : 'text-ink-secondary'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>

          <div className="hidden md:flex items-center gap-2">
            <button
              type="button"
              disabled={switchingMode}
              onClick={handleMailModeToggle}
              title={
                gmailConnected
                  ? 'Click to toggle Sandbox / Gmail mode'
                  : 'Sandbox Mode active (configure Gmail OAuth in Connections)'
              }
              className="btn-tactile inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-hairline bg-surface hover:bg-elevated text-xs font-medium text-ink-primary"
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  mailMode === 'gmail' ? 'bg-emerald-matte' : 'bg-ink-secondary'
                }`}
              />
              {mailMode === 'gmail'
                ? `Gmail (${overview?.gmail_status?.email ?? 'Connected'})`
                : 'Sandbox Mode'}
            </button>

            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border font-mono text-[11px] font-medium ${posture.cls}`}
            >
              <ClamMascot state={mascotState} size={16} />
              {posture.label}
            </span>
          </div>

          <div className="flex items-center gap-2 ml-auto">
            {/* Hardware-Style Matte Crimson Kill Switch Latch */}
            {isHalted ? (
              <button
                type="button"
                onClick={() => setShowResumeModal(true)}
                disabled={killBusy}
                title="Kill Switch ENGAGED (Shift+K to resume with audit reason)"
                className="btn-tactile inline-flex items-center gap-1.5 px-3 py-1 rounded-md border border-crimson-matte bg-crimson-fill text-crimson-matte font-mono text-[11px] font-semibold tracking-wider"
              >
                <ShieldOff className="w-3.5 h-3.5" />
                HALTED · RESUME
              </button>
            ) : (
              <button
                type="button"
                onClick={handleEngageKillSwitch}
                disabled={killBusy}
                title="Engage Emergency Kill Switch immediately (Shift+K)"
                className="btn-tactile inline-flex items-center gap-1.5 px-3 py-1 rounded-md border border-crimson-matte/55 bg-crimson-fill hover:border-crimson-matte text-crimson-matte font-mono text-[11px] font-semibold tracking-wider"
              >
                <Power className="w-3.5 h-3.5" />
                KILL SWITCH
              </button>
            )}

            <div
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-hairline bg-surface font-mono text-[11px] text-emerald-matte"
              title={sseConnected ? 'Live SSE stream connected' : 'Syncing SSE stream'}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  sseConnected ? 'bg-emerald-matte' : 'bg-amber-matte'
                }`}
              />
              <span>{sseConnected ? 'LIVE' : 'SYNC'}</span>
            </div>

            <button
              type="button"
              onClick={toggleTheme}
              className="btn-tactile p-1.5 rounded-md border border-hairline bg-surface text-ink-secondary hover:text-ink-primary hover:bg-elevated"
              aria-label="Toggle color theme"
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? (
                <Sun className="w-3.5 h-3.5" />
              ) : (
                <Moon className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </header>

        {/* Global Halted Banner */}
        {isHalted && (
          <div className="border-b border-crimson-matte/35 bg-crimson-fill px-4 lg:px-6 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 text-crimson-matte">
              <ShieldOff className="w-3.5 h-3.5 shrink-0" />
              <span className="font-mono font-semibold uppercase tracking-wider">
                {killSwitch?.trigger_mode === 'circuit_breaker'
                  ? 'AUTO-TRIP CIRCUIT BREAKER ENGAGED'
                  : 'EMERGENCY KILL SWITCH ENGAGED'}
              </span>
              <span className="text-ink-primary">
                — {killSwitch?.reason ?? 'All MCP tools locked (HTTP 423).'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowResumeModal(true)}
              className="px-2.5 py-1 rounded border border-crimson-matte/45 bg-surface text-ink-primary text-[11px] font-medium hover:bg-elevated"
            >
              Disarm & Resume…
            </button>
          </div>
        )}

        <main className="flex-1 p-4 lg:p-6 max-w-[1360px] w-full mx-auto">{children}</main>
      </div>

      {/* Resume Kill Switch Modal */}
      {showResumeModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShowResumeModal(false)}
        >
          <form
            onSubmit={handleResumeKillSwitch}
            onClick={(e) => e.stopPropagation()}
            className="bento-card rounded-xl w-full max-w-md p-5 space-y-4"
          >
            <div>
              <div className="text-[11px] font-mono uppercase tracking-wider text-crimson-matte">
                Safety Latch Disarm
              </div>
              <h3 className="text-base font-semibold tracking-display text-ink-primary mt-0.5">
                Resume Clam MCP Operations
              </h3>
              <p className="text-xs text-ink-secondary mt-1">
                Resuming writes an immutable <code>KILL_SWITCH_RESUMED</code> record to the audit
                trail.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-primary mb-1.5">
                Audit Reason
              </label>
              <input
                value={resumeReason}
                onChange={(e) => setResumeReason(e.target.value)}
                required
                className="w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-xs text-ink-primary"
              />
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowResumeModal(false)}
                className="btn-tactile px-3 py-1.5 rounded-md border border-hairline bg-canvas text-xs text-ink-secondary"
              >
                Keep Halted
              </button>
              <button
                type="submit"
                disabled={killBusy || !resumeReason.trim()}
                className="btn-primary px-3.5 py-1.5 rounded-md text-xs font-semibold"
              >
                {killBusy ? 'Resuming…' : 'Disarm & Resume'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
