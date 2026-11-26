'use client';

import {
  Bot, Calendar, ExternalLink, FileSpreadsheet, FileText, Folder, FolderOpen, History, Image as ImageIcon, Mail,
  Pause, Play, ScrollText, Shuffle, Sparkles, Trash2, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type AgentStatus = 'active' | 'input_required' | 'paused' | 'completed' | 'halted' | 'archived';
export type Agent = {
  id: string; name: string; goal_prompt: string; source_cli: string; allowed_services: string[]; schedule_mode: string;
  interval_seconds: number | null; status: AgentStatus; run_count: number; last_run_at: string | null; next_run_at: string | null;
  created_at: string; state: { phase: string; pending_approvals: string[]; last_error?: string | null; picker_uri?: string | null; notes?: string[] };
  workflow_plan: { template: string; planner: string; steps: Array<{ id: string; service: string; action: string; label: string; tier_hint: number }> };
};
export type Profile = {
  id: string; email: string; display_name: string; avatar_url: string | null; active_agent_id: string | null; mode: 'sandbox' | 'live';
  services: string[]; signed_in: boolean; halted: boolean;
};
type Switch = { id: string; from_agent_name: string | null; to_agent_name: string; switched_by: string; reason: string; created_at: string };
type LogEntry = {
  id: string; agent_id: string; agent_name: string; mission_run_id: string | null; step_index: number; service: string; action_name: string;
  input_summary: string; output_summary: string; artifact_id: string | null; policy_verdict: string; policy_rule_id: string;
  verified: boolean; trace_step_hash: string | null; created_at: string;
};
type Artifact = {
  id: string; agent_id: string | null; service: string; title: string; url: string | null; summary: string; updated_at: string;
  inbox_id: string; external_id: string | null;
};
type Preview = Record<string, unknown> & {
  type?: string; tabs?: Array<{ name: string; headers: string[]; rows: unknown[][] }>; sections?: Array<{ heading: string; text: string }>;
  children?: Array<{ type: string; name: string }>; text_preview?: string | null; mime?: string; bytes?: number; md5?: string;
};

const allServices = ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'photos'] as const;
const serviceLabel: Record<string, string> = {
  gmail: 'Gmail', calendar: 'Calendar', drive: 'Drive', docs: 'Docs', sheets: 'Sheets', photos: 'Photos', policy: 'Policy', system: 'System',
};
const sourceLabel: Record<string, string> = {
  'codex-cli': 'Codex CLI', 'claude-code': 'Claude Code', cursor: 'Cursor', cline: 'Cline', web: 'Web', other_mcp: 'MCP client',
};
const statusLabel: Record<AgentStatus, [string, 'green' | 'amber' | 'red' | 'neutral']> = {
  active: ['Active', 'green'], input_required: ['Needs Approval', 'amber'], paused: ['Paused', 'neutral'],
  completed: ['Completed', 'neutral'], halted: ['Halted', 'red'], archived: ['Cancelled', 'neutral'],
};
const verdictTone: Record<string, 'green' | 'amber' | 'red' | 'neutral'> = {
  ALLOW_TIER_0: 'green', ALLOW_TIER_1: 'green', GATE_TIER_2: 'amber', BLOCKED: 'red',
};
const serviceIcon = (service: string, size = 16): ReactNode => ({
  drive_folder: <Folder size={size} />, drive_file: <FileText size={size} />, google_doc: <FileText size={size} />,
  google_sheet: <FileSpreadsheet size={size} />, google_photo: <ImageIcon size={size} />, gmail: <Mail size={size} />,
  calendar: <Calendar size={size} />, drive: <FolderOpen size={size} />, docs: <FileText size={size} />, sheets: <FileSpreadsheet size={size} />,
  photos: <ImageIcon size={size} />,
} as Record<string, ReactNode>)[service] ?? <ScrollText size={size} />;
const artifactLabel: Record<string, string> = {
  drive_folder: 'Drive folder', drive_file: 'Drive file', google_doc: 'Google Doc', google_sheet: 'Google Sheet', google_photo: 'Photos receipt',
};

async function platform<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api/inbox/platform/' + endpoint, {
    method, cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'HTTP ' + response.status);
  return result as T;
}
const time = (value: string | null | undefined) => value && !Number.isNaN(Date.parse(value))
  ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '—';
const nice = (value: string) => value.replace(/_/g, ' ').replace(/^./, (char) => char.toUpperCase());

function Tag({ children, tone = 'neutral', testId }: { children: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red'; testId?: string }) {
  return <span className="inbox-tag" data-tone={tone} data-testid={testId}>{children}</span>;
}

export interface PlatformData {
  profile: Profile | null;
  agents: Agent[];
  activeId: string | null;
  switches: Switch[];
  error: string;
  reload: () => Promise<void>;
}

/** Loads the user profile, agents, and switch history; reloads whenever the live platform revision changes. */
export function usePlatformData(revision: number): PlatformData {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [switches, setSwitches] = useState<Switch[]>([]);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const [me, list, history] = await Promise.all([
        platform<Profile>('me'), platform<{ agents: Agent[]; active_agent_id: string | null }>('agents'), platform<{ switches: Switch[] }>('switches'),
      ]);
      if (request !== sequence.current) return;
      setProfile(me);
      setAgents(list.agents);
      setActiveId(list.active_agent_id);
      setSwitches(history.switches);
      setError('');
    } catch (failure) {
      if (request === sequence.current) setError(failure instanceof Error ? nice(failure.message) : 'Could not load agents');
    }
  }, []);
  useEffect(() => { void reload(); }, [reload, revision]);
  return { profile, agents, activeId, switches, error, reload };
}

export function AgentSwitcherBar({ data, onError }: { data: PlatformData; onError: (message: string) => void }) {
  const { profile, agents, activeId, switches } = data;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const popover = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !popover.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  if (!profile) return null;
  const switchTo = async (id: string) => {
    setBusy(true);
    try { await platform(`agents/${id}/switch`, 'POST', { reason: 'Selected in the active agent switcher' }); await data.reload(); }
    catch (failure) { onError(failure instanceof Error ? nice(failure.message) : 'Switch failed'); }
    finally { setBusy(false); }
  };
  const active = agents.find((agent) => agent.id === activeId);
  return <section className="agent-bar" aria-label="User and active agent">
    <div className="agent-bar-user">
      {profile.avatar_url ? <img src={profile.avatar_url} alt="" width={34} height={34} referrerPolicy="no-referrer" />
        : <span className="agent-avatar" aria-hidden="true">{(profile.display_name || profile.email).charAt(0).toUpperCase()}</span>}
      <div><strong data-testid="user-name">{profile.display_name || profile.email}</strong><span>{profile.email}</span></div>
    </div>
    <ul className="agent-services" aria-label="Connected Google services">
      {allServices.map((service) => {
        const on = profile.services.includes(service);
        return <li key={service} data-on={on} title={on ? `${serviceLabel[service]} connected${profile.mode === 'sandbox' ? ' ($0 sandbox)' : ''}` : `${serviceLabel[service]} not granted`}>
          {serviceIcon(service, 13)}{serviceLabel[service]}
        </li>;
      })}
    </ul>
    <label className="agent-picker">Active agent
      <select data-testid="active-agent-select" value={activeId ?? ''} disabled={busy || !agents.length}
        onChange={(event) => event.target.value && void switchTo(event.target.value)}>
        {!activeId && <option value="">No active agent</option>}
        {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select>
    </label>
    {active && <Tag tone={statusLabel[active.status][1]} testId="active-agent-status">{statusLabel[active.status][0]}</Tag>}
    <div className="agent-popover-anchor" ref={popover}>
      <button type="button" className="inbox-button" aria-expanded={open} aria-controls="switch-history" onClick={() => setOpen(!open)}>
        <History size={15} /> Switch history <span className="inbox-nav-count">{switches.length}</span>
      </button>
      {open && <div id="switch-history" className="agent-popover" role="dialog" aria-label="Agent switch history">
        {!switches.length ? <p>No agent switches yet.</p> : <ol>{switches.slice(0, 8).map((entry) => <li key={entry.id}>
          <strong>{entry.to_agent_name}</strong>
          <span>{entry.from_agent_name ? `from ${entry.from_agent_name}` : 'first agent'} · {nice(entry.switched_by)} · {time(entry.created_at)}</span>
        </li>)}</ol>}
        <a className="inbox-text-link" href="#agents" onClick={() => setOpen(false)}>Full timeline</a>
      </div>}
    </div>
  </section>;
}

function ArtifactPreview({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    platform<{ preview: Preview | null }>('artifacts/' + artifact.id).then((result) => setPreview(result.preview ?? {}))
      .catch((failure) => setError(failure instanceof Error ? nice(failure.message) : 'Preview unavailable'));
    dialog.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [artifact.id, onClose]);
  return <div className="agent-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="agent-modal" role="dialog" aria-modal="true" aria-labelledby="artifact-title" tabIndex={-1} ref={dialog} data-testid="artifact-preview">
      <header>
        <div>{serviceIcon(artifact.service, 18)}<h2 id="artifact-title">{artifact.title}</h2><Tag>{artifactLabel[artifact.service]}</Tag><Tag>$0 sandbox preview</Tag></div>
        <button type="button" className="inbox-button" aria-label="Close preview" onClick={onClose}><X size={16} /></button>
      </header>
      {error ? <p className="inbox-error" role="alert">{error}</p> : !preview ? <p>Loading preview.</p> : <>
        {preview.tabs?.map((tab) => <section key={tab.name}>
          <h3>{tab.name} <small>{tab.rows.length} rows</small></h3>
          <div className="inbox-table-wrap agent-sheet"><table>
            <thead><tr><th aria-label="Row" />{tab.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
            <tbody>{tab.rows.map((row, index) => <tr key={index} data-testid="sheet-row"><th>{index + 2}</th>
              {tab.headers.map((_header, column) => <td key={column}>{String(row[column] ?? '')}</td>)}</tr>)}</tbody>
          </table></div>
        </section>)}
        {preview.sections && <article className="agent-doc">{preview.sections.map((section) => <section key={section.heading} data-testid="doc-section">
          <h3>{section.heading}</h3>{section.text.split('\n').map((line, index) => <p key={index}>{line}</p>)}
        </section>)}</article>}
        {preview.children && <ul className="agent-folder">{preview.children.length ? preview.children.map((child) => <li key={child.type + child.name}>
          {serviceIcon(child.type, 15)}{child.name}</li>) : <li>Empty folder</li>}</ul>}
        {preview.type === 'drive_file' && <dl className="inbox-fields">
          <div><dt>Type</dt><dd>{preview.mime}</dd></div><div><dt>Size</dt><dd>{preview.bytes} bytes</dd></div>
          <div><dt>MD5</dt><dd><code>{preview.md5}</code></dd></div>
          {preview.text_preview && <div><dt>Content</dt><dd><pre>{preview.text_preview}</pre></dd></div>}
        </dl>}
      </>}
    </div>
  </div>;
}

export function AgentsView({ data, revision, onTrace, onError }: {
  data: PlatformData; revision: number; onTrace: (runId: string) => void; onError: (message: string) => void;
}) {
  const { agents, activeId, switches } = data;
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [agentFilter, setAgentFilter] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Artifact | null>(null);
  useEffect(() => {
    let live = true;
    const query = new URLSearchParams({ limit: '150', ...(agentFilter ? { agent_id: agentFilter } : {}), ...(serviceFilter ? { service: serviceFilter } : {}) });
    Promise.all([platform<{ logs: LogEntry[] }>('logs?' + query), platform<{ artifacts: Artifact[] }>('artifacts')])
      .then(([log, list]) => { if (live) { setLogs(log.logs); setArtifacts(list.artifacts); } })
      .catch((failure) => onError(failure instanceof Error ? nice(failure.message) : 'Could not load logs'));
    return () => { live = false; };
  }, [revision, agentFilter, serviceFilter, onError]);
  const names = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const control = async (endpoint: string, body?: unknown) => {
    setBusy(true);
    try { await platform(endpoint, 'POST', body ?? {}); await data.reload(); }
    catch (failure) { onError(failure instanceof Error ? nice(failure.message) : 'Request failed'); }
    finally { setBusy(false); }
  };
  const closePreview = useCallback(() => setPreview(null), []);

  return <div className="inbox-stack">
    <section className="inbox-panel">
      <div className="inbox-panel-head"><h2><Sparkles size={18} />Create an agent</h2><Tag>Any CLI can do this with provision_and_run_agent</Tag></div>
      <form className="agent-create" onSubmit={(event) => {
        event.preventDefault();
        void control('agents', { instruction }).then(() => setInstruction(''));
      }}>
        <label htmlFor="agent-instruction">Describe what the agent should do</label>
        <textarea id="agent-instruction" rows={2} value={instruction} maxLength={4000} onChange={(event) => setInstruction(event.target.value)}
          placeholder="Email these 4 vendors for quotes on 500 custom boxes, compare prices in a Sheet and Doc, and book the cheapest one." />
        <button type="submit" className="inbox-button" data-tone="primary" disabled={busy || instruction.trim().length < 4}><Bot size={16} /> Create &amp; switch</button>
      </form>
    </section>

    <section className="inbox-panel">
      <div className="inbox-panel-head"><h2><Bot size={18} />My agents</h2><Tag>{agents.length} agents</Tag></div>
      {!agents.length ? <div className="inbox-empty">No agents yet. Ask your CLI agent to do something, or describe a task above.</div> :
        <div className="agent-grid">{agents.map((agent) => {
          const [statusText, tone] = statusLabel[agent.status];
          return <article key={agent.id} className="agent-card" data-active={agent.id === activeId} data-testid="agent-card" data-agent-id={agent.id}>
            <header>
              <strong>{agent.name}</strong>
              {agent.id === activeId && <Tag tone="green">Active agent</Tag>}
              <Tag tone={tone} testId="agent-status">{statusText}</Tag>
            </header>
            <blockquote>{agent.goal_prompt}</blockquote>
            <div className="agent-meta">
              <Tag testId="agent-source">{sourceLabel[agent.source_cli] ?? agent.source_cli}</Tag>
              {agent.allowed_services.map((service) => <span key={service} className="agent-chip">{serviceIcon(service, 12)}{serviceLabel[service]}</span>)}
            </div>
            <dl>
              <div><dt>Schedule</dt><dd>{nice(agent.schedule_mode)}</dd></div>
              <div><dt>Runs</dt><dd>{agent.run_count}</dd></div>
              <div><dt>Last run</dt><dd>{time(agent.last_run_at)}</dd></div>
              <div><dt>Phase</dt><dd>{nice(agent.state.phase)}</dd></div>
            </dl>
            {agent.state.pending_approvals.length > 0 && <a className="inbox-text-link" href="#approvals">{agent.state.pending_approvals.length} waiting in Approval Inbox</a>}
            {agent.state.phase === 'awaiting_photo_selection' && agent.state.picker_uri?.startsWith('https://') &&
              <a className="inbox-button" data-tone="primary" href={agent.state.picker_uri} target="_blank" rel="noopener noreferrer">
                <ImageIcon size={14} /> Select receipts in Google Photos</a>}
            {agent.state.phase === 'awaiting_quotes' && agent.state.notes?.[0] && <p>{agent.state.notes[0]}</p>}
            {agent.state.last_error && <p className="inbox-error">{agent.state.last_error}</p>}
            <details><summary>Plan · {agent.workflow_plan.template} · {agent.workflow_plan.steps.length} steps</summary>
              <ol className="agent-plan">{agent.workflow_plan.steps.map((step) => <li key={step.id}>
                {serviceIcon(step.service, 13)} {step.label}{step.tier_hint === 2 && <Tag tone="amber">Tier 2</Tag>}</li>)}</ol>
            </details>
            <div className="inbox-actions">
              <button type="button" className="inbox-button" disabled={busy || agent.id === activeId}
                onClick={() => void control(`agents/${agent.id}/switch`, { reason: 'Switch To from My Agents' })}><Shuffle size={14} /> Switch to</button>
              {['active', 'input_required'].includes(agent.status) ? <button type="button" className="inbox-button" disabled={busy}
                onClick={() => void control(`agents/${agent.id}/pause`)}><Pause size={14} /> Pause</button> :
                <button type="button" className="inbox-button" disabled={busy || data.profile?.halted || agent.status === 'archived'}
                  onClick={() => void control(`agents/${agent.id}/resume`)}><Play size={14} /> Resume</button>}
              <button type="button" className="inbox-button" data-tone="danger" disabled={busy || agent.status === 'archived'}
                onClick={() => window.confirm(`Cancel "${agent.name}"? Its logs and artifacts are kept.`) && void control(`agents/${agent.id}/cancel`)}>
                <Trash2 size={14} /> Cancel</button>
            </div>
          </article>;
        })}</div>}
    </section>

    <section className="inbox-panel">
      <div className="inbox-panel-head"><h2><FolderOpen size={18} />Workspace artifacts</h2><Tag>{artifacts.length} items</Tag></div>
      {!artifacts.length ? <div className="inbox-empty">Sheets, Docs, Drive folders, and files created by agents appear here.</div> :
        <div className="agent-artifacts">{artifacts.map((artifact) => <article key={artifact.id} className="agent-artifact" data-testid="artifact-card" data-service={artifact.service}>
          <div className="agent-artifact-icon">{serviceIcon(artifact.service, 20)}</div>
          <div>
            <strong>{artifact.title}</strong>
            <span>{artifactLabel[artifact.service]} · {artifact.agent_id ? names.get(artifact.agent_id) ?? 'Agent' : 'Clam'} · {time(artifact.updated_at)}</span>
            {artifact.summary && <p>{artifact.summary}</p>}
          </div>
          {artifact.url ? <a className="inbox-button" href={artifact.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> Open</a>
            : <button type="button" className="inbox-button" onClick={() => setPreview(artifact)} data-testid="artifact-open">Preview</button>}
        </article>)}</div>}
    </section>

    <div className="inbox-stack">
      <section className="inbox-panel">
        <div className="inbox-panel-head"><h2><ScrollText size={18} />Live agent logs</h2>
          <div className="inbox-actions">
            <label>Agent <select value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)}>
              <option value="">All agents</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select></label>
            <label>Service <select value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value)}>
              <option value="">All services</option>{[...allServices, 'policy', 'system'].map((service) => <option key={service} value={service}>{serviceLabel[service]}</option>)}
            </select></label>
          </div>
        </div>
        {!logs.length ? <div className="inbox-empty">Agent steps stream here as they happen.</div> : <div className="inbox-table-wrap"><table>
          <thead><tr><th>Time · agent</th><th>Service</th><th>Action</th><th>Verdict</th><th>Verified</th><th>Trace</th></tr></thead>
          <tbody>{logs.map((entry) => <tr key={entry.id} data-testid="log-row" data-service={entry.service}>
            <td className="agent-log-when">{time(entry.created_at)}<small>{entry.agent_name} · step {entry.step_index}</small></td>
            <td><span className="agent-chip">{serviceIcon(entry.service, 12)}{serviceLabel[entry.service] ?? entry.service}</span></td>
            <td><strong>{nice(entry.action_name)}</strong><small>{entry.input_summary}</small><small>→ {entry.output_summary}</small></td>
            <td><Tag tone={verdictTone[entry.policy_verdict]}>{entry.policy_verdict.replace(/_/g, ' ')}</Tag><small>{entry.policy_rule_id}</small></td>
            <td>{entry.verified ? <Tag tone="green">Verified</Tag> : <Tag tone="amber">Not verified</Tag>}</td>
            <td>{entry.trace_step_hash && entry.mission_run_id ? <button type="button" className="inbox-text-link" onClick={() => onTrace(entry.mission_run_id!)}
              title={'SHA-256 ' + entry.trace_step_hash}><code>{entry.trace_step_hash.slice(0, 10)}</code></button> : <code>{entry.trace_step_hash?.slice(0, 10) ?? '—'}</code>}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>
      <section className="inbox-panel">
        <div className="inbox-panel-head"><h2><History size={18} />Agent switch timeline</h2></div>
        {!switches.length ? <div className="inbox-empty">Every agent creation and switch is recorded here.</div> :
          <ol className="agent-timeline" data-layout="columns">{switches.map((entry) => <li key={entry.id} data-testid="switch-row">
            <strong>{entry.to_agent_name}</strong>
            <span>{entry.from_agent_name ? `from ${entry.from_agent_name}` : 'first active agent'}</span>
            <span><Tag>{nice(entry.switched_by)}</Tag> {time(entry.created_at)}</span>
            <p>{entry.reason}</p>
          </li>)}</ol>}
      </section>
    </div>
    {preview && <ArtifactPreview artifact={preview} onClose={closePreview} />}
  </div>;
}
