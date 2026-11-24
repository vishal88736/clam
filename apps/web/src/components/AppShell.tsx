'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  Bot,
  CheckSquare,
  FileSearch,
  Moon,
  Settings,
  Sun,
} from 'lucide-react';
import { ClamMascot } from './ClamMascot';
import { useConsole } from './ConsoleContext';
import { clamApi } from '@/lib/api';

const NAV_ITEMS = [
  { href: '/', label: 'Overview', icon: Activity },
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
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { overview, sseConnected, theme, toggleTheme, mascotState, refreshOverview } =
    useConsole();
  const [switchingMode, setSwitchingMode] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '/' && pathname !== '/audit') {
        e.preventDefault();
        router.push('/audit');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pathname, router]);

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
              const active =
                item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);

              return (
                <Link
                  key={item.href}
                  href={item.href}
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
              RAM-only email proxy. OAuth credentials AES-256-GCM sealed. 0 bytes retained.
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
              const active =
                item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
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

        <main className="flex-1 p-4 lg:p-6 max-w-[1360px] w-full mx-auto">{children}</main>
      </div>
    </div>
  );
}
