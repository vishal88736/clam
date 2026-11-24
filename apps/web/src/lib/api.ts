import type {
  AgentRecord,
  AgentTokenInfo,
  ApprovalView,
  AuditLogEntry,
  EphemeralEmail,
  LlmProvider,
  MailMode,
  McpToolName,
  PolicyEvaluationTrace,
  PolicyIR,
  SensitiveCategory,
} from '@clam/shared';

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') || 'http://localhost:4000';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers as Record<string, string> | undefined),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const json = (await res.json()) as { error?: string | { message?: string } };
      if (typeof json.error === 'string') errMsg = json.error;
      else if (json.error) errMsg = JSON.stringify(json.error);
    } catch {
      // keep status text
    }
    throw new Error(errMsg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface OverviewResponse {
  mail_mode: MailMode;
  gmail_status: {
    mode: MailMode;
    oauthConfigured: boolean;
    connected: boolean;
    email: string | null;
    scopes: string[];
  };
  zero_retention_verified: boolean;
  active_agents_count: number;
  total_agents_count: number;
  pending_approvals_count: number;
  metrics: {
    total_intercepted: number;
    allowed: number;
    blocked: number;
    pending_decisions: number;
    breakdown: Record<string, number>;
  };
}

export interface SettingsResponse {
  gmail: OverviewResponse['gmail_status'];
  llm: {
    provider: LlmProvider;
    model: string;
    ollamaBaseUrl: string;
    hasOpenaiKey: boolean;
    hasAnthropicKey: boolean;
    hasGeminiKey: boolean;
  };
  channels: {
    slack: {
      configured: boolean;
      channelId: string;
      hasBotToken: boolean;
      hasWebhookUrl: boolean;
      hasSigningSecret: boolean;
      callbackUrl: string;
    };
    telegram: {
      configured: boolean;
      chatId: string;
      hasBotToken: boolean;
      hasWebhookSecret: boolean;
      callbackUrl: string;
    };
    whatsapp: {
      configured: boolean;
      phoneNumberId: string;
      recipientNumber: string;
      hasAccessToken: boolean;
      hasVerifyToken: boolean;
      hasAppSecret: boolean;
      callbackUrl: string;
    };
  };
}

export const clamApi = {
  getOverview: () => apiFetch<OverviewResponse>('/api/overview'),
  getAgents: () => apiFetch<{ agents: AgentRecord[] }>('/api/agents'),
  getAgent: (id: string) =>
    apiFetch<{ agent: AgentRecord; tokens: AgentTokenInfo[] }>(`/api/agents/${id}`),
  createAgent: (body: {
    name: string;
    description?: string;
    raw_rules: string;
    overridden_sensitive_categories?: SensitiveCategory[];
    rate_limit_per_min?: number;
  }) =>
    apiFetch<{ agent: AgentRecord; token: AgentTokenInfo; raw_token: string }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: Partial<{
      name: string;
      description: string;
      raw_rules: string;
      status: 'active' | 'paused';
      rate_limit_per_min: number;
      overridden_sensitive_categories: SensitiveCategory[];
    }>
  ) =>
    apiFetch<{ agent: AgentRecord }>(`/api/agents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) => apiFetch<void>(`/api/agents/${id}`, { method: 'DELETE' }),
  compilePreview: (
    id: string,
    raw_rules: string,
    overridden_sensitive_categories?: SensitiveCategory[]
  ) =>
    apiFetch<{ policy_ir: PolicyIR }>(`/api/agents/${id}/compile-preview`, {
      method: 'POST',
      body: JSON.stringify({ raw_rules, overridden_sensitive_categories }),
    }),
  simulatePolicy: (
    id: string,
    body: {
      tool: McpToolName;
      raw_rules_override?: string;
      sandbox_email_id?: string;
      custom_email?: {
        from: string;
        subject: string;
        body: string;
        attachmentNames?: string[];
      };
      outbound?: { to?: string; subject?: string; body?: string };
    }
  ) =>
    apiFetch<{ trace: PolicyEvaluationTrace; evaluated_policy_ir: PolicyIR }>(
      `/api/agents/${id}/simulate`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    ),
  issueToken: (agentId: string, label: string) =>
    apiFetch<{ token: AgentTokenInfo; raw_token: string }>(`/api/agents/${agentId}/tokens`, {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),
  rotateToken: (agentId: string, tokenId?: string) =>
    apiFetch<{ token: AgentTokenInfo; raw_token: string }>(
      `/api/agents/${agentId}/tokens/rotate`,
      {
        method: 'POST',
        body: JSON.stringify({ token_id: tokenId }),
      }
    ),
  revokeToken: (agentId: string, tokenId: string) =>
    apiFetch<void>(`/api/agents/${agentId}/tokens/${tokenId}`, { method: 'DELETE' }),
  getMcpConfig: (agentId: string, token?: string) =>
    apiFetch<{
      snippets: Record<
        'claude_desktop' | 'cursor_codex' | 'gemini_cli' | 'curl_http',
        { filename: string; content: string }
      >;
    }>(`/api/agents/${agentId}/mcp-config${token ? `?token=${encodeURIComponent(token)}` : ''}`),
  getSandboxEmails: () =>
    apiFetch<{ emails: EphemeralEmail[]; state: { emailCount: number; draftsCount: number; sentCount: number } }>(
      '/api/sandbox/emails'
    ),
  getApprovals: (status?: string) =>
    apiFetch<{ approvals: ApprovalView[] }>(
      `/api/approvals${status ? `?status=${encodeURIComponent(status)}` : ''}`
    ),
  approveRequest: (
    id: string,
    edited?: { to?: string; subject?: string; body?: string; label?: string }
  ) =>
    apiFetch<{ approval: ApprovalView }>(`/api/approvals/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify(edited ?? {}),
    }),
  denyRequest: (id: string) =>
    apiFetch<{ approval: ApprovalView }>(`/api/approvals/${id}/deny`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  getAuditLogs: (params?: {
    agent_id?: string;
    decision?: string;
    mcp_tool?: string;
    from?: string;
    search?: string;
    limit?: number;
  }) => {
    const sp = new URLSearchParams();
    if (params?.agent_id) sp.set('agent_id', params.agent_id);
    if (params?.decision) sp.set('decision', params.decision);
    if (params?.mcp_tool) sp.set('mcp_tool', params.mcp_tool);
    if (params?.from) sp.set('from', params.from);
    if (params?.search) sp.set('search', params.search);
    if (params?.limit) sp.set('limit', String(params.limit));
    const qs = sp.toString();
    return apiFetch<{ logs: AuditLogEntry[] }>(`/api/audit${qs ? `?${qs}` : ''}`);
  },
  getSettings: () => apiFetch<SettingsResponse>('/api/settings'),
  setMailMode: (mode: MailMode) =>
    apiFetch<{ mode: MailMode }>('/api/settings/mail-mode', {
      method: 'PATCH',
      body: JSON.stringify({ mode }),
    }),
  updateLlmSettings: (body: {
    provider: LlmProvider;
    model?: string;
    openaiApiKey?: string;
    anthropicApiKey?: string;
    geminiApiKey?: string;
    ollamaBaseUrl?: string;
  }) =>
    apiFetch<{ ok: boolean }>('/api/settings/llm', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  updateChannels: (body: Record<string, unknown>) =>
    apiFetch<{ ok: boolean }>('/api/settings/channels', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  sendTestApproval: () =>
    apiFetch<{ approval: ApprovalView }>('/api/channels/test-approval', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  startGmailOAuth: (scopes?: ('readonly' | 'compose' | 'modify')[]) =>
    apiFetch<{ auth_url: string }>('/api/auth/gmail/start', {
      method: 'POST',
      body: JSON.stringify({ scopes }),
    }),
  disconnectGmail: () =>
    apiFetch<{ ok: boolean; mode: MailMode }>('/api/auth/gmail/disconnect', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
};
