import crypto from 'node:crypto';
import type { EphemeralApprovalPayload } from '@clam/shared';

export interface SlackChannelConfig {
  botToken?: string;
  channelId?: string;
  webhookUrl?: string;
  signingSecret?: string;
}

export interface TelegramChannelConfig {
  botToken?: string;
  chatId?: string;
  webhookSecret?: string;
}

export interface WhatsAppChannelConfig {
  accessToken?: string;
  phoneNumberId?: string;
  recipientNumber?: string;
  verifyToken?: string;
  appSecret?: string;
}

export interface ChannelDispatchInput {
  approvalId: string;
  agentName: string;
  mcpTool: string;
  ruleCitation: string;
  expiresAt: string;
  payload: EphemeralApprovalPayload;
}

export interface ChannelResult {
  status: 'delivered' | 'not_configured' | 'failed';
  detail: string;
}

function buildActionSummary(payload: EphemeralApprovalPayload): string {
  const parts: string[] = [];
  if (payload.to) parts.push(`To: ${payload.to}`);
  if (payload.subject) parts.push(`Subject: ${payload.subject}`);
  if (payload.label) parts.push(`Label: ${payload.label}`);
  if (payload.messageId) parts.push(`Message Ref: #${payload.messageId.slice(0, 12)}`);
  if (payload.body) {
    const preview = payload.body.slice(0, 220) + (payload.body.length > 220 ? '…' : '');
    parts.push(`Draft Body: ${preview}`);
  }
  return parts.join('\n') || 'Action approval requested';
}

export async function dispatchSlackApproval(
  cfg: SlackChannelConfig,
  input: ChannelDispatchInput
): Promise<ChannelResult> {
  if (!cfg.webhookUrl && !(cfg.botToken && cfg.channelId)) {
    return { status: 'not_configured', detail: 'Slack webhook/bot credentials not set' };
  }

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Clam HITL Approval: ${input.agentName}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Tool:*\n\`${input.mcpTool}\`` },
        { type: 'mrkdwn', text: `*Approval ID:*\n\`${input.approvalId}\`` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Trigger Rule:*\n>${input.ruleCitation}\n\n*Proposed Action:*\n\`\`\`${buildActionSummary(input.payload)}\`\`\``,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve' },
          style: 'primary',
          action_id: 'clam_approve',
          value: input.approvalId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny' },
          style: 'danger',
          action_id: 'clam_deny',
          value: input.approvalId,
        },
      ],
    },
  ];

  try {
    if (cfg.botToken && cfg.channelId) {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: cfg.channelId,
          text: `Clam HITL Approval required for ${input.agentName} (${input.mcpTool})`,
          blocks,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        return { status: 'failed', detail: json.error ?? `HTTP ${res.status}` };
      }
      return { status: 'delivered', detail: `Posted Block Kit card to Slack ${cfg.channelId}` };
    }

    const res = await fetch(cfg.webhookUrl!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `Clam HITL Approval required for ${input.agentName} (${input.mcpTool})`,
        blocks,
      }),
    });
    if (!res.ok) {
      return { status: 'failed', detail: `Slack webhook returned HTTP ${res.status}` };
    }
    return { status: 'delivered', detail: 'Delivered Block Kit payload via Slack webhook' };
  } catch (err) {
    return {
      status: 'failed',
      detail: err instanceof Error ? err.message : 'Slack request failed',
    };
  }
}

export function verifySlackSignature(params: {
  signingSecret: string;
  rawBody: string;
  timestampHeader?: string;
  signatureHeader?: string;
}): boolean {
  if (!params.signingSecret || !params.timestampHeader || !params.signatureHeader) {
    return false;
  }
  const ts = Number(params.timestampHeader);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) {
    return false;
  }
  const baseString = `v0:${params.timestampHeader}:${params.rawBody}`;
  const expected =
    'v0=' + crypto.createHmac('sha256', params.signingSecret).update(baseString).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(params.signatureHeader, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function dispatchTelegramApproval(
  cfg: TelegramChannelConfig,
  input: ChannelDispatchInput
): Promise<ChannelResult> {
  if (!cfg.botToken || !cfg.chatId) {
    return { status: 'not_configured', detail: 'Telegram bot token or chat ID not set' };
  }

  const text = [
    `CLAM APPROVAL REQUIRED`,
    `Agent: ${input.agentName}`,
    `Tool: ${input.mcpTool}`,
    `Rule: "${input.ruleCitation}"`,
    ``,
    buildActionSummary(input.payload),
    ``,
    `ID: ${input.approvalId} | Expires: ${input.expiresAt}`,
  ].join('\n');

  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Approve', callback_data: `approve:${input.approvalId}` },
              { text: 'Deny', callback_data: `deny:${input.approvalId}` },
            ],
          ],
        },
      }),
    });
    const json = (await res.json()) as { ok?: boolean; description?: string };
    if (!res.ok || !json.ok) {
      return { status: 'failed', detail: json.description ?? `HTTP ${res.status}` };
    }
    return { status: 'delivered', detail: `Sent inline keyboard to Telegram chat ${cfg.chatId}` };
  } catch (err) {
    return {
      status: 'failed',
      detail: err instanceof Error ? err.message : 'Telegram request failed',
    };
  }
}

export async function answerTelegramCallback(
  cfg: TelegramChannelConfig,
  callbackQueryId: string,
  text: string
): Promise<void> {
  if (!cfg.botToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch {
    // Non-fatal UI ack
  }
}

export async function dispatchWhatsAppApproval(
  cfg: WhatsAppChannelConfig,
  input: ChannelDispatchInput
): Promise<ChannelResult> {
  if (!cfg.accessToken || !cfg.phoneNumberId || !cfg.recipientNumber) {
    return { status: 'not_configured', detail: 'WhatsApp Cloud API credentials not set' };
  }

  const bodyText = [
    `Clam Approval Required (${input.agentName})`,
    `Tool: ${input.mcpTool}`,
    `Rule: ${input.ruleCitation}`,
    buildActionSummary(input.payload),
  ]
    .join('\n')
    .slice(0, 1024);

  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: cfg.recipientNumber,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: bodyText },
            action: {
              buttons: [
                {
                  type: 'reply',
                  reply: { id: `approve:${input.approvalId}`, title: 'Approve' },
                },
                {
                  type: 'reply',
                  reply: { id: `deny:${input.approvalId}`, title: 'Deny' },
                },
              ],
            },
          },
        }),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      return { status: 'failed', detail: `WhatsApp API ${res.status}: ${errText}` };
    }
    return {
      status: 'delivered',
      detail: `Sent interactive WhatsApp message to ${cfg.recipientNumber}`,
    };
  } catch (err) {
    return {
      status: 'failed',
      detail: err instanceof Error ? err.message : 'WhatsApp request failed',
    };
  }
}

export function verifyWhatsAppSignature(
  appSecret: string,
  rawBody: string,
  signatureHeader?: string
): boolean {
  if (!appSecret || !signatureHeader) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
