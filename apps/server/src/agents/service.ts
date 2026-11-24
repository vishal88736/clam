import crypto from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type {
  AgentRecord,
  AgentTokenInfo,
  PolicyIR,
  SensitiveCategory,
} from '@clam/shared';
import type { RealtimeEventHub } from '../audit/logger.js';
import type { ClamDatabase } from '../db/index.js';
import { agents, agentTokens } from '../db/schema.js';
import { generateAgentToken, hashToken } from '../mail/vault.js';
import { compilePolicy, type LlmCompilerRuntimeConfig } from '../policy/compiler.js';

const PRESEED_AGENTS: {
  id: string;
  name: string;
  description: string;
  rawRules: string;
}[] = [
  {
    id: 'ag_travel',
    name: 'Travel Itinerary Agent',
    description: 'Extracts flight confirmations, hotel bookings, and drafts check-in replies to hosts.',
    rawRules:
      'Read flight, hotel and booking emails and build my itinerary. Draft replies to hosts for me to review. Never send.',
  },
  {
    id: 'ag_invoices',
    name: 'Invoice & Expense Tracker',
    description: 'Reads bills, utility statements, and SaaS invoices across unknown vendors for accounting.',
    rawRules:
      'Read bills, utility statements, and SaaS invoices and receipts for expense tracking. Label processed invoices. Ask me first before archiving. Never send or delete.',
  },
  {
    id: 'ag_triage',
    name: 'Inbox Triage Assistant',
    description: 'Summarizes newsletters, shipping notices, and work correspondence with strict send gating.',
    rawRules:
      'Read newsletters, shipping notifications, and work correspondence to summarize daily priorities. Label triaged messages. Ask me first before creating drafts or sending replies. Never delete.',
  },
];

export class AgentService {
  constructor(
    private readonly db: ClamDatabase,
    private readonly getCompilerConfig: () => Promise<LlmCompilerRuntimeConfig> | LlmCompilerRuntimeConfig,
    private readonly hub: RealtimeEventHub
  ) {}

  private toAgentRecord(row: typeof agents.$inferSelect): AgentRecord {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      raw_rules: row.rawRules,
      policy_ir: JSON.parse(row.policyIrJson) as PolicyIR,
      status: row.status as 'active' | 'paused',
      rate_limit_per_min: row.rateLimitPerMin,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  async seedDefaultsIfEmpty(): Promise<void> {
    const existing = await this.db.select().from(agents).limit(1).all();
    if (existing.length > 0) return;

    const llmCfg = await this.getCompilerConfig();
    const now = new Date().toISOString();

    for (const def of PRESEED_AGENTS) {
      const policyIr = await compilePolicy({
        rawRules: def.rawRules,
        llmConfig: llmCfg,
      });

      await this.db.insert(agents).values({
        id: def.id,
        name: def.name,
        description: def.description,
        rawRules: def.rawRules,
        policyIrJson: JSON.stringify(policyIr),
        status: 'active',
        rateLimitPerMin: 60,
        createdAt: now,
        updatedAt: now,
      });

      // Seed one hashed default token entry per demo agent (user rotates/creates to view raw token)
      const tok = generateAgentToken();
      await this.db.insert(agentTokens).values({
        id: `tok_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
        agentId: def.id,
        label: 'Default Client Token',
        tokenPrefix: tok.prefix,
        tokenHash: tok.hash,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now,
      });
    }
  }

  async listAgents(): Promise<AgentRecord[]> {
    const rows = await this.db.select().from(agents).orderBy(agents.createdAt).all();
    return rows.map((r) => this.toAgentRecord(r));
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    const row = await this.db.select().from(agents).where(eq(agents.id, id)).get();
    return row ? this.toAgentRecord(row) : null;
  }

  async createAgent(input: {
    name: string;
    description?: string;
    rawRules: string;
    overriddenSensitiveCategories?: SensitiveCategory[];
    rateLimitPerMin?: number;
  }): Promise<{ agent: AgentRecord; initialToken: { info: AgentTokenInfo; rawToken: string } }> {
    const id = `ag_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const now = new Date().toISOString();
    const llmCfg = await this.getCompilerConfig();
    const policyIr = await compilePolicy({
      rawRules: input.rawRules,
      overriddenSensitiveCategories: input.overriddenSensitiveCategories,
      llmConfig: llmCfg,
    });

    await this.db.insert(agents).values({
      id,
      name: input.name.trim(),
      description: (input.description ?? '').trim(),
      rawRules: input.rawRules,
      policyIrJson: JSON.stringify(policyIr),
      status: 'active',
      rateLimitPerMin: input.rateLimitPerMin ?? 60,
      createdAt: now,
      updatedAt: now,
    });

    const initialToken = await this.issueToken(id, 'Primary MCP Token');
    const agent = (await this.getAgent(id))!;
    this.hub.publish('agent.updated', agent);
    return { agent, initialToken };
  }

  async updateAgent(
    id: string,
    patch: {
      name?: string;
      description?: string;
      rawRules?: string;
      status?: 'active' | 'paused';
      rateLimitPerMin?: number;
      overriddenSensitiveCategories?: SensitiveCategory[];
    }
  ): Promise<AgentRecord> {
    const existing = await this.getAgent(id);
    if (!existing) throw new Error(`Agent "${id}" not found`);

    const nextRules = patch.rawRules ?? existing.raw_rules;
    const overrides =
      patch.overriddenSensitiveCategories ?? existing.policy_ir.overridden_sensitive_categories;

    const policyIr =
      patch.rawRules !== undefined || patch.overriddenSensitiveCategories !== undefined
        ? await compilePolicy({
            rawRules: nextRules,
            overriddenSensitiveCategories: overrides,
            llmConfig: await this.getCompilerConfig(),
          })
        : existing.policy_ir;

    const now = new Date().toISOString();
    await this.db
      .update(agents)
      .set({
        name: patch.name?.trim() ?? existing.name,
        description: patch.description?.trim() ?? existing.description,
        rawRules: nextRules,
        policyIrJson: JSON.stringify(policyIr),
        status: patch.status ?? existing.status,
        rateLimitPerMin: patch.rateLimitPerMin ?? existing.rate_limit_per_min,
        updatedAt: now,
      })
      .where(eq(agents.id, id));

    const updated = (await this.getAgent(id))!;
    this.hub.publish('agent.updated', updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<void> {
    await this.db.delete(agents).where(eq(agents.id, id));
    this.hub.publish('agent.updated', { id, deleted: true });
  }

  async listTokens(agentId: string): Promise<AgentTokenInfo[]> {
    const rows = await this.db
      .select()
      .from(agentTokens)
      .where(eq(agentTokens.agentId, agentId))
      .orderBy(desc(agentTokens.createdAt))
      .all();

    return rows.map((r) => ({
      id: r.id,
      agent_id: r.agentId,
      label: r.label,
      token_prefix: r.tokenPrefix,
      last_used_at: r.lastUsedAt,
      revoked_at: r.revokedAt,
      created_at: r.createdAt,
    }));
  }

  async issueToken(
    agentId: string,
    label = 'MCP Client Token'
  ): Promise<{ info: AgentTokenInfo; rawToken: string }> {
    const agent = await this.getAgent(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found`);

    const tok = generateAgentToken();
    const id = `tok_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const now = new Date().toISOString();

    await this.db.insert(agentTokens).values({
      id,
      agentId,
      label: label.trim() || 'MCP Client Token',
      tokenPrefix: tok.prefix,
      tokenHash: tok.hash,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: now,
    });

    return {
      info: {
        id,
        agent_id: agentId,
        label: label.trim() || 'MCP Client Token',
        token_prefix: tok.prefix,
        last_used_at: null,
        revoked_at: null,
        created_at: now,
      },
      rawToken: tok.raw,
    };
  }

  async rotateToken(
    agentId: string,
    tokenId?: string
  ): Promise<{ info: AgentTokenInfo; rawToken: string }> {
    const now = new Date().toISOString();
    if (tokenId) {
      await this.db
        .update(agentTokens)
        .set({ revokedAt: now })
        .where(and(eq(agentTokens.id, tokenId), eq(agentTokens.agentId, agentId)));
    } else {
      await this.db
        .update(agentTokens)
        .set({ revokedAt: now })
        .where(and(eq(agentTokens.agentId, agentId), isNull(agentTokens.revokedAt)));
    }
    return this.issueToken(agentId, 'Rotated MCP Token');
  }

  async revokeToken(agentId: string, tokenId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .update(agentTokens)
      .set({ revokedAt: now })
      .where(and(eq(agentTokens.id, tokenId), eq(agentTokens.agentId, agentId)));
  }

  async authenticateBearerToken(rawToken: string): Promise<AgentRecord | null> {
    if (!rawToken.startsWith('clm_ag_')) return null;
    const hashed = hashToken(rawToken);
    const tokenRow = await this.db
      .select()
      .from(agentTokens)
      .where(and(eq(agentTokens.tokenHash, hashed), isNull(agentTokens.revokedAt)))
      .get();

    if (!tokenRow) return null;

    // Update lastUsedAt asynchronously
    void this.db
      .update(agentTokens)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(agentTokens.id, tokenRow.id));

    return this.getAgent(tokenRow.agentId);
  }
}
