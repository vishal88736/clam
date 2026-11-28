'use client';

import { ArrowRight, Bot, ListChecks, Pause, Play, Plug, Sparkles, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { nice, platform, type Agent, type PlatformData } from './AgentConsole';
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
    {needsGoogle && <Link href="/settings" className="home-callout">
      <Plug size={18} /><span><strong>Connect your Google account</strong> so agents can work on your real Gmail, Calendar and Drive. One click.</span><ArrowRight size={16} />
    </Link>}
    {!aiReady && <Link href="/settings#ai" className="home-callout" data-tone="amber">
      <Sparkles size={18} /><span><strong>Choose an AI provider</strong> to make agents from plain language. Without one, only a few fixed workflows work.</span><ArrowRight size={16} />
    </Link>}
    <form className="home-ask" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <label htmlFor="home-instruction">What should your agent do?</label>
      <textarea id="home-instruction" rows={3} maxLength={4000} value={instruction} disabled={creating}
        placeholder="For example: when someone asks about pricing, reply with our plans and ask for a call"
        onChange={(event) => setInstruction(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && instruction.trim().length >= 4) void create(); }} />
      <div className="home-ideas" aria-label="Ideas">
        {ideas.map((idea) => <button key={idea} type="button" className="home-idea" disabled={creating} onClick={() => setInstruction(idea)}>{idea}</button>)}
      </div>
      <div className="home-ask-foot">
        <small>{creating ? 'Planning your agent. This can take up to a minute with a local AI.' : 'Agents keep running on their own. Anything they send waits for your approval unless your rules allow it.'}</small>
        <button type="submit" className="inbox-button" data-tone="primary" disabled={creating || instruction.trim().length < 4}>
          <Bot size={16} /> {creating ? 'Creating…' : 'Create agent'}</button>
      </div>
    </form>

    {waiting > 0 && <a href="#approvals" className="home-callout" data-tone="amber">
      <ListChecks size={18} /><span><strong>{waiting} {waiting === 1 ? 'item is' : 'items are'} waiting for your approval</strong>: replies, sends or changes your agents prepared.</span><ArrowRight size={16} />
    </a>}

    <section className="home-agents" aria-label="Your agents">
      <h2>Your agents</h2>
      {!agents.length ? <p className="home-empty">No agents yet. Describe one above.</p> : <>
      {!working.length && <p className="home-empty">None running right now.</p>}
      <AgentList list={working} />
      {resting.length > 0 && <details className="home-resting">
        <summary>Finished or paused ({resting.length})</summary>
        <AgentList list={resting} />
      </details>}
      </>}
      {agents.length > 0 && <a className="inbox-text-link" href="#agents">See step-by-step logs and created files →</a>}
    </section>
  </div>;

  function AgentList({ list }: { list: Agent[] }) {
    return <ul>
        {list.map((agent) => {
          const [sentence, tone] = agentSentence(agent);
          const running = agent.status === 'active' || agent.status === 'input_required';
          return <li key={agent.id} className="home-agent" data-testid="home-agent">
            <div className="home-agent-main">
              <strong>{agent.name}</strong>
              <p>{agent.goal_prompt}</p>
              <span className="home-agent-status" data-tone={tone}>{sentence}</span>
            </div>
            <div className="home-agent-actions">
              {running ? <button type="button" className="inbox-button" disabled={busy === agent.id} onClick={() => void control(agent, 'pause')} aria-label={'Pause ' + agent.name}><Pause size={15} /> Pause</button>
                : agent.status !== 'halted' && <button type="button" className="inbox-button" disabled={busy === agent.id} onClick={() => void control(agent, 'resume')} aria-label={'Resume ' + agent.name}><Play size={15} /> {agent.status === 'completed' ? 'Run again' : 'Resume'}</button>}
              <button type="button" className="inbox-button" disabled={busy === agent.id} onClick={() => void control(agent, 'cancel')} aria-label={'Remove ' + agent.name}><Trash2 size={15} /></button>
            </div>
          </li>;
        })}
      </ul>;
  }
}
