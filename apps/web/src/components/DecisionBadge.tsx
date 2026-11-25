'use client';

import React from 'react';

const STYLE_MAP: Record<string, { label: string; classes: string }> = {
  ALLOW: {
    label: 'ALLOW',
    classes: 'bg-emerald-fill text-emerald-matte border-emerald-matte/30',
  },
  APPROVED: {
    label: 'APPROVED',
    classes: 'bg-emerald-fill text-emerald-matte border-emerald-matte/30',
  },
  PENDING_APPROVAL: {
    label: 'ASK FIRST',
    classes: 'bg-amber-fill text-amber-matte border-amber-matte/30',
  },
  PENDING: {
    label: 'PENDING',
    classes: 'bg-amber-fill text-amber-matte border-amber-matte/30',
  },
  DENY: {
    label: 'BLOCKED',
    classes: 'bg-crimson-fill text-crimson-matte border-crimson-matte/30',
  },
  REJECTED: {
    label: 'REJECTED',
    classes: 'bg-crimson-fill text-crimson-matte border-crimson-matte/30',
  },
  EXPIRED: {
    label: 'EXPIRED',
    classes: 'bg-elevated text-ink-secondary border-hairline',
  },
  KILL_SWITCH_ENGAGED: {
    label: 'KILLED',
    classes: 'bg-crimson-fill text-crimson-matte border-crimson-matte/45',
  },
  CIRCUIT_BREAKER_TRIPPED: {
    label: 'TRIPPED',
    classes: 'bg-crimson-fill text-crimson-matte border-crimson-matte/45',
  },
  KILL_SWITCH_RESUMED: {
    label: 'RESUMED',
    classes: 'bg-emerald-fill text-emerald-matte border-emerald-matte/30',
  },
};

export function DecisionBadge({ decision }: { decision: string }) {
  const style = STYLE_MAP[decision] ?? {
    label: decision,
    classes: 'bg-elevated text-ink-secondary border-hairline',
  };

  return (
    <span
      className={`inline-flex items-center justify-center min-w-[74px] px-2 py-0.5 rounded border font-mono text-[10px] font-medium tracking-wider uppercase tabular-nums ${style.classes}`}
    >
      {style.label}
    </span>
  );
}
