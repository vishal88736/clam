'use client';

import React from 'react';

const STYLE_MAP: Record<string, { label: string; classes: string }> = {
  ALLOW: {
    label: 'ALLOW',
    classes: 'bg-emerald-fill text-emerald-matte border-emerald-matte/25',
  },
  APPROVED: {
    label: 'APPROVED',
    classes: 'bg-emerald-fill text-emerald-matte border-emerald-matte/25',
  },
  PENDING_APPROVAL: {
    label: 'ASK FIRST',
    classes: 'bg-amber-fill text-amber-matte border-amber-matte/25',
  },
  PENDING: {
    label: 'PENDING',
    classes: 'bg-amber-fill text-amber-matte border-amber-matte/25',
  },
  DENY: {
    label: 'DENY',
    classes: 'bg-crimson-fill text-crimson-matte border-crimson-matte/25',
  },
  REJECTED: {
    label: 'REJECTED',
    classes: 'bg-crimson-fill text-crimson-matte border-crimson-matte/25',
  },
  EXPIRED: {
    label: 'EXPIRED',
    classes: 'bg-elevated text-ink-secondary border-hairline',
  },
};

export function DecisionBadge({ decision }: { decision: string }) {
  const style = STYLE_MAP[decision] ?? {
    label: decision,
    classes: 'bg-elevated text-ink-secondary border-hairline',
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded border font-mono text-[11px] font-medium tracking-wide uppercase tabular-nums ${style.classes}`}
    >
      {style.label}
    </span>
  );
}
