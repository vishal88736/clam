import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AgentRunSummary, TrapPackReport } from '@clam/shared';
import { runAutonomousInboxAgent } from '@clam/agent';
import type { AuditLogger, RealtimeEventHub } from '../audit/logger.js';
import { workspaceRoot, type ClamConfig } from '../config.js';
import type { KillSwitchService } from '../killswitch/service.js';
import type { MailService } from '../mail/service.js';
import type { LlmCompilerRuntimeConfig } from '../policy/compiler.js';
import { runTrapPackSuite } from '../trappack/runner.js';
import type { AgentService } from './service.js';

export class AutonomousRunnerService {
  private readonly runs: AgentRunSummary[] = [];
  private latestTrapReport: TrapPackReport | null = null;

  constructor(
    private readonly app: FastifyInstance,
    private readonly config: ClamConfig,
    private readonly agentService: AgentService,
    private readonly mailService: MailService,
    private readonly auditLogger: AuditLogger,
    private readonly killSwitchService: KillSwitchService,
    private readonly hub: RealtimeEventHub,
    private readonly getLlmConfig: () => Promise<LlmCompilerRuntimeConfig>
  ) {}

  private resolveMcpUrl(): string {
    const addr = this.app.server.address();
    if (typeof addr === 'object' && addr && addr.port) {
      return `http://127.0.0.1:${addr.port}/mcp`;
    }
    return `${this.config.publicUrl.replace(/\/$/, '')}/mcp`;
  }

  listRuns(): AgentRunSummary[] {
    return [...this.runs];
  }

  getLatestTrapReport(): TrapPackReport | null {
    return this.latestTrapReport;
  }

  async startAutonomousRun(options?: {
    agentId?: string;
    probeAdversarialToolCalls?: boolean;
  }): Promise<AgentRunSummary> {
    const agentId = options?.agentId || 'ag_autonomous';
    if (this.killSwitchService.isHalted(agentId)) {
      throw new Error('KILL_SWITCH_ENGAGED: Cannot start autonomous run while Kill Switch is halted.');
    }

    const agent =
      (await this.agentService.getAgent(agentId)) ??
      (await this.agentService.getAgent('ag_travel'));
    if (!agent) {
      throw new Error(`Agent "${agentId}" not found.`);
    }

    const runId = `run_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const controller = new AbortController();
    const unregister = this.killSwitchService.registerInFlight(runId, agent.id, controller);
    const issued = await this.agentService.issueToken(agent.id, `Autonomous Run (${runId})`);

    try {
      const llmCfg = await this.getLlmConfig();
      const totalInboxHint =
        this.mailService.getMode() === 'sandbox'
          ? this.mailService.sandbox.getStateSummary().emailCount
          : undefined;

      const summary = await runAutonomousInboxAgent({
        mcpUrl: this.resolveMcpUrl(),
        bearerToken: issued.rawToken,
        agentId: agent.id,
        agentName: agent.name,
        runId,
        signal: controller.signal,
        totalInboxHint,
        llmConfig: llmCfg,
        probeAdversarialToolCalls: options?.probeAdversarialToolCalls,
        onStep: (step) => {
          this.hub.publish('agent.run.step', { run_id: runId, step });
        },
      });

      await fs.mkdir(this.config.tracesDir, { recursive: true });
      const traceFile = path.join(this.config.tracesDir, 'latest-run.jsonl');
      const jsonl = await this.auditLogger.exportJsonl({ runId, limit: 500 });
      await fs.writeFile(traceFile, jsonl ? jsonl + '\n' : '', 'utf8');
      summary.trace_path = 'traces/latest-run.jsonl';

      this.runs.unshift(summary);
      if (this.runs.length > 20) this.runs.length = 20;

      if (summary.status === 'aborted') {
        this.hub.publish('agent.run.aborted', summary);
      } else {
        this.hub.publish('agent.run.completed', summary);
      }
      return summary;
    } finally {
      unregister();
      await this.agentService.revokeToken(agent.id, issued.info.id).catch(() => {});
    }
  }

  async runTrapPack(casesDir?: string): Promise<TrapPackReport> {
    if (this.killSwitchService.isHalted()) throw new Error('KILL_SWITCH_ENGAGED');
    if (this.mailService.getMode() !== 'sandbox') throw new Error('TRAP_PACK_REQUIRES_SANDBOX');
    const resolvedCasesDir = casesDir || path.resolve(workspaceRoot, 'trap-pack/cases');
    const report = await runTrapPackSuite({
      mcpUrl: this.resolveMcpUrl(),
      casesDir: resolvedCasesDir,
      tracesDir: this.config.tracesDir,
      agentService: this.agentService,
      mailService: this.mailService,
      auditLogger: this.auditLogger,
      killSwitchService: this.killSwitchService,
    });
    this.latestTrapReport = report;
    this.hub.publish('trappack.completed', report);
    return report;
  }

  async listArtifacts(): Promise<{ filename: string; bytes: number; updated_at: string }[]> {
    try {
      const entries = await fs.readdir(this.config.artifactsDir, { withFileTypes: true });
      const items: { filename: string; bytes: number; updated_at: string }[] = [];
      for (const e of entries) {
        if (!e.isFile() || !/\.(md|json|ics|txt)$/i.test(e.name)) continue;
        const stat = await fs.stat(path.join(this.config.artifactsDir, e.name));
        items.push({
          filename: e.name,
          bytes: stat.size,
          updated_at: stat.mtime.toISOString(),
        });
      }
      return items.sort((a, b) => a.filename.localeCompare(b.filename));
    } catch {
      return [];
    }
  }

  async readArtifact(filename: string): Promise<{ filename: string; content: string } | null> {
    const base = path.basename(filename);
    if (base !== filename || !/^[a-zA-Z0-9._-]+\.(md|json|ics|txt)$/.test(base)) {
      return null;
    }
    try {
      const content = await fs.readFile(path.join(this.config.artifactsDir, base), 'utf8');
      return { filename: base, content };
    } catch {
      return null;
    }
  }
}
