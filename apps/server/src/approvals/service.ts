import crypto from 'node:crypto';
import { and, desc, eq, lte } from 'drizzle-orm';
import type {
  ApprovalChannel,
  ApprovalStatus,
  ApprovalView,
  ChannelDeliveryMap,
  EphemeralApprovalPayload,
  McpToolName,
} from '@clam/shared';
import type { AuditLogger, RealtimeEventHub } from '../audit/logger.js';
import type { ClamConfig } from '../config.js';
import type { ClamDatabase } from '../db/index.js';
import { approvalRequests } from '../db/schema.js';
import type { KillSwitchService } from '../killswitch/service.js';
import type { MailService } from '../mail/service.js';
import { EphemeralRamVault, hashOpaqueId, type EphemeralCipherBox } from '../mail/vault.js';
import {
  dispatchSlackApproval,
  dispatchTelegramApproval,
  dispatchWhatsAppApproval,
  type SlackChannelConfig,
  type TelegramChannelConfig,
  type WhatsAppChannelConfig,
} from './channels.js';

const VAULT_CHANNELS_KEY = 'hitl_channel_configs';

export interface ChannelSettingsBundle {
  slack: SlackChannelConfig;
  telegram: TelegramChannelConfig;
  whatsapp: WhatsAppChannelConfig;
}

export interface CreateApprovalParams {
  agentId: string;
  agentName: string;
  mcpTool: McpToolName;
  matchedRuleId: string | null;
  ruleCitation: string;
  payload: EphemeralApprovalPayload;
  ttlSeconds?: number;
  isTest?: boolean;
}

export interface ApprovalResolutionOutcome {
  approval: ApprovalView;
  executionResult?: unknown;
}

export class ApprovalService {
  private readonly ramVault = new EphemeralRamVault();
  /** Strictly in-RAM encrypted boxes for PENDING approvals only; wiped immediately on resolution/expiry */
  private readonly ephemeralPayloads = new Map<string, EphemeralCipherBox>();
  private readonly waiters = new Map<
    string,
    Set<(outcome: ApprovalResolutionOutcome) => void>
  >();
  private sweeperTimer?: NodeJS.Timeout;

  constructor(
    private readonly db: ClamDatabase,
    private readonly mailService: MailService,
    private readonly auditLogger: AuditLogger,
    private readonly hub: RealtimeEventHub,
    private readonly config: ClamConfig,
    private readonly killSwitchService?: KillSwitchService
  ) {}

  startExpirySweeper(): void {
    if (this.sweeperTimer) return;
    this.sweeperTimer = setInterval(() => {
      void this.sweepExpired();
    }, 15_000);
    this.sweeperTimer.unref();
  }

  stopExpirySweeper(): void {
    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = undefined;
    }
  }

  async getChannelConfigs(): Promise<ChannelSettingsBundle> {
    const stored = await this.mailService.getVaultJson<Partial<ChannelSettingsBundle>>(
      VAULT_CHANNELS_KEY
    );
    return {
      slack: {
        botToken: stored?.slack?.botToken || this.config.slack.botToken || undefined,
        channelId: stored?.slack?.channelId || this.config.slack.channelId || undefined,
        webhookUrl: stored?.slack?.webhookUrl || this.config.slack.webhookUrl || undefined,
        signingSecret: stored?.slack?.signingSecret || this.config.slack.signingSecret || undefined,
      },
      telegram: {
        botToken: stored?.telegram?.botToken || this.config.telegram.botToken || undefined,
        chatId: stored?.telegram?.chatId || this.config.telegram.chatId || undefined,
        webhookSecret:
          stored?.telegram?.webhookSecret || this.config.telegram.webhookSecret || undefined,
      },
      whatsapp: {
        accessToken: stored?.whatsapp?.accessToken || this.config.whatsapp.accessToken || undefined,
        phoneNumberId:
          stored?.whatsapp?.phoneNumberId || this.config.whatsapp.phoneNumberId || undefined,
        recipientNumber:
          stored?.whatsapp?.recipientNumber || this.config.whatsapp.recipientNumber || undefined,
        verifyToken: stored?.whatsapp?.verifyToken || this.config.whatsapp.verifyToken || undefined,
        appSecret: stored?.whatsapp?.appSecret || this.config.whatsapp.appSecret || undefined,
      },
    };
  }

  async saveChannelConfigs(bundle: Partial<ChannelSettingsBundle>): Promise<ChannelSettingsBundle> {
    const current = await this.getChannelConfigs();
    const merged: ChannelSettingsBundle = {
      slack: { ...current.slack, ...bundle.slack },
      telegram: { ...current.telegram, ...bundle.telegram },
      whatsapp: { ...current.whatsapp, ...bundle.whatsapp },
    };
    await this.mailService.setVaultJson(VAULT_CHANNELS_KEY, merged);
    this.hub.publish('settings.updated', { section: 'channels' });
    return merged;
  }

  getEphemeralPayload(approvalId: string): EphemeralApprovalPayload | null {
    const box = this.ephemeralPayloads.get(approvalId);
    if (!box) return null;
    try {
      return this.ramVault.unseal<EphemeralApprovalPayload>(box);
    } catch {
      return null;
    }
  }

  private wipePayload(approvalId: string): void {
    const box = this.ephemeralPayloads.get(approvalId);
    if (box) {
      this.ramVault.wipe(box);
      this.ephemeralPayloads.delete(approvalId);
    }
  }

  private toView(row: typeof approvalRequests.$inferSelect): ApprovalView {
    const deliveryStatus = JSON.parse(row.deliveryStatusJson) as ChannelDeliveryMap;
    const isPending = row.status === 'PENDING' && row.payloadWiped === 0;
    return {
      id: row.id,
      agent_id: row.agentId,
      agent_name: row.agentName,
      mcp_tool: row.mcpTool as McpToolName,
      matched_rule_id: row.matchedRuleId,
      rule_citation: row.ruleCitation,
      status: row.status as ApprovalStatus,
      delivery_status: deliveryStatus,
      payload_wiped: row.payloadWiped === 1,
      resolved_by: row.resolvedBy,
      created_at: row.createdAt,
      expires_at: row.expiresAt,
      resolved_at: row.resolvedAt,
      ephemeral_preview: isPending ? this.getEphemeralPayload(row.id) : null,
    };
  }

  async createApproval(params: CreateApprovalParams): Promise<ApprovalView> {
    const id = `apr_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const now = new Date();
    const ttl = params.ttlSeconds ?? this.config.approvalTtlSeconds;
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();

    // Seal proposed action payload strictly in RAM
    const cipherBox = this.ramVault.seal(params.payload);
    this.ephemeralPayloads.set(id, cipherBox);

    const payloadHash = hashOpaqueId(
      `${params.mcpTool}:${params.payload.to ?? ''}:${params.payload.messageId ?? ''}:${now.toISOString()}`
    );

    const initialDelivery: ChannelDeliveryMap = {
      app: { status: 'delivered', detail: 'Pushed to Clam live queue via SSE' },
      slack: { status: 'not_configured', detail: 'Checking channel configuration' },
      telegram: { status: 'not_configured', detail: 'Checking channel configuration' },
      whatsapp: { status: 'not_configured', detail: 'Checking channel configuration' },
    };

    await this.db.insert(approvalRequests).values({
      id,
      agentId: params.agentId,
      agentName: params.agentName,
      mcpTool: params.mcpTool,
      matchedRuleId: params.matchedRuleId,
      ruleCitation: params.ruleCitation,
      status: 'PENDING',
      deliveryStatusJson: JSON.stringify(initialDelivery),
      payloadHash,
      payloadWiped: 0,
      resolvedBy: null,
      createdAt: now.toISOString(),
      expiresAt,
      resolvedAt: null,
    });

    // Dispatch external bridges
    const channels = await this.getChannelConfigs();
    const dispatchPayload = {
      approvalId: id,
      agentName: params.agentName,
      mcpTool: params.mcpTool,
      ruleCitation: params.ruleCitation,
      expiresAt,
      payload: params.payload,
    };

    const [slackRes, telegramRes, whatsappRes] = await Promise.all([
      dispatchSlackApproval(channels.slack, dispatchPayload),
      dispatchTelegramApproval(channels.telegram, dispatchPayload),
      dispatchWhatsAppApproval(channels.whatsapp, dispatchPayload),
    ]);

    const finalDelivery: ChannelDeliveryMap = {
      app: initialDelivery.app,
      slack: slackRes,
      telegram: telegramRes,
      whatsapp: whatsappRes,
    };

    await this.db
      .update(approvalRequests)
      .set({ deliveryStatusJson: JSON.stringify(finalDelivery) })
      .where(eq(approvalRequests.id, id));

    const row = await this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .get();

    const view = this.toView(row!);
    this.hub.publish('approval.created', view);
    return view;
  }

  async getById(id: string): Promise<ApprovalView | null> {
    await this.sweepExpired();
    const row = await this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .get();
    return row ? this.toView(row) : null;
  }

  async list(statusFilter?: ApprovalStatus): Promise<ApprovalView[]> {
    await this.sweepExpired();
    const rows = await this.db
      .select()
      .from(approvalRequests)
      .where(statusFilter ? eq(approvalRequests.status, statusFilter) : undefined)
      .orderBy(desc(approvalRequests.createdAt))
      .limit(100)
      .all();
    return rows.map((r) => this.toView(r));
  }

  async waitForResolution(
    approvalId: string,
    timeoutMs: number
  ): Promise<ApprovalResolutionOutcome | null> {
    const existing = await this.getById(approvalId);
    if (!existing) return null;
    if (existing.status !== 'PENDING') {
      return { approval: existing };
    }

    return new Promise((resolve) => {
      const set = this.waiters.get(approvalId) ?? new Set();
      const timer = setTimeout(() => {
        set.delete(onDone);
        if (set.size === 0) this.waiters.delete(approvalId);
        resolve(null);
      }, timeoutMs);

      const onDone = (outcome: ApprovalResolutionOutcome) => {
        clearTimeout(timer);
        set.delete(onDone);
        if (set.size === 0) this.waiters.delete(approvalId);
        resolve(outcome);
      };

      set.add(onDone);
      this.waiters.set(approvalId, set);
    });
  }

  private notifyWaiters(approvalId: string, outcome: ApprovalResolutionOutcome): void {
    const set = this.waiters.get(approvalId);
    if (!set) return;
    for (const fn of Array.from(set)) {
      fn(outcome);
    }
  }

  async resolveApproval(params: {
    id: string;
    resolution: 'APPROVED' | 'REJECTED';
    channel: ApprovalChannel;
    editedPayload?: Partial<Pick<EphemeralApprovalPayload, 'to' | 'subject' | 'body' | 'label'>>;
  }): Promise<ApprovalResolutionOutcome> {
    await this.sweepExpired();

    const row = await this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, params.id))
      .get();

    if (!row) {
      throw new Error(`Approval request "${params.id}" not found`);
    }

    if (row.status !== 'PENDING') {
      throw new Error(`Approval "${params.id}" is already ${row.status}`);
    }

    if (params.resolution === 'APPROVED' && this.killSwitchService?.isHalted(row.agentId)) {
      throw new Error('KILL_SWITCH_ENGAGED: Cannot execute approved mutation while Kill Switch is halted.');
    }

    const start = performance.now();
    const ephemeral = this.getEphemeralPayload(row.id);
    let executionResult: unknown = undefined;

    if (params.resolution === 'APPROVED' && ephemeral) {
      if (!this.mailService.legacyMutationAllowed()) throw new Error('Use the Inbox approval queue for live mutations.');
      if (this.killSwitchService?.isHalted(row.agentId)) throw new Error('KILL_SWITCH_ENGAGED');
      const effective: EphemeralApprovalPayload = {
        ...ephemeral,
        ...(params.editedPayload?.to !== undefined ? { to: params.editedPayload.to } : {}),
        ...(params.editedPayload?.subject !== undefined
          ? { subject: params.editedPayload.subject }
          : {}),
        ...(params.editedPayload?.body !== undefined ? { body: params.editedPayload.body } : {}),
        ...(params.editedPayload?.label !== undefined ? { label: params.editedPayload.label } : {}),
      };

      const provider = this.mailService.getActiveProvider();
      if (effective.tool === 'create_draft') {
        executionResult = await provider.createDraft({
          to: effective.to ?? '',
          subject: effective.subject ?? '',
          body: effective.body ?? '',
          threadId: effective.threadId,
        });
      } else if (effective.tool === 'send_email') {
        executionResult = await provider.sendMessage({
          to: effective.to ?? '',
          subject: effective.subject ?? '',
          body: effective.body ?? '',
          threadId: effective.threadId,
        });
      } else if (effective.tool === 'archive_email' && effective.messageId) {
        executionResult = await provider.archiveMessage(effective.messageId);
      } else if (effective.tool === 'apply_label' && effective.messageId && effective.label) {
        executionResult = await provider.applyLabel(effective.messageId, effective.label);
      }
    }

    // CRITICAL ZERO-RETENTION STEP: wipe ephemeral payload from RAM immediately after resolution
    this.wipePayload(row.id);

    const nowIso = new Date().toISOString();
    await this.db
      .update(approvalRequests)
      .set({
        status: params.resolution,
        payloadWiped: 1,
        resolvedBy: params.channel,
        resolvedAt: nowIso,
      })
      .where(eq(approvalRequests.id, row.id));

    await this.auditLogger.record({
      agentId: row.agentId,
      agentName: row.agentName,
      mcpTool: row.mcpTool,
      decision: params.resolution,
      matchedRuleId: row.matchedRuleId,
      ruleCitation: `${row.ruleCitation} (Human ${params.resolution.toLowerCase()} via ${params.channel})`,
      semanticCategory: null,
      confidence: 1,
      approvalId: row.id,
      rawMessageId: ephemeral?.messageId ?? row.id,
      latencyMs: Math.max(1, Math.round(performance.now() - start)),
    });

    const updated = await this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, row.id))
      .get();

    const view = this.toView(updated!);
    const outcome: ApprovalResolutionOutcome = { approval: view, executionResult };
    this.hub.publish('approval.resolved', outcome);
    this.notifyWaiters(row.id, outcome);
    return outcome;
  }

  async sweepExpired(): Promise<number> {
    const nowIso = new Date().toISOString();
    const expiredRows = await this.db
      .select()
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.status, 'PENDING'), lte(approvalRequests.expiresAt, nowIso))
      )
      .all();

    for (const row of expiredRows) {
      this.wipePayload(row.id);
      await this.db
        .update(approvalRequests)
        .set({
          status: 'EXPIRED',
          payloadWiped: 1,
          resolvedBy: 'ttl_sweeper',
          resolvedAt: nowIso,
        })
        .where(eq(approvalRequests.id, row.id));

      await this.auditLogger.record({
        agentId: row.agentId,
        agentName: row.agentName,
        mcpTool: row.mcpTool,
        decision: 'EXPIRED',
        matchedRuleId: row.matchedRuleId,
        ruleCitation: `${row.ruleCitation} (TTL expired; ephemeral payload wiped)`,
        semanticCategory: null,
        confidence: null,
        approvalId: row.id,
        rawMessageId: row.id,
        latencyMs: 0,
      });

      const updated = await this.db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, row.id))
        .get();
      if (updated) {
        const view = this.toView(updated);
        this.hub.publish('approval.expired', view);
        this.notifyWaiters(row.id, { approval: view });
      }
    }
    return expiredRows.length;
  }

  async sendTestApproval(): Promise<ApprovalView> {
    return this.createApproval({
      agentId: 'ag_travel',
      agentName: 'Travel Itinerary Agent (Test)',
      mcpTool: 'create_draft',
      matchedRuleId: 'test_hitl_dispatch',
      ruleCitation: 'Test approval dispatch triggered from Connections & Channels console.',
      payload: {
        tool: 'create_draft',
        to: 'kenji.host@airbnb-messages.example',
        subject: 'Re: Kyoto check-in arrival time (Test)',
        body: 'Hi Kenji! This is a Clam HITL test notification verifying App, Slack, Telegram, and WhatsApp delivery.',
      },
      ttlSeconds: 300,
      isTest: true,
    });
  }
}
