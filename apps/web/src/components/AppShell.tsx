'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  Bot,
  CheckSquare,
  FileSearch,
  Moon,
  Settings,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { useConsole } from './ConsoleContext';

const NAV_ITEMS = [
  { href: '/', label: 'Overview', icon: Activity },
  { href: '/agents', label: 'Agents & Rules', icon: Bot },
  { href: '/approvals', label: 'Approval Queue', icon: CheckSquare },
  { href: '/audit', label: 'Audit Ledger', icon: FileSearch },
  { href: '/settings', label: 'Connections', icon: Settings },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { overview, sseConnected, theme, toggleTheme } = useConsole();

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

  const pendingCount = overview?.pending_approvals_count ?? 0;
  const mailMode = overview?.mail_mode ?? 'sandbox';

  return (
    <div className="min-h-screen flex bg-canvas text-ink-primary">
      {/* Left Navigation Sidebar */}
      <aside className="w-[232px] shrink-0 border-r border-hairline bg-surface flex flex-col justify-between hidden md:flex">
        <div>
          <div className="h-[52px] px-4 border-b border-hairline flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2.5">
              <div className="w-6 h-6 rounded border border-hairline bg-elevated flex items-center justify-center">
                <svg
                  viewBox="0 0 20 20"
                  className="w-3.5 h-3.5 text-ink-primary"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                >
                  <path d="M3 10.5C3 6.5 6.1 3.5 10 3.5C13.9 3.5 17 6.5 17 10.5" />
                  <path d="M5 13.5H15" />
                  <path d="M7.5 16.5H12.5" />
                </svg>
              </div>
              <div>
                <div className="text-sm font-semibold tracking-display leading-none">Clam</div>
                <div className="text-[10px] font-mono text-ink-tertiary tracking-wider mt-0.5">
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
                  className={`flex items-center justify-between px-3 py-2 rounded text-[13px] font-medium transition-colors duration-150 ${
                    active
                      ? 'bg-elevated text-ink-primary border border-hairline'
                      : 'text-ink-secondary hover:text-ink-primary hover:bg-elevated/50 border border-transparent'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className="w-4 h-4 shrink-0" />
                    {item.label}
                  </span>
                  {item.href === '/approvals' && pendingCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-amber-fill text-amber-matte font-mono text-[11px] tabular-nums leading-none">
                      {pendingCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="p-3.5 border-t border-hairline">
          <div className="text-[11px] font-mono uppercase tracking-wider text-ink-tertiary">
            Memory Boundary
          </div>
          <p className="text-[11px] text-ink-secondary mt-1 leading-relaxed">
            RAM-only email proxy. OAuth credentials AES-256-GCM sealed. 0 email bytes retained.
          </p>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Status Rail */}
        <header className="h-[52px] shrink-0 border-b border-hairline bg-surface px-4 lg:px-6 flex items-center justify-between gap-3">
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

          <div className="hidden md:flex items-center gap-2.5">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs font-medium ${
                mailMode === 'gmail'
                  ? 'bg-emerald-fill text-emerald-matte border-emerald-matte/25'
                  : 'bg-elevated text-ink-primary border-hairline'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  mailMode === 'gmail' ? 'bg-emerald-matte' : 'bg-ink-secondary'
                }`}
              />
              {mailMode === 'gmail'
                ? `Gmail Connected${overview?.gmail_status?.email ? ` (${overview.gmail_status.email})` : ''}`
                : 'Sandbox Mode'}
            </span>

            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-emerald-matte/25 bg-emerald-fill text-emerald-matte text-xs font-medium">
              <ShieldCheck className="w-3.5 h-3.5" />
              Zero-Retention Verified
            </span>
          </div>

          <div className="flex items-center gap-3 ml-auto">
            <div className="hidden sm:flex items-center gap-2 text-xs text-ink-secondary">
              <span className="font-mono tabular-nums text-ink-primary">
                {overview?.active_agents_count ?? 0}
              </span>
              <span>Active Agents</span>
            </div>

            <Link
              href="/approvals"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs font-medium transition-colors duration-150 ${
                pendingCount > 0
                  ? 'bg-amber-fill text-amber-matte border-amber-matte/25'
                  : 'bg-elevated text-ink-secondary border-hairline hover:text-ink-primary'
              }`}
            >
              <span className="font-mono tabular-nums">{pendingCount}</span>
              <span>Pending</span>
            </Link>

            <div
              className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded border border-hairline bg-canvas text-[11px] font-mono text-ink-secondary"
              title={sseConnected ? 'Live SSE stream connected' : 'Reconnecting SSE stream'}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  sseConnected ? 'bg-emerald-matte' : 'bg-amber-matte'
                }`}
              />
              <span>{sseConnected ? 'LIVE' : 'SYNC'}</span>
            </div>

            <button
              onClick={toggleTheme}
              className="p-1.5 rounded border border-hairline bg-canvas text-ink-secondary hover:text-ink-primary hover:bg-elevated transition-colors duration-150"
              aria-label="Toggle color theme"
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-6 max-w-[1440px] w-full mx-auto">{children}</main>
      </div>
    </div>
  );
}
