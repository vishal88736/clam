'use client';

import { ArrowRight, Bot, ListChecks, Pause, Play, Plug, Sparkles, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { nice, platform, serviceIcon, serviceLabel, type Agent, type PlatformData } from './AgentConsole';
import { Section } from './Section';
import type { OperatorSession } from './GoogleSession';

const ideas = [
  'Reply to the emails I would normally answer, in my style',
  'When a customer asks about my product, draft a reply',
  'Every day, save invoice PDFs to Drive and log them in a Google Sheet',
  'Add the dates from my kid’s school emails to my calendar',
];

const every = (agent: Agent) => {
  if (agent.schedule_mode === 'daily') return 'every day';
  if (agent.schedule_mode === 'weekly') return 'every week';
  const minutes = Math.max(1, Math.round((agent.interval_seconds ?? 300) / 60));
  return minutes >= 60 ? `every ${Math.round(minutes / 60)} h` : `every ${minutes} min`;
};

/** One plain sentence for what an agent is doing right now. */
export function agentSentence(agent: Agent): [string, 'green' | 'amber' | 'red' | 'neutral'] {
  const waiting = agent.state.pending_approvals.length;
  const tail = waiting ? ` · ${waiting} waiting for you` : '';
  if (agent.status === 'halted') return ['Stopped by the emergency stop', 'red'];
  if (agent.status === 'paused') return [agent.state.last_error ? 'Paused: ' + nice(agent.state.last_error) : 'Paused', 'neutral'];
  if (agent.status === 'completed') return ['Done' + tail, 'neutral'];
  if (agent.status === 'input_required') return [agent.state.phase === 'awaiting_photo_selection' ? 'Waiting for you to pick photos' : 'Waiting for your approval' + tail, 'amber'];
  if (agent.schedule_mode === 'one_shot') return ['Working on it…', 'green'];
  return [`Watching your mail ${every(agent)}` + tail, waiting ? 'amber' : 'green'];
}

/** Home: say what you want in plain words, see your agents, and what needs you. */
export function HomeView({ data, session, waiting, aiReady, onError }: {
  data: PlatformData; session: OperatorSession | null; waiting: number; aiReady: boolean; onError: (message: string) => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState('');
  // Removed agents and the bookkeeping records of direct MCP tool calls are not agents the user made.
  const agents = data.agents.filter((agent) => agent.status !== 'archived' && agent.workflow_plan.template !== 'interactive');
  const working = agents.filter((agent) => agent.status === 'active' || agent.status === 'input_required' || agent.state.pending_approvals.length > 0);
  const resting = agents.filter((agent) => !working.includes(agent));
  const needsGoogle = session?.google_enabled && session.live_enabled && (!session.user || !session.inboxes.length);

  const create = async () => {
    setCreating(true);
    try { await platform('agents', 'POST', { instruction: instruction.trim() }); setInstruction(''); await data.reload(); }
    catch (failure) { onError(failure instanceof Error ? nice(failure.message) : 'The agent could not be created.'); }
    finally { setCreating(false); }
  };
  const control = async (agent: Agent, action: 'pause' | 'resume' | 'cancel') => {
    if (action === 'cancel' && !window.confirm(`Remove "${agent.name}"? It stops for good and its waiting approvals are declined.`)) return;
    setBusy(agent.id);
    try { await platform(`agents/${agent.id}/${action}`, 'POST', {}); await data.reload(); }
    catch (failure) { onError(failure instanceof Error ? nice(failure.message) : 'Request failed'); }
    finally { setBusy(''); }
  };

  return <div className="home">
    {(needsGoogle || !aiReady) && <div className="home-setup">
      {needsGoogle && <Link href="/settings" className="callout">
        <span className="callout-icon"><Plug size={17} /></span>
        <span><strong>Connect your Google account</strong><small>So agents can work on your real Gmail, Calendar and Drive.</small></span>
        <ArrowRight size={16} />
      </Link>}
      {!aiReady && <Link href="/settings#ai" className="callout" data-tone="amber">
        <span className="callout-icon"><Sparkles size={17} /></span>
        <span><strong>Choose an AI provider</strong><small>Needed to turn plain language into agents.</small></span>
        <ArrowRight size={16} />
      </Link>}
    </div>}

    <form className="composer" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <label htmlFor="home-instruction">What should your agent do?</label>
      <p>Describe it the way you’d ask a colleague. Siftvane plans the steps and keeps the agent running.</p>
      <div className="composer-field">
        <textarea id="home-instruction" rows={3} maxLength={4000} value={instruction} disabled={creating}
          placeholder="When someone asks about pricing, reply with our plans and offer a call"
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && instruction.trim().length >= 4) void create(); }} />
        <button type="submit" className="composer-send" disabled={creating || instruction.trim().length < 4}>
          <Bot size={17} /> {creating ? 'Planning…' : 'Create agent'}</button>
      </div>
      <div className="composer-ideas" aria-label="Ideas to start from">
        {ideas.map((idea) => <button key={idea} type="button" disabled={creating} onClick={() => setInstruction(idea)}>{idea}</button>)}
      </div>
      <small className="composer-note">{creating ? 'Planning your agent. With a local AI this can take up to a minute.'
        : 'Replies and sends wait for your approval unless your rules allow them.'}</small>
    </form>

    {waiting > 0 && <a href="#approvals" className="callout" data-tone="amber">
      <span className="callout-icon"><ListChecks size={17} /></span>
      <span><strong>{waiting} {waiting === 1 ? 'thing needs' : 'things need'} your approval</strong><small>Replies, sends or changes your agents prepared.</small></span>
      <ArrowRight size={16} />
    </a>}

    <Section icon={<Bot size={18} />} title="Your agents" className="home-agents"
      intro={agents.length ? `${working.length} running, ${resting.length} finished or paused.` : 'Agents you create appear here.'}
      actions={agents.length > 0 && <a className="inbox-button" href="#agents">Logs and files</a>}>
      {!agents.length ? <p className="block-note">No agents yet. Describe one above to get started.</p> : <>
        {working.length ? <AgentList list={working} /> : <p className="block-note">Nothing is running right now.</p>}
        {resting.length > 0 && <details className="home-resting">
          <summary>Finished or paused <span className="count-pill">{resting.length}</span></summary>
          <AgentList list={resting} />
        </details>}
      </>}
    </Section>
  </div>;

  function AgentList({ list }: { list: Agent[] }) {
    return <ul className="agent-rows">
      {list.map((agent) => {
        const [sentence, tone] = agentSentence(agent);
        const running = agent.status === 'active' || agent.status === 'input_required';
        return <li key={agent.id} className="agent-row" data-testid="home-agent">
          <span className="agent-dot" data-tone={tone} aria-hidden="true" />
          <div className="agent-row-main">
            <strong>{agent.name}</strong>
            <p>{agent.goal_prompt}</p>
            <div className="agent-row-meta">
              <span className="agent-status" data-tone={tone}>{sentence}</span>
              <span className="agent-services">{agent.allowed_services.slice(0, 5).map((service) =>
                <span key={service} title={serviceLabel[service] ?? service}>{serviceIcon(service, 14)}</span>)}</span>
            </div>
          </div>
          <div className="agent-row-actions">
            {running ? <button type="button" className="inbox-button" disabled={busy === agent.id} onClick={() => void control(agent, 'pause')} aria-label={'Pause ' + agent.name}><Pause size={15} /> Pause</button>
              : agent.status !== 'halted' && <button type="button" className="inbox-button" disabled={busy === agent.id} onClick={() => void control(agent, 'resume')} aria-label={'Resume ' + agent.name}><Play size={15} /> {agent.status === 'completed' ? 'Run again' : 'Resume'}</button>}
            <button type="button" className="inbox-button icon-only" disabled={busy === agent.id} onClick={() => void control(agent, 'cancel')} aria-label={'Remove ' + agent.name} title="Remove"><Trash2 size={15} /></button>
          </div>
        </li>;
      })}
    </ul>;
  }
}
