'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Mail, Send, Shield, Sparkles } from 'lucide-react';
import type { ChannelDeliveryMap, LlmProvider, MailMode } from '@clam/shared';
import { useConsole } from '@/components/ConsoleContext';
import { clamApi, type SettingsResponse } from '@/lib/api';

export default function SettingsPage() {
  const { refreshOverview } = useConsole();
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  // LLM form
  const [llmProvider, setLlmProvider] = useState<LlmProvider>('local_heuristic');
  const [llmModel, setLlmModel] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState('http://127.0.0.1:11434');

  // Channels forms
  const [slackForm, setSlackForm] = useState({
    botToken: '',
    channelId: '',
    webhookUrl: '',
    signingSecret: '',
  });
  const [telegramForm, setTelegramForm] = useState({
    botToken: '',
    chatId: '',
    webhookSecret: '',
  });
  const [whatsappForm, setWhatsappForm] = useState({
    accessToken: '',
    phoneNumberId: '',
    recipientNumber: '',
    verifyToken: '',
    appSecret: '',
  });

  const [testingApproval, setTestingApproval] = useState(false);
  const [testResult, setTestResult] = useState<ChannelDeliveryMap | null>(null);

  const loadSettings = useCallback(async () => {
    const res = await clamApi.getSettings();
    setSettings(res);
    setLlmProvider(res.llm.provider);
    setLlmModel(res.llm.model);
    setOllamaBaseUrl(res.llm.ollamaBaseUrl);
    setSlackForm((f) => ({ ...f, channelId: res.channels.slack.channelId }));
    setTelegramForm((f) => ({ ...f, chatId: res.channels.telegram.chatId }));
    setWhatsappForm((f) => ({
      ...f,
      phoneNumberId: res.channels.whatsapp.phoneNumberId,
      recipientNumber: res.channels.whatsapp.recipientNumber,
    }));
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  async function switchMailMode(mode: MailMode) {
    setNotice(null);
    try {
      await clamApi.setMailMode(mode);
      await loadSettings();
      await refreshOverview();
      setNotice(`Mail provider switched to ${mode.toUpperCase()} mode.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Unable to switch mail mode');
    }
  }

  async function handleConnectGmail() {
    setNotice(null);
    try {
      const res = await clamApi.startGmailOAuth(['readonly', 'compose', 'modify']);
      window.location.href = res.auth_url;
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Gmail OAuth error');
    }
  }

  async function handleDisconnectGmail() {
    await clamApi.disconnectGmail();
    await loadSettings();
    await refreshOverview();
    setNotice('Gmail OAuth tokens wiped from AES-256-GCM vault; reverted to Sandbox mode.');
  }

  async function handleSaveLlm(e: React.FormEvent) {
    e.preventDefault();
    await clamApi.updateLlmSettings({
      provider: llmProvider,
      model: llmModel,
      openaiApiKey: openaiKey || undefined,
      anthropicApiKey: anthropicKey || undefined,
      geminiApiKey: geminiKey || undefined,
      ollamaBaseUrl,
    });
    setOpenaiKey('');
    setAnthropicKey('');
    setGeminiKey('');
    await loadSettings();
    setNotice('Semantic classifier configuration encrypted & saved.');
  }

  async function handleSaveChannels(e: React.FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {};
    if (
      slackForm.botToken ||
      slackForm.channelId ||
      slackForm.webhookUrl ||
      slackForm.signingSecret
    ) {
      payload.slack = Object.fromEntries(
        Object.entries(slackForm).filter(([, v]) => v.trim() !== '')
      );
    }
    if (telegramForm.botToken || telegramForm.chatId || telegramForm.webhookSecret) {
      payload.telegram = Object.fromEntries(
        Object.entries(telegramForm).filter(([, v]) => v.trim() !== '')
      );
    }
    if (
      whatsappForm.accessToken ||
      whatsappForm.phoneNumberId ||
      whatsappForm.recipientNumber ||
      whatsappForm.verifyToken ||
      whatsappForm.appSecret
    ) {
      payload.whatsapp = Object.fromEntries(
        Object.entries(whatsappForm).filter(([, v]) => v.trim() !== '')
      );
    }
    await clamApi.updateChannels(payload);
    await loadSettings();
    setNotice('HITL webhook secrets sealed into encrypted vault.');
  }

  async function handleSendTestApproval() {
    setTestingApproval(true);
    setTestResult(null);
    try {
      const res = await clamApi.sendTestApproval();
      setTestResult(res.approval.delivery_status);
      await refreshOverview();
    } finally {
      setTestingApproval(false);
    }
  }

  function copyCallback(key: string, url: string) {
    void navigator.clipboard.writeText(url);
    setCopiedUrl(key);
    setTimeout(() => setCopiedUrl(null), 1500);
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold tracking-display">Connections & Channels</h1>
        <p className="text-sm text-ink-secondary mt-0.5">
          Configure Gmail OAuth, semantic classifier provider, and Slack / Telegram / WhatsApp HITL webhooks.
        </p>
      </div>

      {notice && (
        <div className="px-4 py-2.5 rounded border border-hairline bg-surface text-xs text-ink-primary">
          {notice}
        </div>
      )}

      {/* 1. Mail Source Card */}
      <section className="border border-hairline rounded bg-surface p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded border border-hairline bg-canvas text-ink-primary">
              <Mail className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">Mail Provider Boundary</h2>
              <p className="text-xs text-ink-secondary mt-0.5">
                Switch seamlessly between the 18-email Sandbox Inbox and Google Gmail OAuth 2.0.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => switchMailMode('sandbox')}
              className={`px-3 py-1.5 rounded border text-xs font-medium ${
                settings?.gmail.mode === 'sandbox'
                  ? 'btn-primary border-transparent'
                  : 'border-hairline bg-canvas text-ink-secondary hover:text-ink-primary'
              }`}
            >
              Sandbox Mode
            </button>
            <button
              onClick={() => switchMailMode('gmail')}
              disabled={!settings?.gmail.connected}
              className={`px-3 py-1.5 rounded border text-xs font-medium ${
                settings?.gmail.mode === 'gmail'
                  ? 'bg-emerald-fill text-emerald-matte border-emerald-matte/30'
                  : 'border-hairline bg-canvas text-ink-secondary disabled:opacity-45'
              }`}
            >
              Live Gmail
            </button>
          </div>
        </div>

        <div className="border border-hairline rounded bg-canvas p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs">
          <div className="space-y-1">
            <div className="font-medium text-ink-primary">
              {settings?.gmail.connected
                ? `Connected to ${settings.gmail.email ?? 'Gmail Account'}`
                : 'Gmail OAuth Not Connected'}
            </div>
            <div className="text-ink-secondary font-mono text-[11px]">
              {settings?.gmail.oauthConfigured
                ? 'GOOGLE_CLIENT_ID configured · Tokens AES-256-GCM encrypted at rest'
                : 'Set GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET in .env to authorize live Gmail'}
            </div>
          </div>

          {settings?.gmail.connected ? (
            <button
              onClick={handleDisconnectGmail}
              className="px-3 py-1.5 rounded border border-crimson-matte/30 bg-crimson-fill text-crimson-matte text-xs font-medium"
            >
              Disconnect & Wipe Token
            </button>
          ) : (
            <button
              onClick={handleConnectGmail}
              disabled={!settings?.gmail.oauthConfigured}
              className="btn-primary px-3.5 py-1.5 rounded text-xs font-medium"
            >
              Connect Gmail OAuth
            </button>
          )}
        </div>
      </section>

      {/* 2. Semantic Classifier Provider */}
      <form
        onSubmit={handleSaveLlm}
        className="border border-hairline rounded bg-surface p-5 space-y-4"
      >
        <div className="flex items-start gap-3">
          <div className="p-2 rounded border border-hairline bg-canvas text-ink-primary">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold">Fail-Closed Semantic Classifier Provider</h2>
            <p className="text-xs text-ink-secondary mt-0.5">
              Defaults to zero-key Local Semantic Heuristic. External LLMs strictly fail closed on timeout or malformed JSON.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div>
            <label className="block text-ink-secondary mb-1">Provider</label>
            <select
              value={llmProvider}
              onChange={(e) => setLlmProvider(e.target.value as LlmProvider)}
              className="w-full rounded border border-hairline bg-canvas px-3 py-2 text-xs font-mono"
            >
              <option value="local_heuristic">local_heuristic (Zero-Setup Offline)</option>
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
              <option value="gemini">gemini</option>
              <option value="ollama">ollama (Local Self-Hosted)</option>
            </select>
          </div>
          <div>
            <label className="block text-ink-secondary mb-1">Model (Optional)</label>
            <input
              value={llmModel}
              onChange={(e) => setLlmModel(e.target.value)}
              placeholder="e.g. gpt-4o-mini / claude-3-5-haiku-latest / gemini-2.5-flash"
              className="w-full rounded border border-hairline bg-canvas px-3 py-2 text-xs font-mono"
            />
          </div>

          {llmProvider === 'openai' && (
            <div className="sm:col-span-2">
              <label className="block text-ink-secondary mb-1">
                OpenAI API Key {settings?.llm.hasOpenaiKey ? '(Vault Sealed ✓)' : ''}
              </label>
              <input
                type="password"
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full rounded border border-hairline bg-canvas px-3 py-2 text-xs font-mono"
              />
            </div>
          )}

          {llmProvider === 'anthropic' && (
            <div className="sm:col-span-2">
              <label className="block text-ink-secondary mb-1">
                Anthropic API Key {settings?.llm.hasAnthropicKey ? '(Vault Sealed ✓)' : ''}
              </label>
              <input
                type="password"
                value={anthropicKey}
                onChange={(e) => setAnthropicKey(e.target.value)}
                placeholder="sk-ant-..."
                className="w-full rounded border border-hairline bg-canvas px-3 py-2 text-xs font-mono"
              />
            </div>
          )}

          {llmProvider === 'gemini' && (
            <div className="sm:col-span-2">
              <label className="block text-ink-secondary mb-1">
                Gemini API Key {settings?.llm.hasGeminiKey ? '(Vault Sealed ✓)' : ''}
              </label>
              <input
                type="password"
                value={geminiKey}
                onChange={(e) => setGeminiKey(e.target.value)}
                placeholder="AIza..."
                className="w-full rounded border border-hairline bg-canvas px-3 py-2 text-xs font-mono"
              />
            </div>
          )}

          {llmProvider === 'ollama' && (
            <div className="sm:col-span-2">
              <label className="block text-ink-secondary mb-1">Ollama Base URL</label>
              <input
                value={ollamaBaseUrl}
                onChange={(e) => setOllamaBaseUrl(e.target.value)}
                className="w-full rounded border border-hairline bg-canvas px-3 py-2 text-xs font-mono"
              />
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <button type="submit" className="btn-primary px-3.5 py-1.5 rounded text-xs font-medium">
            Save Classifier Settings
          </button>
        </div>
      </form>

      {/* 3. HITL Channels (Slack, Telegram, WhatsApp) */}
      <form
        onSubmit={handleSaveChannels}
        className="border border-hairline rounded bg-surface p-5 space-y-5"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded border border-hairline bg-canvas text-ink-primary">
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">HITL Notification & Callback Bridges</h2>
              <p className="text-xs text-ink-secondary mt-0.5">
                Approve or deny Stage C actions directly from Slack, Telegram, or WhatsApp interactive buttons.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleSendTestApproval}
            disabled={testingApproval}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded border border-hairline bg-canvas text-xs font-medium text-ink-primary hover:bg-elevated"
          >
            <Send className="w-3.5 h-3.5" />
            {testingApproval ? 'Dispatching…' : 'Send Test Approval'}
          </button>
        </div>

        {testResult && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            {Object.entries(testResult).map(([ch, res]) => (
              <div
                key={ch}
                className="p-2.5 rounded border border-hairline bg-canvas space-y-0.5"
              >
                <div className="flex items-center justify-between font-mono uppercase text-[11px]">
                  <span>{ch}</span>
                  <span
                    className={
                      res.status === 'delivered'
                        ? 'text-emerald-matte'
                        : res.status === 'failed'
                          ? 'text-crimson-matte'
                          : 'text-ink-tertiary'
                    }
                  >
                    {res.status}
                  </span>
                </div>
                <div className="text-[11px] text-ink-secondary truncate" title={res.detail}>
                  {res.detail}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 text-xs">
          {/* Slack */}
          <div className="border border-hairline rounded bg-canvas p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold">Slack</span>
              <span
                className={`font-mono text-[11px] ${
                  settings?.channels.slack.configured
                    ? 'text-emerald-matte'
                    : 'text-ink-tertiary'
                }`}
              >
                {settings?.channels.slack.configured ? 'CONFIGURED' : 'NOT SET'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-1 px-2 py-1 rounded border border-hairline bg-surface font-mono text-[10px] text-ink-secondary">
              <span className="truncate">{settings?.channels.slack.callbackUrl}</span>
              <button
                type="button"
                onClick={() =>
                  copyCallback('slack', settings?.channels.slack.callbackUrl ?? '')
                }
              >
                {copiedUrl === 'slack' ? (
                  <Check className="w-3 h-3 text-emerald-matte" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
              </button>
            </div>
            <input
              type="password"
              value={slackForm.webhookUrl}
              onChange={(e) => setSlackForm((f) => ({ ...f, webhookUrl: e.target.value }))}
              placeholder="Webhook URL (or use Bot Token below)"
              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-xs font-mono"
            />
            <input
              type="password"
              value={slackForm.botToken}
              onChange={(e) => setSlackForm((f) => ({ ...f, botToken: e.target.value }))}
              placeholder="Slack Bot Token (xoxb-...)"
              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-xs font-mono"
            />
            <input
              value={slackForm.channelId}
              onChange={(e) => setSlackForm((f) => ({ ...f, channelId: e.target.value }))}
              placeholder="Channel ID (C0123...)"
              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-xs font-mono"
            />
            <input
              type="password"
              value={slackForm.signingSecret}
              onChange={(e) => setSlackForm((f) => ({ ...f, signingSecret: e.target.value }))}
              placeholder="Signing Secret"
              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-xs font-mono"
            />
          </div>

          {/* Telegram */}
          <div className="border border-hairline rounded bg-canvas p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold">Telegram</span>
              <span
                className={`font-mono text-[11px] ${
                  settings?.channels.telegram.configured
                    ? 'text-emerald-matte'
                    : 'text-ink-tertiary'
                }`}
              >
                {settings?.channels.telegram.configured ? 'CONFIGURED' : 'NOT SET'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-1 px-2 py-1 rounded border border-hairline bg-surface font-mono text-[10px] text-ink-secondary">
              <span className="truncate">{settings?.channels.telegram.callbackUrl}</span>
              <button
                type="button"
                onClick={() =>
                  copyCallback('tg', settings?.channels.telegram.callbackUrl ?? '')
                }
              >
                {copiedUrl === 'tg' ? (
                  <Check className="w-3 h-3 text-emerald-matte" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
              </button>
            </div>
            <input
              type="password"
              value={telegramForm.botToken}
              onChange={(e) => setTelegramForm((f) => ({ ...f, botToken: e.target.value }))}
              placeholder="Bot Token (123456:ABC...)"
              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-xs font-mono"
            />
            <input
              value={telegramForm.chatId}
              onChange={(e) => setTelegramForm((f) => ({ ...f, chatId: e.target.value }))}
              placeholder="Target Chat ID"
              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-xs font-mono"
            />
            <input
              type="password"
              value={telegramForm.webhookSecret}
              onChange={(e) =>
                setTelegramForm((f) => ({ ...f, webhookSecret: e.target.value }))
              }
              placeholder="Webhook Secret Token"
              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-xs font-mono"
            />
          </div>

          {/* WhatsApp */}
          <div className="border border-hairline rounded bg-canvas p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold">WhatsApp Cloud</span>
              <span
                className={`font-mono text-[11px] ${
                  settings?.channels.whatsapp.configured
                    ? 'text-emerald-matte'
                    : 'text-ink-tertiary'
                }`}
              >
                {settings?.channels.whatsapp.configured ? 'CONFIGURED' : 'NOT SET'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-1 px-2 py-1 rounded border border-hairline bg-surface font-mono text-[10px] text-ink-secondary">
              <span className="truncate">{settings?.channels.whatsapp.callbackUrl}</span>
              <button
                type="button"
                onClick={() =>
                  copyCallback('wa', settings?.channels.whatsapp.callbackUrl ?? '')
                }
              >
                {copiedUrl === 'wa' ? (
                  <Check className="w-3 h-3 text-emerald-matte" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
              </button>
            </div>
            <input
              type="password"
              value={whatsappForm.accessToken}
              onChange={(e) =>
                setWhatsappForm((f) => ({ ...f, accessToken: e.target.value }))
              }
              placeholder="Meta Access Token"
              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-xs font-mono"
            />
            <input
              value={whatsappForm.phoneNumberId}
              onChange={(e) =>
                setWhatsappForm((f) => ({ ...f, phoneNumberId: e.target.value }))
              }
              placeholder="Phone Number ID"
              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-xs font-mono"
            />
            <input
              value={whatsappForm.recipientNumber}
              onChange={(e) =>
                setWhatsappForm((f) => ({ ...f, recipientNumber: e.target.value }))
              }
              placeholder="Recipient Phone (+1...)"
              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-xs font-mono"
            />
            <input
              type="password"
              value={whatsappForm.verifyToken}
              onChange={(e) =>
                setWhatsappForm((f) => ({ ...f, verifyToken: e.target.value }))
              }
              placeholder="Webhook Verify Token"
              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-xs font-mono"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <button type="submit" className="btn-primary px-4 py-1.5 rounded text-xs font-medium">
            Save Channel Credentials
          </button>
        </div>
      </form>
    </div>
  );
}
