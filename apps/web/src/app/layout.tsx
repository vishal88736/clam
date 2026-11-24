import type { Metadata } from 'next';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './globals.css';
import { ConsoleProvider } from '@/components/ConsoleContext';
import { AppShell } from '@/components/AppShell';

export const metadata: Metadata = {
  title: 'Clam — Semantic Permission Layer & MCP Firewall',
  description:
    'Zero-retention Gmail MCP firewall with deterministic gates, semantic policy enforcement, and HITL approvals.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body>
        <ConsoleProvider>
          <AppShell>{children}</AppShell>
        </ConsoleProvider>
      </body>
    </html>
  );
}
