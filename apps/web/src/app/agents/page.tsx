'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
} from 'lucide-react';
import {
  DEFAULT_SENSITIVE_CATEGORIES,
  SENSITIVE_CATEGORY_META,
  type AgentRecord,
  type AgentTokenInfo,
  type EphemeralEmail,
  type McpToolName,
  type PolicyEvaluationTrace,
  type PolicyIR,
  type SensitiveCategory,
} from '@clam/shared';
import { useConsole } from '@/components/ConsoleContext';
import { DecisionBadge } from '@/components/DecisionBadge';
import { clamApi } from '@/lib/api';

type StudioTab = 'rules' | 'simulator' | 'mcp';
type ConfigClientTab = 'claude_desktop' | 'cursor_codex' | 'gemini_cli' | 'curl_http';

export default function AgentsStudioPage() {
  const { refreshOverview } = useConsole();
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [tokens, setTokens] = useState<AgentTokenInfo[]>([]);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [tab, setTab] = useState<StudioTab>('rules');

  // Rules editor state
  const [draftRules, setDraftRules] = useState('');
  const [previewIr, setPreviewIr] = useState<PolicyIR | null>(null);
  const [overrides, setOverrides] = useState<SensitiveCategory[]>([]);
  const [savingRules, setSavingRules] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  // Simulator state
  const [sandboxEmails, setSandboxEmails] = useState<EphemeralEmail[]>([]);
  const [simTool, setSimTool] = useState<McpToolName>('read_email');
  const [simSourceMode, setSimSourceMode] = useState<'sandbox' | 'custom'>('sandbox');
  const [simEmailId, setSimEmailId] = useState<string>('');
  const [customEmail, setCustomEmail] = useState({
    from: 'billing@new-unknown-utility.io',
    subject: 'Electricity Invoice #88412 — Amount Due $142.80',
    body: 'Monthly utility billing statement for 612 kWh usage. Payment due December 10, 2026.',
  });
  const [simOutbound, setSimOutbound] = useState({
    to: 'kenji.host@airbnb-messages.example',
    subject: 'Re: Kyoto Arrival Time',
    body: 'Hi Kenji, arriving at 3:30 PM on Dec 20.',
  });
  const [simTrace, setSimTrace] = useState<PolicyEvaluationTrace | null>(null);
  const [simRunning, setSimRunning] = useState(false);

  // Connect MCP state
  const [configTab, setConfigTab] = useState<ConfigClientTab>('claude_desktop');
  const [snippets, setSnippets] = useState<
    Record<ConfigClientTab, { filename: string; content: string }> | null
  >(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // New Agent modal state
  const [showNewModal, setShowNewModal] = useState(false);
  const [newAgentForm, setNewAgentForm] = useState({
    name: '',
    description: '',
    raw_rules: 'Read bills and invoices for accounting. Never send or delete.',
  });
  const [creatingAgent, setCreatingAgent] = useState(false);

  const loadAgents = useCallback(async () => {
    const res = await clamApi.getAgents();
    setAgents(res.agents);
    if (!selectedId && res.agents.length > 0) {
      setSelectedId(res.agents[0].id);
    }
  }, [selectedId]);

  useEffect(() => {
    void loadAgents();
    void clamApi.getSandboxEmails().then((res) => {
      setSandboxEmails(res.emails);
      if (res.emails.length > 0) setSimEmailId(res.emails[0].id);
    });
  }, [loadAgents]);

  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedAgent) return;
    setDraftRules(selectedAgent.raw_rules);
    setPreviewIr(selectedAgent.policy_ir);
    setOverrides(selectedAgent.policy_ir.overridden_sensitive_categories ?? []);
    setSimTrace(null);
    setSaveNotice(null);

    void clamApi.getAgent(selectedAgent.id).then((res) => setTokens(res.tokens));
    void clamApi
      .getMcpConfig(selectedAgent.id, revealedToken ?? undefined)
      .then((res) => setSnippets(res.snippets));
  }, [selectedAgent, revealedToken]);

  // Live debounced compilation preview when editing English rules
  useEffect(() => {
    if (!selectedAgent) return;
    const handle = setTimeout(() => {
      void clamApi
        .compilePreview(selectedAgent.id, draftRules, overrides)
        .then((res) => setPreviewIr(res.policy_ir))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(handle);
  }, [draftRules, overrides, selectedAgent]);

  async function handleSaveRules() {
    if (!selectedAgent) return;
    setSavingRules(true);
    setSaveNotice(null);
    try {
      const res = await clamApi.updateAgent(selectedAgent.id, {
        raw_rules: draftRules,
        overridden_sensitive_categories: overrides,
      });
      setAgents((prev) => prev.map((a) => (a.id === res.agent.id ? res.agent : a)));
      setPreviewIr(res.agent.policy_ir);
      setSaveNotice('Compiled & enforced across live MCP proxy.');
      await refreshOverview();
    } finally {
      setSavingRules(false);
    }
  }

  async function toggleAgentStatus() {
    if (!selectedAgent) return;
    const nextStatus = selectedAgent.status === 'active' ? 'paused' : 'active';
    const res = await clamApi.updateAgent(selectedAgent.id, { status: nextStatus });
    setAgents((prev) => prev.map((a) => (a.id === res.agent.id ? res.agent : a)));
    await refreshOverview();
  }

  async function handleRunSimulation() {
    if (!selectedAgent) return;
    setSimRunning(true);
    try {
      const needsEmail =
        simTool === 'read_email' ||
        simTool === 'list_emails' ||
        simTool === 'search_emails' ||
        simTool === 'archive_email' ||
        simTool === 'apply_label';
      const needsOutbound = simTool === 'create_draft' || simTool === 'send_email';

      const res = await clamApi.simulatePolicy(selectedAgent.id, {
        tool: simTool,
        raw_rules_override: draftRules,
        sandbox_email_id: needsEmail && simSourceMode === 'sandbox' ? simEmailId : undefined,
        custom_email: needsEmail && simSourceMode === 'custom' ? customEmail : undefined,
        outbound: needsOutbound ? simOutbound : undefined,
      });
      setSimTrace(res.trace);
    } finally {
      setSimRunning(false);
    }
  }

  async function handleIssueToken() {
    if (!selectedAgent) return;
    const res = await clamApi.issueToken(selectedAgent.id, 'Client MCP Token');
    setRevealedToken(res.raw_token);
    setTokens((prev) => [res.token, ...prev]);
    const cfg = await clamApi.getMcpConfig(selectedAgent.id, res.raw_token);
    setSnippets(cfg.snippets);
  }

  async function handleRotateTokens() {
    if (!selectedAgent) return;
    const res = await clamApi.rotateToken(selectedAgent.id);
    setRevealedToken(res.raw_token);
    const detail = await clamApi.getAgent(selectedAgent.id);
    setTokens(detail.tokens);
    const cfg = await clamApi.getMcpConfig(selectedAgent.id, res.raw_token);
    setSnippets(cfg.snippets);
  }

  async function handleRevokeToken(tokenId: string) {
    if (!selectedAgent) return;
    await clamApi.revokeToken(selectedAgent.id, tokenId);
    const detail = await clamApi.getAgent(selectedAgent.id);
    setTokens(detail.tokens);
  }

  async function handleCreateAgent(e: React.FormEvent) {
    e.preventDefault();
    if (!newAgentForm.name.trim()) return;
    setCreatingAgent(true);
    try {
      const res = await clamApi.createAgent(newAgentForm);
      setAgents((prev) => [...prev, res.agent]);
      setSelectedId(res.agent.id);
      setRevealedToken(res.raw_token);
      setTab('mcp');
      setShowNewModal(false);
      setNewAgentForm({
        name: '',
        description: '',
        raw_rules: 'Read bills and invoices for accounting. Never send or delete.',
      });
      await refreshOverview();
    } finally {
      setCreatingAgent(false);
    }
  }

  async function handleDeleteAgent() {
    if (!selectedAgent) return;
    await clamApi.deleteAgent(selectedAgent.id);
    const remaining = agents.filter((a) => a.id !== selectedAgent.id);
    setAgents(remaining);
    setSelectedId(remaining[0]?.id ?? '');
    await refreshOverview();
  }

  function copyText(key: string, value: string) {
    void navigator.clipboard.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  }

  function toggleSensitiveOverride(cat: SensitiveCategory) {
    setOverrides((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-display">Agents & Rules Studio</h1>
          <p className="text-sm text-ink-secondary mt-0.5">
            Write natural-English security policies, inspect compiled deterministic gates, and test live dry-runs.
          </p>
        </div>
        <button
          onClick={() => setShowNewModal(true)}
          className="btn-primary inline-flex items-center gap-1.5 px-3.5 py-2 rounded text-xs font-medium"
        >
          <Plus className="w-3.5 h-3.5" />
          New Agent
        </button>
      </div>

      {/* Master-Detail Split Pane */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* Left Agent Rail */}
        <div className="lg:col-span-3 border border-hairline rounded bg-surface divide-y divide-hairline">
          <div className="px-3.5 py-2.5 text-[11px] font-mono uppercase tracking-wider text-ink-tertiary">
            Registered Agents ({agents.length})
          </div>
          {agents.map((ag) => {
            const active = ag.id === selectedAgent?.id;
            return (
              <button
                key={ag.id}
                onClick={() => {
                  setRevealedToken(null);
                  setSelectedId(ag.id);
                }}
                className={`w-full text-left px-3.5 py-3 transition-colors duration-150 ${
                  active ? 'bg-elevated' : 'hover:bg-elevated/40'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink-primary truncate">
                    {ag.name}
                  </span>
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      ag.status === 'active' ? 'bg-emerald-matte' : 'bg-ink-tertiary'
                    }`}
                  />
                </div>
                <div className="text-xs text-ink-secondary mt-1 line-clamp-2">
                  {ag.description || ag.raw_rules}
                </div>
                <div className="flex items-center gap-2 mt-2 text-[11px] font-mono text-ink-tertiary tabular-nums">
                  <span>{ag.policy_ir.semantic_allow_scopes.length} scopes</span>
                  <span>·</span>
                  <span>{ag.policy_ir.hard_denied_actions.length} hard-deny</span>
                </div>
              </button>
            );
          })}
        </div>

        {/* Right Workspace */}
        {selectedAgent ? (
          <div className="lg:col-span-9 border border-hairline rounded bg-surface">
            {/* Agent Header */}
            <div className="p-4 lg:px-5 border-b border-hairline flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="text-base font-semibold tracking-display">{selectedAgent.name}</h2>
                  <span className="font-mono text-[11px] text-ink-tertiary px-1.5 py-0.5 rounded border border-hairline bg-canvas">
                    {selectedAgent.id}
                  </span>
                </div>
                <p className="text-xs text-ink-secondary mt-0.5">{selectedAgent.description}</p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={toggleAgentStatus}
                  className={`px-2.5 py-1.5 rounded border text-xs font-medium transition-colors duration-150 ${
                    selectedAgent.status === 'active'
                      ? 'bg-emerald-fill text-emerald-matte border-emerald-matte/25'
                      : 'bg-elevated text-ink-secondary border-hairline'
                  }`}
                >
                  {selectedAgent.status === 'active' ? 'Active' : 'Paused'}
                </button>
                {agents.length > 1 && (
                  <button
                    onClick={handleDeleteAgent}
                    className="p-1.5 rounded border border-hairline text-ink-secondary hover:text-crimson-matte hover:border-crimson-matte/30 transition-colors duration-150"
                    title="Delete Agent"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* 3 Workspace Tabs */}
            <div className="px-4 lg:px-5 border-b border-hairline flex items-center gap-6 text-xs font-medium">
              {(
                [
                  { id: 'rules', label: 'Plain-English Rules' },
                  { id: 'simulator', label: 'Policy Simulator' },
                  { id: 'mcp', label: 'Connect via MCP' },
                ] as { id: StudioTab; label: string }[]
              ).map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`py-3 border-b-2 transition-colors duration-150 ${
                    tab === t.id
                      ? 'border-ink-primary text-ink-primary'
                      : 'border-transparent text-ink-secondary hover:text-ink-primary'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* TAB 1: Plain-English Rules */}
            {tab === 'rules' && (
              <div className="p-4 lg:p-5 grid grid-cols-1 xl:grid-cols-12 gap-5">
                <div className="xl:col-span-6 space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-ink-primary mb-2">
                      Natural-English Policy Instructions
                    </label>
                    <textarea
                      value={draftRules}
                      onChange={(e) => setDraftRules(e.target.value)}
                      rows={6}
                      className="w-full rounded border border-hairline bg-canvas px-3.5 py-3 text-sm text-ink-primary leading-relaxed focus:outline-none focus:border-ink-secondary"
                      placeholder="e.g., Read flight, hotel and booking emails and build my itinerary. Draft replies to hosts for me to review. Never send."
                    />
                    <div className="flex items-center justify-between mt-3">
                      <span className="text-[11px] font-mono text-ink-tertiary">
                        {previewIr?.compiler_mode === 'deterministic_heuristic'
                          ? 'Compiled offline (deterministic heuristic)'
                          : `Compiled via ${previewIr?.compiler_mode ?? 'heuristic'}`}
                      </span>
                      <button
                        onClick={handleSaveRules}
                        disabled={savingRules}
                        className="btn-primary px-3.5 py-1.5 rounded text-xs font-medium"
                      >
                        {savingRules ? 'Compiling…' : 'Save & Enforce Policy'}
                      </button>
                    </div>
                    {saveNotice && (
                      <div className="mt-2.5 text-xs text-emerald-matte font-medium">
                        {saveNotice}
                      </div>
                    )}
                  </div>

                  {previewIr && previewIr.warnings.length > 0 && (
                    <div className="p-3 rounded border border-amber-matte/30 bg-amber-fill space-y-1">
                      {previewIr.warnings.map((w, idx) => (
                        <div key={idx} className="flex items-start gap-2 text-xs text-amber-matte">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <span>{w}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Sensitive Category Guard Overrides */}
                  <div className="border border-hairline rounded bg-canvas p-3.5 space-y-2.5">
                    <div className="flex items-center gap-2 text-xs font-medium text-ink-primary">
                      <Shield className="w-3.5 h-3.5 text-emerald-matte" />
                      Always-On Sensitive Category Protections
                    </div>
                    <p className="text-[11px] text-ink-secondary">
                      Blocked deterministically unless explicitly overridden with confirmation below.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 pt-1">
                      {DEFAULT_SENSITIVE_CATEGORIES.map((cat) => {
                        const isOverridden = overrides.includes(cat);
                        return (
                          <label
                            key={cat}
                            className="flex items-center justify-between px-2.5 py-1.5 rounded border border-hairline bg-surface text-xs cursor-pointer"
                          >
                            <span className="text-ink-primary">
                              {SENSITIVE_CATEGORY_META[cat].label}
                            </span>
                            <input
                              type="checkbox"
                              checked={!isOverridden}
                              onChange={() => toggleSensitiveOverride(cat)}
                              className="accent-emerald-500"
                              title="Checked = Protected (Denied)"
                            />
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Right: Compiled Policy Breakdown */}
                <div className="xl:col-span-6 space-y-4">
                  <div className="text-xs font-medium text-ink-primary">
                    Compiled Policy Breakdown (IR v1)
                  </div>

                  {previewIr && (
                    <div className="space-y-3.5">
                      {/* Action Gates */}
                      <div className="border border-hairline rounded bg-canvas p-3.5 space-y-3">
                        <div className="text-[11px] font-mono uppercase tracking-wider text-ink-tertiary">
                          Deterministic Action Gates
                        </div>
                        <div className="space-y-2 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-ink-secondary">Allowed</span>
                            <div className="flex flex-wrap gap-1 justify-end">
                              {previewIr.allowed_actions.length > 0 ? (
                                previewIr.allowed_actions.map((a) => (
                                  <span
                                    key={a}
                                    className="px-2 py-0.5 rounded bg-emerald-fill text-emerald-matte border border-emerald-matte/25 font-mono text-[11px]"
                                  >
                                    {a}
                                  </span>
                                ))
                              ) : (
                                <span className="text-ink-tertiary font-mono">none</span>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center justify-between gap-2">
                            <span className="text-ink-secondary">Ask Me First</span>
                            <div className="flex flex-wrap gap-1 justify-end">
                              {previewIr.ask_first_actions.length > 0 ? (
                                previewIr.ask_first_actions.map((a) => (
                                  <span
                                    key={a}
                                    className="px-2 py-0.5 rounded bg-amber-fill text-amber-matte border border-amber-matte/25 font-mono text-[11px]"
                                  >
                                    {a}
                                  </span>
                                ))
                              ) : (
                                <span className="text-ink-tertiary font-mono">none</span>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center justify-between gap-2">
                            <span className="text-ink-secondary">Hard Denied</span>
                            <div className="flex flex-wrap gap-1 justify-end">
                              {previewIr.hard_denied_actions.length > 0 ? (
                                previewIr.hard_denied_actions.map((a) => (
                                  <span
                                    key={a}
                                    className="px-2 py-0.5 rounded bg-crimson-fill text-crimson-matte border border-crimson-matte/25 font-mono text-[11px]"
                                  >
                                    {a}
                                  </span>
                                ))
                              ) : (
                                <span className="text-ink-tertiary font-mono">none</span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Semantic Allow Scopes */}
                      <div className="border border-hairline rounded bg-canvas p-3.5 space-y-2.5">
                        <div className="text-[11px] font-mono uppercase tracking-wider text-ink-tertiary">
                          Semantic Allow Scopes ({previewIr.semantic_allow_scopes.length})
                        </div>
                        {previewIr.semantic_allow_scopes.length === 0 ? (
                          <div className="text-xs text-ink-tertiary">
                            No semantic scopes matched. Default-deny blocks all reads.
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {previewIr.semantic_allow_scopes.map((sc) => (
                              <div
                                key={sc.id}
                                className="px-3 py-2 rounded border border-hairline bg-surface"
                              >
                                <div className="flex items-center justify-between">
                                  <span className="text-xs font-medium text-ink-primary">
                                    {sc.label}
                                  </span>
                                  <span className="font-mono text-[11px] text-emerald-matte">
                                    {sc.id}
                                  </span>
                                </div>
                                <div className="text-[11px] text-ink-secondary mt-0.5">
                                  {sc.description}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Clause Attribution */}
                      <div className="border border-hairline rounded bg-canvas p-3.5 space-y-2">
                        <div className="text-[11px] font-mono uppercase tracking-wider text-ink-tertiary">
                          Clause Attribution
                        </div>
                        <div className="divide-y divide-hairline">
                          {previewIr.rule_clauses.map((c) => (
                            <div key={c.id} className="py-2 first:pt-0 last:pb-0 text-xs">
                              <div className="flex items-center justify-between">
                                <span className="font-mono text-[11px] text-ink-tertiary">
                                  {c.id}
                                </span>
                                <span className="font-mono text-[11px] text-ink-secondary">
                                  {c.summary}
                                </span>
                              </div>
                              <div className="text-ink-primary mt-0.5">“{c.text}”</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 2: Policy Simulator */}
            {tab === 'simulator' && (
              <div className="p-4 lg:p-5 grid grid-cols-1 xl:grid-cols-12 gap-5">
                <div className="xl:col-span-6 space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-ink-primary mb-1.5">
                      Simulated MCP Tool
                    </label>
                    <select
                      value={simTool}
                      onChange={(e) => setSimTool(e.target.value as McpToolName)}
                      className="w-full rounded border border-hairline bg-canvas px-3 py-2 text-xs font-mono text-ink-primary"
                    >
                      <option value="read_email">read_email</option>
                      <option value="list_emails">list_emails</option>
                      <option value="create_draft">create_draft</option>
                      <option value="send_email">send_email</option>
                      <option value="archive_email">archive_email</option>
                      <option value="apply_label">apply_label</option>
                    </select>
                  </div>

                  {simTool === 'create_draft' || simTool === 'send_email' ? (
                    <div className="space-y-3 border border-hairline rounded bg-canvas p-3.5">
                      <div className="text-[11px] font-mono uppercase tracking-wider text-ink-tertiary">
                        Proposed Outbound Payload
                      </div>
                      <input
                        value={simOutbound.to}
                        onChange={(e) => setSimOutbound((s) => ({ ...s, to: e.target.value }))}
                        placeholder="To"
                        className="w-full rounded border border-hairline bg-surface px-3 py-1.5 text-xs"
                      />
                      <input
                        value={simOutbound.subject}
                        onChange={(e) => setSimOutbound((s) => ({ ...s, subject: e.target.value }))}
                        placeholder="Subject"
                        className="w-full rounded border border-hairline bg-surface px-3 py-1.5 text-xs"
                      />
                      <textarea
                        value={simOutbound.body}
                        onChange={(e) => setSimOutbound((s) => ({ ...s, body: e.target.value }))}
                        rows={4}
                        placeholder="Body"
                        className="w-full rounded border border-hairline bg-surface px-3 py-1.5 text-xs"
                      />
                    </div>
                  ) : (
                    <div className="space-y-3 border border-hairline rounded bg-canvas p-3.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-mono uppercase tracking-wider text-ink-tertiary">
                          Target Email Context
                        </span>
                        <div className="flex items-center gap-1 text-[11px]">
                          <button
                            onClick={() => setSimSourceMode('sandbox')}
                            className={`px-2 py-0.5 rounded border ${
                              simSourceMode === 'sandbox'
                                ? 'bg-elevated border-hairline text-ink-primary'
                                : 'border-transparent text-ink-secondary'
                            }`}
                          >
                            Sandbox Inbox
                          </button>
                          <button
                            onClick={() => setSimSourceMode('custom')}
                            className={`px-2 py-0.5 rounded border ${
                              simSourceMode === 'custom'
                                ? 'bg-elevated border-hairline text-ink-primary'
                                : 'border-transparent text-ink-secondary'
                            }`}
                          >
                            Custom Unknown Sender
                          </button>
                        </div>
                      </div>

                      {simSourceMode === 'sandbox' ? (
                        <select
                          value={simEmailId}
                          onChange={(e) => setSimEmailId(e.target.value)}
                          className="w-full rounded border border-hairline bg-surface px-3 py-2 text-xs text-ink-primary"
                        >
                          {sandboxEmails.map((em) => (
                            <option key={em.id} value={em.id}>
                              {em.subject} ({em.from.split('<')[0].trim()})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="space-y-2">
                          <input
                            value={customEmail.from}
                            onChange={(e) =>
                              setCustomEmail((c) => ({ ...c, from: e.target.value }))
                            }
                            placeholder="From (e.g. billing@new-unknown-utility.io)"
                            className="w-full rounded border border-hairline bg-surface px-3 py-1.5 text-xs font-mono"
                          />
                          <input
                            value={customEmail.subject}
                            onChange={(e) =>
                              setCustomEmail((c) => ({ ...c, subject: e.target.value }))
                            }
                            placeholder="Subject"
                            className="w-full rounded border border-hairline bg-surface px-3 py-1.5 text-xs"
                          />
                          <textarea
                            value={customEmail.body}
                            onChange={(e) =>
                              setCustomEmail((c) => ({ ...c, body: e.target.value }))
                            }
                            rows={4}
                            placeholder="Email Body"
                            className="w-full rounded border border-hairline bg-surface px-3 py-1.5 text-xs"
                          />
                        </div>
                      )}
                    </div>
                  )}

                  <button
                    onClick={handleRunSimulation}
                    disabled={simRunning}
                    className="btn-primary inline-flex items-center gap-1.5 px-4 py-2 rounded text-xs font-medium"
                  >
                    <Play className="w-3.5 h-3.5" />
                    {simRunning ? 'Evaluating…' : 'Run Policy Check'}
                  </button>
                </div>

                {/* Right: Live Pipeline Verdict */}
                <div className="xl:col-span-6 space-y-3">
                  <div className="text-xs font-medium text-ink-primary">
                    Live 3-Stage Enforcement Trace
                  </div>

                  {!simTrace ? (
                    <div className="border border-hairline rounded bg-canvas p-8 text-center text-xs text-ink-tertiary">
                      Pick an email or tool call and click <strong>Run Policy Check</strong> to watch
                      Stage A → Stage B → Stage C execute live.
                    </div>
                  ) : (
                    <div className="border border-hairline rounded bg-canvas p-4 space-y-4">
                      <div className="flex items-center justify-between">
                        <DecisionBadge decision={simTrace.decision} />
                        <span className="font-mono text-xs text-ink-secondary tabular-nums">
                          {simTrace.latency_ms} ms
                        </span>
                      </div>

                      <div className="space-y-2.5 text-xs">
                        <div className="p-3 rounded border border-hairline bg-surface">
                          <div className="flex items-center justify-between font-mono text-[11px]">
                            <span className="text-ink-tertiary">STAGE A · DETERMINISTIC GATE</span>
                            <span
                              className={
                                simTrace.stage_details.stage_a_passed
                                  ? 'text-emerald-matte'
                                  : 'text-crimson-matte'
                              }
                            >
                              {simTrace.stage_details.stage_a_passed ? 'PASS' : 'BLOCK'}
                            </span>
                          </div>
                          <div className="text-ink-primary mt-1">
                            {simTrace.stage_details.stage_a_reason}
                          </div>
                        </div>

                        <div className="p-3 rounded border border-hairline bg-surface">
                          <div className="flex items-center justify-between font-mono text-[11px]">
                            <span className="text-ink-tertiary">STAGE B · SEMANTIC CLASSIFIER</span>
                            <span className="text-ink-secondary tabular-nums">
                              {simTrace.stage_details.stage_b_executed
                                ? `${Math.round(simTrace.confidence * 100)}% conf`
                                : 'SKIPPED'}
                            </span>
                          </div>
                          <div className="text-ink-primary mt-1">
                            {simTrace.stage_details.stage_b_reason ?? 'Stopped at Stage A.'}
                          </div>
                          {simTrace.semantic_category && (
                            <div className="font-mono text-[11px] text-emerald-matte mt-1">
                              Scope / Category: {simTrace.semantic_category}
                            </div>
                          )}
                        </div>

                        <div className="p-3 rounded border border-hairline bg-surface">
                          <div className="flex items-center justify-between font-mono text-[11px]">
                            <span className="text-ink-tertiary">STAGE C · HITL APPROVAL GATE</span>
                            <span
                              className={
                                simTrace.stage_details.stage_c_triggered
                                  ? 'text-amber-matte'
                                  : 'text-ink-tertiary'
                              }
                            >
                              {simTrace.stage_details.stage_c_triggered
                                ? 'TRIGGERED'
                                : 'NOT TRIGGERED'}
                            </span>
                          </div>
                          <div className="text-ink-primary mt-1">
                            {simTrace.stage_details.stage_c_reason ??
                              'No human approval required for this verdict.'}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 3: Connect via MCP */}
            {tab === 'mcp' && (
              <div className="p-4 lg:p-5 space-y-5">
                {/* Scoped Token Management */}
                <div className="border border-hairline rounded bg-canvas p-4 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div>
                      <div className="text-xs font-medium text-ink-primary flex items-center gap-1.5">
                        <KeyRound className="w-3.5 h-3.5" />
                        Scoped Agent Bearer Tokens
                      </div>
                      <div className="text-[11px] text-ink-secondary mt-0.5">
                        Agents authenticate exclusively with revocable <span className="font-mono">clm_ag_...</span> tokens. Never Gmail OAuth credentials.
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleIssueToken}
                        className="btn-primary px-3 py-1.5 rounded text-xs font-medium"
                      >
                        Issue Token
                      </button>
                      <button
                        onClick={handleRotateTokens}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-hairline bg-surface text-xs font-medium text-ink-primary hover:bg-elevated"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Rotate All
                      </button>
                    </div>
                  </div>

                  {revealedToken && (
                    <div className="p-3 rounded border border-emerald-matte/30 bg-emerald-fill flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[11px] font-medium text-emerald-matte">
                          New Token Issued (shown once — injected into snippets below)
                        </div>
                        <div className="font-mono text-xs text-ink-primary truncate mt-0.5">
                          {revealedToken}
                        </div>
                      </div>
                      <button
                        onClick={() => copyText('raw_tok', revealedToken)}
                        className="px-2.5 py-1 rounded border border-emerald-matte/30 bg-surface text-xs font-medium inline-flex items-center gap-1 shrink-0"
                      >
                        {copiedKey === 'raw_tok' ? (
                          <Check className="w-3 h-3 text-emerald-matte" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        Copy
                      </button>
                    </div>
                  )}

                  <div className="divide-y divide-hairline border border-hairline rounded bg-surface">
                    {tokens.map((tok) => (
                      <div
                        key={tok.id}
                        className="px-3 py-2 flex items-center justify-between text-xs gap-3"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="font-mono text-ink-primary">{tok.token_prefix}</span>
                          <span className="text-ink-secondary truncate">{tok.label}</span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          {tok.revoked_at ? (
                            <span className="font-mono text-[11px] text-crimson-matte">
                              REVOKED
                            </span>
                          ) : (
                            <>
                              <span className="font-mono text-[11px] text-emerald-matte">
                                ACTIVE
                              </span>
                              <button
                                onClick={() => handleRevokeToken(tok.id)}
                                className="text-ink-tertiary hover:text-crimson-matte text-[11px] font-medium"
                              >
                                Revoke
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Copyable MCP Config Snippets */}
                <div className="border border-hairline rounded bg-canvas overflow-hidden">
                  <div className="px-3.5 border-b border-hairline flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-4 text-xs font-medium">
                      {(
                        [
                          { id: 'claude_desktop', label: 'Claude Desktop' },
                          { id: 'cursor_codex', label: 'Cursor / Codex' },
                          { id: 'gemini_cli', label: 'Gemini CLI' },
                          { id: 'curl_http', label: 'cURL / HTTP' },
                        ] as { id: ConfigClientTab; label: string }[]
                      ).map((ct) => (
                        <button
                          key={ct.id}
                          onClick={() => setConfigTab(ct.id)}
                          className={`py-2.5 border-b-2 transition-colors duration-150 ${
                            configTab === ct.id
                              ? 'border-ink-primary text-ink-primary'
                              : 'border-transparent text-ink-secondary hover:text-ink-primary'
                          }`}
                        >
                          {ct.label}
                        </button>
                      ))}
                    </div>

                    {snippets && (
                      <button
                        onClick={() => copyText(configTab, snippets[configTab].content)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-hairline bg-surface text-xs text-ink-primary hover:bg-elevated"
                      >
                        {copiedKey === configTab ? (
                          <Check className="w-3 h-3 text-emerald-matte" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        Copy Config
                      </button>
                    )}
                  </div>

                  {snippets && (
                    <div className="p-4">
                      <div className="text-[11px] font-mono text-ink-tertiary mb-2">
                        {snippets[configTab].filename}
                      </div>
                      <pre className="p-3.5 rounded border border-hairline bg-surface font-mono text-xs text-ink-primary overflow-x-auto leading-relaxed">
                        {snippets[configTab].content}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="lg:col-span-9 border border-hairline rounded bg-surface p-10 text-center text-sm text-ink-secondary">
            Select or create an agent to configure its semantic rules.
          </div>
        )}
      </div>

      {/* Create New Agent Modal */}
      {showNewModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
          onClick={() => setShowNewModal(false)}
        >
          <form
            onSubmit={handleCreateAgent}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg border border-hairline rounded bg-surface p-5 space-y-4"
          >
            <h2 className="text-base font-semibold tracking-display">Create Scoped Agent</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-ink-secondary mb-1">
                  Agent Name
                </label>
                <input
                  required
                  value={newAgentForm.name}
                  onChange={(e) => setNewAgentForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Quarterly Tax Assistant"
                  className="w-full rounded border border-hairline bg-canvas px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-secondary mb-1">
                  Description
                </label>
                <input
                  value={newAgentForm.description}
                  onChange={(e) =>
                    setNewAgentForm((f) => ({ ...f, description: e.target.value }))
                  }
                  placeholder="Purpose of this MCP client"
                  className="w-full rounded border border-hairline bg-canvas px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-secondary mb-1">
                  Plain-English Rules
                </label>
                <textarea
                  required
                  rows={4}
                  value={newAgentForm.raw_rules}
                  onChange={(e) => setNewAgentForm((f) => ({ ...f, raw_rules: e.target.value }))}
                  className="w-full rounded border border-hairline bg-canvas px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowNewModal(false)}
                className="px-3 py-1.5 rounded border border-hairline text-xs text-ink-secondary hover:text-ink-primary"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creatingAgent}
                className="btn-primary px-4 py-1.5 rounded text-xs font-medium"
              >
                {creatingAgent ? 'Creating…' : 'Create & Issue Token'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
