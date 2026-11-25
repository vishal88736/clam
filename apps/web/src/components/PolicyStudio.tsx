'use client';

import { ArrowUpRight, FlaskConical, Mail } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { PolicyEvaluationTrace } from '@clam/shared';
import { clamApi } from '@/lib/api';

const PERSONAS = [
  {
    id: 'ag_travel',
    name: 'Traveler & executive',
    scope: 'Itineraries and host replies',
    rules:
      'Read flight, hotel, and booking emails to build my itinerary. Draft replies to hosts for me to review. Never send or delete.',
  },
  {
    id: 'ag_invoices',
    name: 'Builder & operations',
    scope: 'Utility bills and vendor invoices',
    rules:
      'Read utility bills, SaaS invoices, and vendor receipts for expense tracking. Ask me first before archiving. Never send or delete.',
  },
  {
    id: 'ag_triage',
    name: 'Enterprise security',
    scope: 'Inbox triage and approval gates',
    rules:
      'Read work correspondence and shipping notices. Ask me first before drafting or sending replies. Never delete.',
  },
  {
    id: 'ag_autonomous',
    name: 'Autonomous agent developer',
    scope: 'Travel and bills over MCP',
    rules:
      'Read flight, hotel, and invoice emails over MCP. Save itinerary artifacts. Draft check-in replies to hosts. Never send or delete.',
  },
] as const;

const SAMPLE_EMAILS = [
  { id: 'msg_flight_delta_01', name: 'Flight confirmation' },
  { id: 'msg_bill_unknown_utility_11', name: 'New vendor utility bill' },
  { id: 'msg_otp_bank_06', name: 'Bank verification code' },
];

const DECISIONS = {
  ALLOW: { label: 'Allowed', tone: 'allow' },
  DENY: { label: 'Blocked', tone: 'block' },
  PENDING_APPROVAL: { label: 'Approval required', tone: 'ask' },
} as const;

export function PolicyStudio({ ready }: { ready: boolean }) {
  const [persona, setPersona] = useState<(typeof PERSONAS)[number]>(PERSONAS[0]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [emailId, setEmailId] = useState(SAMPLE_EMAILS[0].id);
  const [trace, setTrace] = useState<PolicyEvaluationTrace | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const rules = drafts[persona.id] ?? persona.rules;
  const decision = trace ? DECISIONS[trace.decision] : null;

  async function testRules(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setTrace(null);
    setError('');
    try {
      const result = await clamApi.simulatePolicy(persona.id, {
        tool: 'read_email',
        raw_rules_override: rules,
        sandbox_email_id: emailId,
      });
      setTrace(result.trace);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Policy test failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div
        className="mb-5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4"
        role="group"
        aria-label="Rule templates"
      >
        {PERSONAS.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={busy}
            aria-pressed={persona.id === item.id}
            className="landing-select btn-tactile rounded-xl p-4 text-left"
            onClick={() => {
              setPersona(item);
              setTrace(null);
              setError('');
            }}
          >
            <span className="block text-sm font-bold">{item.name}</span>
            <span className="mt-1 block text-xs leading-relaxed text-ink-secondary">{item.scope}</span>
          </button>
        ))}
      </div>

      <form onSubmit={testRules} className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="bento-card rounded-2xl p-5 sm:p-7">
          <label htmlFor="landing-rule" className="landing-label mb-3 block">
            Plain-English rules
          </label>
          <textarea
            id="landing-rule"
            value={rules}
            rows={5}
            required
            disabled={busy}
            onChange={(event) => {
              setDrafts({ ...drafts, [persona.id]: event.target.value });
              setTrace(null);
              setError('');
            }}
            className="w-full resize-y rounded-xl border border-hairline bg-canvas px-4 py-3 text-sm leading-relaxed"
          />
          <Link href={`/agents?agent=${persona.id}`} className="landing-text-link mt-3">
            Manage agent rules <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </div>
        <div className="bento-card rounded-2xl p-5 sm:p-7">
          <label htmlFor="landing-sample" className="landing-label mb-3 flex items-center gap-2">
            <Mail size={15} aria-hidden="true" /> Sandbox test email
          </label>
          <select
            id="landing-sample"
            className="w-full rounded-xl border border-hairline bg-canvas px-3 py-2.5 text-sm"
            value={emailId}
            disabled={busy}
            onChange={(event) => {
              setEmailId(event.target.value);
              setTrace(null);
              setError('');
            }}
          >
            {SAMPLE_EMAILS.map((email) => (
              <option key={email.id} value={email.id}>
                {email.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="landing-button btn-primary mt-3"
            disabled={!ready || busy || !rules.trim()}
          >
            <FlaskConical size={15} aria-hidden="true" /> {busy ? 'Testing…' : 'Test rule'}
          </button>
          <div className="mt-4 min-h-16 text-sm text-ink-secondary" aria-live="polite">
            {error && <p className="text-crimson-matte">{error}</p>}
            {trace && decision && (
              <>
                <span className={`landing-badge landing-tone-${decision.tone}`}>{decision.label}</span>
                <p className="mt-2 break-words leading-relaxed">{trace.rule_citation}</p>
              </>
            )}
            {!trace && !error && !busy && (
              <p>
                {ready
                  ? 'Test the edited rule against a sample email. The test runs on sandbox data.'
                  : 'Waiting for the Clam backend.'}
              </p>
            )}
          </div>
        </div>
      </form>
    </>
  );
}
