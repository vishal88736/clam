'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Database,
  Download,
  Fingerprint,
  LockKeyhole,
  Mail,
  Moon,
  Play,
  Power,
  ScanLine,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Terminal,
} from 'lucide-react';
import { ClamMascot, type ClamMascotState } from '@/components/ClamMascot';
import { useConsole } from '@/components/ConsoleContext';
import { DecisionBadge } from '@/components/DecisionBadge';
import { PolicyStudio } from '@/components/PolicyStudio';
import { clamApi } from '@/lib/api';

const SECTIONS = [
  { id: 'hero', label: 'Home' },
  { id: 'story', label: 'How it works' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'personas', label: 'Policy studio' },
  { id: 'killswitch', label: 'Kill switch' },
  { id: 'demo', label: 'Live demo' },
];

const STORY = [
  {
    label: 'Ephemeral memory',
    title: 'Incoming email stays in volatile memory.',
    body: 'Connect Gmail to Clam. When an agent requests email, Clam fetches the content into memory, evaluates the request, and releases the payload after processing.',
    result: 'RAM-only email proxy',
    state: 'armed',
    tone: 'neutral',
    icon: Database,
  },
  {
    label: 'Semantic inspection',
    title: 'Match requests by meaning.',
    body: 'Clam evaluates content against plain-English rules. A utility bill from a new vendor can match your policy, while a message with hidden instructions can be rejected.',
    result: 'Semantic policy evaluation',
    state: 'pending',
    tone: 'ask',
    icon: ScanLine,
  },
  {
    label: 'Scoped access',
    title: 'Give each agent the mail it needs.',
    body: 'The travel agent can use flight updates and hotel bookings. Sensitive messages such as one-time codes and medical records are filtered from its inbox view.',
    result: 'In-scope mail allowed',
    state: 'allow',
    tone: 'allow',
    icon: Mail,
  },
  {
    label: 'Deterministic gates',
    title: 'Enforce hard limits before Gmail is called.',
    body: 'A rule such as “Never send” blocks the send operation at the first policy gate and records the rule citation in the audit log.',
    result: 'Forbidden tool call blocked',
    state: 'blocked',
    tone: 'block',
    icon: LockKeyhole,
  },
] satisfies {
  label: string;
  title: string;
  body: string;
  result: string;
  state: ClamMascotState;
  tone: string;
  icon: typeof Database;
}[];

const PIPELINE = [
  {
    icon: Fingerprint,
    label: 'Inbox airlock',
    title: 'Seal Gmail credentials',
    text: 'Agents receive revocable MCP bearer tokens. Gmail OAuth credentials stay in the encrypted vault.',
  },
  {
    icon: LockKeyhole,
    label: 'Deterministic gate',
    title: 'Enforce hard rules first',
    text: 'Explicit tool denials are evaluated before any semantic classification or Gmail operation.',
  },
  {
    icon: Cpu,
    label: 'Semantic classification',
    title: 'Evaluate the email in context',
    text: 'Clam classifies intent, screens for sensitive categories, and flags indirect prompt injection.',
  },
  {
    icon: ShieldCheck,
    label: 'Human approval',
    title: 'Hold actions for review',
    text: 'Ask-first rules pause actions for an operator to approve or deny through the console or a configured channel.',
  },
  {
    icon: Activity,
    label: 'Audit & circuit breaker',
    title: 'Record decisions and halt loops',
    text: 'The audit ledger records policy decisions, while the circuit breaker can stop repeated violations.',
  },
];

export default function LandingPage() {
  const {
    overview,
    killSwitch,
    mascotState,
    sseConnected,
    theme,
    toggleTheme,
    liveFeed,
    latestRun,
    trapReport,
    refreshOverview,
    clearLiveRunSteps,
    setLatestRun,
    setTrapReport,
  } = useConsole();
  const [currentSection, setCurrentSection] = useState('hero');
  const [storyIndex, setStoryIndex] = useState(0);
  const [pipelinePosition, setPipelinePosition] = useState({ atStart: true, atEnd: false });
  const [killBusy, setKillBusy] = useState(false);
  const [showResume, setShowResume] = useState(false);
  const [resumeReason, setResumeReason] = useState('');
  const [killError, setKillError] = useState('');
  const [demoBusy, setDemoBusy] = useState<'agent' | 'traps' | null>(null);
  const [demoError, setDemoError] = useState('');
  const pipelineTrack = useRef<HTMLDivElement>(null);
  const stage = STORY[storyIndex];
  const StageIcon = stage.icon;
  const halted = killSwitch?.status === 'HALTED';
  const posture = killSwitch?.status ?? 'Connecting';
  const ready = overview !== null;

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        if (visible) setCurrentSection(visible.target.id);
      },
      { rootMargin: '-26% 0px -66% 0px' },
    );
    for (const { id } of SECTIONS) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, []);

  function movePipeline(direction: number) {
    const track = pipelineTrack.current;
    if (!track) return;
    const [first, second] = [...track.children] as HTMLElement[];
    track.scrollBy({ left: (second.offsetLeft - first.offsetLeft) * direction });
  }

  const trackPipelinePosition = useCallback(() => {
    const track = pipelineTrack.current;
    if (!track) return;
    setPipelinePosition({
      atStart: track.scrollLeft < 4,
      atEnd: track.scrollLeft + track.clientWidth >= track.scrollWidth - 4,
    });
  }, []);

  useEffect(() => {
    const track = pipelineTrack.current;
    if (!track) return;
    const observer = new ResizeObserver(trackPipelinePosition);
    observer.observe(track);
    return () => observer.disconnect();
  }, [trackPipelinePosition]);

  const engageKillSwitch = useCallback(async () => {
    if (killBusy || !killSwitch || killSwitch.status === 'HALTED') return;
    setKillBusy(true);
    setKillError('');
    try {
      await clamApi.engageKillSwitch({
        trigger_mode: 'manual_ui',
        engaged_by: 'console_operator',
        reason: 'Emergency Kill Switch engaged from the Clam home page.',
      });
      await refreshOverview();
    } catch (err) {
      setKillError(err instanceof Error ? err.message : 'Could not halt MCP operations.');
    } finally {
      setKillBusy(false);
    }
  }, [killBusy, killSwitch, refreshOverview]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, select, textarea'))
      )
        return;
      if (!event.shiftKey || event.key.toLowerCase() !== 'k' || event.repeat || !killSwitch) return;
      event.preventDefault();
      document.getElementById('killswitch')?.scrollIntoView();
      if (halted) setShowResume(true);
      else void engageKillSwitch();
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [engageKillSwitch, halted, killSwitch]);

  async function resumeOperations(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = resumeReason.trim();
    if (killBusy || !reason) return;
    setKillBusy(true);
    setKillError('');
    try {
      await clamApi.resumeKillSwitch({ reason, resumed_by: 'console_operator' });
      setShowResume(false);
      setResumeReason('');
      await refreshOverview();
    } catch (err) {
      setKillError(err instanceof Error ? err.message : 'Could not resume MCP operations.');
    } finally {
      setKillBusy(false);
    }
  }

  async function runDemo(action: 'agent' | 'traps') {
    if (demoBusy || halted || !ready || overview.mail_mode !== 'sandbox') return;
    setDemoBusy(action);
    setDemoError('');
    try {
      if (action === 'agent') {
        clearLiveRunSteps();
        const { run } = await clamApi.startAgentRun({ agent_id: 'ag_autonomous' });
        setLatestRun(run);
        if (run.status !== 'completed') setDemoError(`Agent run ${run.status}.`);
      } else {
        const { report } = await clamApi.runTrapPack();
        setTrapReport(report);
      }
    } catch (err) {
      const actionName = action === 'agent' ? 'Inbox agent' : 'Trap Pack';
      setDemoError(
        err instanceof Error ? `${actionName} failed (${err.message}).` : `${actionName} failed.`,
      );
    } finally {
      await refreshOverview();
      setDemoBusy(null);
    }
  }

  return (
    <div className="landing">
      <a href="#hero" className="landing-skip">
        Skip to content
      </a>
      <header className="landing-header">
        <div className="landing-header-inner">
          <Link
            href="/"
            className="inline-flex shrink-0 items-center gap-2 font-extrabold tracking-display"
            aria-label="Clam home"
          >
            <ClamMascot variant="glyph" size={32} />
            <span className="text-lg">Clam</span>
          </Link>
          <nav className="landing-nav" aria-label="Main navigation">
            <a href="#story">How it works</a>
            <a href="#personas">Policy studio</a>
            <a href="#demo">Live demo</a>
          </nav>
          <div className="flex shrink-0 items-center gap-2">
            <span
              className={`landing-badge landing-header-live ${sseConnected ? 'landing-tone-allow' : 'landing-tone-neutral'}`}
            >
              <span className="landing-status-dot" />
              {sseConnected ? 'Live' : ready ? 'Reconnecting' : 'Connecting'}
            </span>
            <button
              type="button"
              onClick={toggleTheme}
              className="landing-icon-button btn-tactile"
              aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
            >
              {theme === 'light' ? (
                <Moon size={16} aria-hidden="true" />
              ) : (
                <Sun size={16} aria-hidden="true" />
              )}
            </button>
            <Link
              href="/"
              className="landing-button landing-button-secondary landing-console-link"
            >
              Console <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </header>

      <nav className="landing-rail" aria-label="On this page">
        {SECTIONS.map(({ id, label }) => (
          <a key={id} href={`#${id}`} aria-current={currentSection === id ? 'location' : undefined}>
            <span>{label}</span>
            <i aria-hidden="true" />
          </a>
        ))}
      </nav>

      <main>
        <section className="landing-hero" id="hero" tabIndex={-1}>
          <div className="landing-hero-content">
            <p className="landing-badge landing-tone-neutral">
              <span>Agentware 2026</span>
              <span className="landing-status-dot" /> Inbox &amp; Calendar
            </p>
            <div className="landing-hero-mascot">
              <ClamMascot state={mascotState} size={254} interactive />
            </div>
            <h1>
              Build an agent you can <span>walk away from.</span>
            </h1>
            <p className="landing-lede">
              Give your inbox agent plain-English rules. Clam enforces them at the MCP boundary and
              processes email in memory.
            </p>
            <div className="landing-actions">
              <a href="#demo" className="landing-button btn-primary">
                Launch live demo <ArrowRight size={17} aria-hidden="true" />
              </a>
              <a href="#personas" className="landing-button landing-button-secondary">
                <Terminal size={16} aria-hidden="true" /> Type your rule
              </a>
            </div>
          </div>
          <a className="landing-scroll" href="#story" aria-label="Scroll to how Clam works">
            <ArrowDown size={16} aria-hidden="true" />
          </a>
        </section>

        <section id="story" className="landing-section">
          <div className="landing-wrap">
            <div className="landing-section-heading">
              <p className="landing-label">How Clam works</p>
              <h2>An airlock between your inbox and autonomous agents.</h2>
            </div>
            <div className="landing-story-grid">
              <div className="grid content-start gap-2" role="group" aria-label="Inbox processing steps">
                {STORY.map(({ label, icon: Icon }, index) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setStoryIndex(index)}
                    aria-pressed={storyIndex === index}
                    className="landing-select btn-tactile flex items-center gap-3 rounded-xl px-4 py-3.5 text-left text-sm font-semibold"
                  >
                    <Icon size={17} aria-hidden="true" /> {label}{' '}
                    <ChevronRight size={16} className="ml-auto" aria-hidden="true" />
                  </button>
                ))}
              </div>
              <div className="bento-card landing-stage rounded-2xl" aria-live="polite">
                <div className="landing-stage-copy">
                  <span className={`landing-badge landing-tone-${stage.tone}`}>
                    <StageIcon size={13} aria-hidden="true" /> {stage.result}
                  </span>
                  <h3>{stage.title}</h3>
                  <p>{stage.body}</p>
                </div>
                <ClamMascot state={stage.state} size={175} className="landing-stage-mascot" />
              </div>
            </div>
          </div>
        </section>

        <section id="pipeline" className="landing-section landing-section-inset">
          <div className="landing-wrap">
            <div className="landing-section-heading flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="landing-label">Security pipeline</p>
                <h2>Five enforced layers.</h2>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="landing-icon-button btn-tactile"
                  disabled={pipelinePosition.atStart}
                  aria-label="Previous pipeline stage"
                  onClick={() => movePipeline(-1)}
                >
                  <ChevronLeft size={18} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="landing-icon-button btn-tactile"
                  disabled={pipelinePosition.atEnd}
                  aria-label="Next pipeline stage"
                  onClick={() => movePipeline(1)}
                >
                  <ChevronRight size={18} aria-hidden="true" />
                </button>
              </div>
            </div>
            <div
              className="landing-pipeline"
              ref={pipelineTrack}
              onScroll={trackPipelinePosition}
              role="region"
              aria-label="Security pipeline stages"
              tabIndex={0}
            >
              {PIPELINE.map(({ icon: Icon, label, title, text }) => (
                <article key={label} className="landing-pipeline-card bento-card rounded-2xl">
                  <span className="landing-pipeline-icon">
                    <Icon size={20} aria-hidden="true" />
                  </span>
                  <p className="landing-label mt-5">{label}</p>
                  <h3>{title}</h3>
                  <p className="text-sm leading-relaxed text-ink-secondary">{text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="personas" className="landing-section">
          <div className="landing-wrap">
            <div className="landing-section-heading">
              <p className="landing-label">Policy studio</p>
              <h2>Pick your role. Type your rule.</h2>
              <p>
                Start with a rule template and see what the policy engine would allow in the sandbox
                inbox.
              </p>
            </div>
            <PolicyStudio ready={ready} />
          </div>
        </section>

        <section id="killswitch" className="landing-section landing-safety">
          <div className="landing-wrap">
            <div className="landing-section-heading mx-auto text-center">
              <p className="landing-label text-crimson-matte">Emergency kill switch</p>
              <h2>Halt MCP operations in one action.</h2>
              <p>
                Engage the switch to abort active runs and lock MCP requests. The same control is
                available with <kbd>Shift</kbd> + <kbd>K</kbd>.
              </p>
            </div>
            <div className="bento-card landing-safety-panel rounded-2xl">
              <div className="flex flex-col items-center">
                <ClamMascot state={halted ? 'halted' : 'armed'} size={166} />
                <span
                  className={`landing-badge landing-tone-${halted ? 'block' : killSwitch ? 'allow' : 'neutral'}`}
                  role="status"
                >
                  <span className="landing-status-dot" /> {posture}
                </span>
              </div>
              <div className="min-w-0">
                <h3>{halted ? 'MCP operations halted' : 'Operator controls'}</h3>
                <p className="mb-4 mt-2 break-words text-sm leading-relaxed text-ink-secondary">
                  {halted
                    ? killSwitch.reason
                    : 'The circuit breaker can also halt an agent after repeated policy violations.'}
                </p>
                {halted && showResume ? (
                  <form onSubmit={resumeOperations} className="space-y-3">
                    <label htmlFor="resume-reason" className="landing-label block">
                      Audit reason
                    </label>
                    <input
                      id="resume-reason"
                      autoFocus
                      value={resumeReason}
                      onChange={(event) => setResumeReason(event.target.value)}
                      required
                      maxLength={300}
                      className="block w-full rounded-lg border border-hairline bg-canvas px-3 py-2.5 text-sm"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="submit"
                        className="landing-button btn-primary"
                        disabled={killBusy || !resumeReason.trim()}
                      >
                        {killBusy ? 'Resuming…' : 'Resume operations'}
                      </button>
                      <button
                        type="button"
                        className="landing-button landing-button-secondary"
                        onClick={() => setShowResume(false)}
                        disabled={killBusy}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="landing-button landing-button-danger"
                    disabled={!killSwitch || killBusy}
                    onClick={halted ? () => setShowResume(true) : engageKillSwitch}
                  >
                    <Power size={17} aria-hidden="true" />{' '}
                    {halted ? 'Resume MCP operations' : killBusy ? 'Halting…' : 'Engage kill switch'}
                  </button>
                )}
                {killError && (
                  <p role="alert" className="mt-3 text-sm text-crimson-matte">
                    {killError}
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>

        <section id="demo" className="landing-section">
          <div className="landing-wrap">
            <div className="landing-section-heading mx-auto text-center">
              <p className="landing-label">Live product demo</p>
              <h2>Walk away. Clam holds the line.</h2>
              <p>Run the inbox agent using sandbox mail and inspect the decisions Clam records.</p>
            </div>
            <div className="landing-actions mb-7">
              <button
                type="button"
                className="landing-button btn-primary"
                disabled={!!demoBusy || halted || !ready || overview.mail_mode !== 'sandbox'}
                onClick={() => void runDemo('agent')}
              >
                <Play size={16} aria-hidden="true" />{' '}
                {demoBusy === 'agent' ? 'Running agent…' : 'Run inbox agent'}
              </button>
              <button
                type="button"
                className="landing-button landing-button-danger"
                disabled={!!demoBusy || halted || !ready || overview.mail_mode !== 'sandbox'}
                onClick={() => void runDemo('traps')}
              >
                <ShieldAlert size={16} aria-hidden="true" />{' '}
                {demoBusy === 'traps' ? 'Running Trap Pack…' : 'Run Trap Pack'}
              </button>
              <Link href="/" className="landing-button landing-button-secondary">
                Open console <ArrowUpRight size={16} aria-hidden="true" />
              </Link>
            </div>
            <div className="mb-4 text-center text-sm text-ink-secondary" aria-live="polite">
              {demoError && <p className="text-crimson-matte">{demoError}</p>}
              {halted && <p>Resume MCP operations before starting a demo.</p>}
              {!halted && ready && overview.mail_mode !== 'sandbox' && (
                <p>
                  Switch to Sandbox Mode in{' '}
                  <Link href="/settings" className="underline">
                    Connections
                  </Link>{' '}
                  to run the demo.
                </p>
              )}
              {!ready && <p>Waiting for the Clam backend.</p>}
              {latestRun && (
                <p>
                  Latest inbox run {latestRun.status}. {latestRun.artifacts_written.length} artifacts
                  saved.
                </p>
              )}
              {trapReport && (
                <p>
                  {trapReport.total_cases === 0
                    ? 'Trap Pack did not load any test cases.'
                    : `Trap Pack results · ${trapReport.passed_cases}/${trapReport.total_cases} cases passed.`}
                </p>
              )}
            </div>
            <div className="bento-card overflow-hidden rounded-2xl">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-4 sm:px-6">
                <h3 className="flex items-center gap-2 text-sm font-bold">
                  <Activity size={16} aria-hidden="true" /> Firewall activity
                </h3>
                {ready && (
                  <a href={clamApi.getAuditExportUrl()} className="landing-text-link">
                    <Download size={15} aria-hidden="true" /> Export audit log
                  </a>
                )}
              </div>
              {liveFeed.length ? (
                <ul className="divide-y divide-hairline">
                  {liveFeed.slice(0, 5).map((entry) => (
                    <li
                      key={entry.id}
                      className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6"
                    >
                      <div className="min-w-0">
                        <p className="break-words font-mono text-xs">{entry.mcp_tool}</p>
                        <p className="mt-1 break-words text-xs text-ink-secondary">{entry.agent_name}</p>
                      </div>
                      <DecisionBadge decision={entry.decision} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-9 text-center text-sm text-ink-secondary">
                  Firewall decisions appear here after a run.
                </p>
              )}
              <div className="border-t border-hairline px-4 py-3 sm:px-6">
                <Link href="/audit" className="landing-text-link">
                  View audit ledger <ArrowRight size={16} aria-hidden="true" />
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-hairline">
        <div className="landing-wrap flex flex-wrap items-center justify-between gap-4 py-6">
          <a href="#hero" className="flex items-center gap-2 font-bold">
            <ClamMascot variant="glyph" size={24} /> Clam
          </a>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink-secondary">
            <Link href="/agents">Agents &amp; Rules</Link>
            <Link href="/audit">Audit Ledger</Link>
            <Link href="/settings">Connections</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
