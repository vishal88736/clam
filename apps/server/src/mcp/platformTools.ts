import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mcpScopes, type GoogleAccounts, type GoogleCapability, type McpGrant } from '../auth/google.js';
import type { McpCaller, Mode } from '../inbox/contracts.js';
import type { InboxEngine } from '../inbox/engine.js';
import { genericStepScopes } from '../platform/generic.js';
import { detectSourceCli, type MissionRunner } from '../platform/runner.js';
import { services, type PlatformService, type Service } from '../platform/service.js';
import { extractPhotoDetails } from '../workspace/photos.js';

type ToolResult = { isError: boolean; content: { type: 'text'; text: string }[] };
type Workflow = (tool: string, grantName: string, work: () => Promise<unknown>, audit?: Record<string, unknown>) => Promise<ToolResult>;

const segment = z.string().trim().min(1).max(80).regex(/^[^/\\\0\r\n]+$/);
const folderPath = z.array(segment).min(1).max(5);
const title = z.string().trim().min(1).max(120).regex(/^[^/\\\0\r\n]+$/);
const cell = z.union([z.string().max(500), z.number().finite()]);
const capability: Record<Service, GoogleCapability> = {
  gmail: 'mail:read', calendar: 'calendar:write', drive: 'drive:write', docs: 'docs:write', sheets: 'sheets:write', photos: 'photos:read',
};

/**
 * Zero-setup agent tools for CLI coding agents. A natural-language request becomes a persistent, policy-gated
 * backend agent; the user's active agent switches automatically; the website streams every step live.
 */
export function registerPlatformTools(server: McpServer, args: {
  grant: McpGrant; mode: Mode; inbox: InboxEngine; platform: PlatformService; missions: MissionRunner; accounts: GoogleAccounts;
  workflow: Workflow; caller: (tool: string) => McpCaller;
}) {
  const { grant, mode, inbox, platform, missions, accounts, workflow, caller } = args;
  const client = () => server.server.getClientVersion()?.name;
  const requireLive = (needed: Service[]) => {
    if (mode === 'sandbox') return;
    for (const service of needed) accounts.requireScope(grant.inboxId, capability[service]);
  };
  const requireToken = (scopes: string[]) => {
    const missing = scopes.filter((scope) => !grant.scopes.includes(scope));
    if (missing.length) throw new Error('MCP_SCOPE_REQUIRED');
  };
  const interactive = (explicit?: string) => missions.interactiveAgent(grant.userId, grant.inboxId, detectSourceCli(client(), explicit));
  const artifactView = (id: string | null | undefined) => {
    const row = id ? platform.registry.byId(id) : undefined;
    return row ? { artifact_id: row.id, service: row.service, title: row.title, url: row.url, external_id: row.external_id } : null;
  };
  const waitFor = async (agentId: string, seconds: number) => {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      const agent = platform.agent(agentId)!;
      if (agent.run_count >= 1 && !(agent.status === 'active' && agent.next_run_at === null) && !inbox.busy()) return agent;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    return platform.agent(agentId)!;
  };
  const folderKeyPath = (artifactId?: string) => {
    if (!artifactId) return [];
    const row = platform.registry.byId(artifactId);
    if (!row || row.user_id !== grant.userId || row.service !== 'drive_folder') throw new Error('FOLDER_NOT_AVAILABLE');
    return row.logical_key.split('/folder:')[1].split('/');
  };

  server.tool('provision_and_run_agent',
    'Zero-setup entry point: turn any natural-language request into a persistent Clam agent across Gmail, Calendar, Drive, Docs, Sheets, and Photos. ' +
    'Clam compiles a validated plan, creates the agent, switches the user to it, and starts it in the backend under the policy engine, ' +
    'Tier 2 approval gate, and kill switch. Returns the agent id, plan summary, and dashboard URL.', {
      user_instruction: z.string().trim().min(4).max(4000),
      agent_name: z.string().trim().max(80).optional(),
      services: z.array(z.enum(services)).max(6).optional(),
      schedule_mode: z.enum(['one_shot', 'continuous', 'daily', 'weekly']).optional(),
      interval_seconds: z.number().int().min(60).max(604_800).optional(),
      auto_switch: z.boolean().default(true),
      source_cli: z.enum(['codex-cli', 'claude-code', 'cursor', 'cline']).optional(),
      wait_seconds: z.number().int().min(0).max(60).default(0),
    }, (input) => workflow('provision_and_run_agent', 'agent:manage', async () => {
      const result = await missions.provision({
        userId: grant.userId, inboxId: grant.inboxId, instruction: input.user_instruction, agentName: input.agent_name, services: input.services,
        scheduleMode: input.schedule_mode, intervalSeconds: input.interval_seconds, autoSwitch: input.auto_switch,
        sourceCli: detectSourceCli(client(), input.source_cli), switchedBy: 'cli_auto',
        authorize: (compiled, needed) => {
          // The backend agent can never exceed what this token itself may do.
          requireToken([
            ...(needed.some((service) => ['drive', 'docs', 'sheets'].includes(service)) ? ['workspace:write'] : []),
            ...(needed.includes('photos') ? ['photos:read'] : []), ...(needed.includes('gmail') ? ['mail:read'] : []),
            ...(compiled.plan.template === 'vendor_rfq' ? ['mail:send'] : []), ...(needed.includes('calendar') ? ['calendar:propose'] : []),
          ]);
          const program = compiled.plan.params.program;
          if (program) {
            requireToken(program.flatMap(genericStepScopes));
            compiled.plan.params.mcp_scopes = mcpScopes.filter((scope) => grant.scopes.includes(scope));
          }
          requireLive(needed);
        },
      });
      if (!input.wait_seconds) return result;
      const agent = await waitFor(result.agent_id, input.wait_seconds);
      return { ...result, status: agent.status, phase: agent.state.phase, pending_approvals: agent.state.pending_approvals,
        artifacts: platform.artifacts(grant.userId, agent.id).map((row) => artifactView(row.id)) };
    }));

  server.tool('switch_active_agent', "Switch the user's active Clam agent and record the switch in the audited timeline.", {
    agent_id: z.string().uuid(), reason: z.string().trim().max(300).optional(),
  }, ({ agent_id, reason }) => workflow('switch_active_agent', 'agent:manage', async () =>
    platform.switchAgent(grant.userId, agent_id, 'cli_manual', reason || 'Switched from a CLI agent')));

  server.tool('list_user_agents_and_logs', "Inspect the user's agents, switch history, created Drive/Docs/Sheets links, and step-by-step execution logs.", {
    agent_id: z.string().uuid().optional(), service: z.enum([...services, 'policy', 'system']).optional(), limit: z.number().int().min(1).max(200).default(50),
  }, ({ agent_id, service, limit }) => workflow('list_user_agents_and_logs', 'agent:manage', async () => {
    if (agent_id) platform.ownedAgent(grant.userId, agent_id);
    return {
      user: platform.profile(grant.userId, grant.inboxId),
      active_agent_id: platform.activeAgentId(grant.userId),
      agents: platform.agents(grant.userId).map(({ workflow_plan, ...agent }) => ({ ...agent, plan: { template: workflow_plan.template, steps: workflow_plan.steps.length } })),
      switch_history: platform.switches(grant.userId, 20),
      artifacts: platform.artifacts(grant.userId, agent_id).map((row) => ({ ...artifactView(row.id), summary: row.summary, updated_at: row.updated_at })),
      logs: platform.logs(grant.userId, { agentId: agent_id, service, limit }),
    };
  }));

  const direct = <T>(tool: string, scope: string, needed: Service[], work: Parameters<MissionRunner['direct']>[2], sourceCli?: string) =>
    workflow(tool, scope, async () => {
      requireLive(needed);
      const agent = interactive(sourceCli);
      const { result, run_id } = await missions.direct(agent, caller(tool), work);
      return { ...(result as T & object), run_id, agent_id: agent.id };
    });

  server.tool('drive_ensure_folder', 'Find or create a Drive folder (idempotent by name and parent). Uses drive.file; Clam can only see files it created.', {
    name: segment, parent_path: z.array(segment).max(4).optional(), parent_id: z.string().uuid().optional(),
  }, ({ name, parent_path, parent_id }) => direct('drive_ensure_folder', 'workspace:write', ['drive'], async (ops) => {
    const path = [...(parent_id ? folderKeyPath(parent_id) : parent_path ?? []), name];
    const { outcome } = await ops.ensureFolderPath(path);
    return { verified: outcome.verified, path, folder: artifactView(outcome.artifactId) };
  }));

  server.tool('drive_save_file', 'Save text, a report, or a screened staged attachment into a Drive folder. Secrets and unsupported types are blocked.', {
    folder_path: folderPath, file_name: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_. -]{0,120}$/).refine((value) => !value.includes('..')),
    mime_type: z.enum(['application/pdf', 'text/plain', 'text/csv', 'text/markdown', 'application/json']),
    content_text: z.string().max(200_000).optional(), staged_path: z.string().max(1024).optional(),
  }, (input) => direct('drive_save_file', 'workspace:write', ['drive'], async (ops) => {
    if (Boolean(input.content_text) === Boolean(input.staged_path)) throw new Error('PROVIDE_CONTENT_OR_STAGED_PATH');
    await ops.ensureFolderPath(input.folder_path);
    const saved = await ops.saveFile(input.folder_path, input.file_name, input.mime_type,
      input.content_text !== undefined ? { inline_text: input.content_text } : { staged_path: input.staged_path! });
    return { verified: saved.verified, decision: saved.decision, policy_rule_id: saved.ruleId, file: artifactView(saved.artifactId) };
  }));

  server.tool('drive_list_files', 'List Drive folders and files created or accessible through Clam (drive.file).', {
    folder_id: z.string().uuid().optional(), query: z.string().max(120).optional(),
  }, ({ folder_id, query }) => workflow('drive_list_files', 'workspace:write', async () => ({
    files: platform.artifacts(grant.userId).filter((row) => ['drive_folder', 'drive_file', 'google_doc', 'google_sheet'].includes(row.service) &&
      (!folder_id || row.parent_folder_id === folder_id) && (!query || row.title.toLowerCase().includes(query.toLowerCase())))
      .map((row) => ({ ...artifactView(row.id), parent_folder_id: row.parent_folder_id, summary: row.summary })),
  })));

  server.tool('sheets_create_tracker', 'Create or get a Google Sheet with formatted header rows (for example Daily Invoices or Vendor Quotes).', {
    title, folder_path: folderPath.optional(), sheets: z.array(z.object({ name: segment, headers: z.array(z.string().trim().min(1).max(60)).min(1).max(26) }).strict()).min(1).max(6),
  }, (input) => direct('sheets_create_tracker', 'workspace:write', ['drive', 'sheets'], async (ops) => {
    const folder = input.folder_path ? (await ops.ensureFolderPath(input.folder_path)).key : null;
    const sheet = await ops.ensureSpreadsheet(input.title, folder, input.sheets);
    return { verified: sheet.verified, decision: sheet.decision, policy_rule_id: sheet.ruleId, spreadsheet: artifactView(sheet.artifactId) };
  }));

  server.tool('sheets_append_rows', 'Idempotently append sanitized rows (formula injection is neutralized) and read back the row count.', {
    title, sheet_name: segment, rows: z.array(z.array(cell).max(26)).min(1).max(200), dedupe_key_column: z.string().max(60).optional(),
  }, (input) => direct('sheets_append_rows', 'workspace:write', ['sheets'], async (ops) => {
    const result = await ops.appendRows(input.title, input.sheet_name, input.rows, input.dedupe_key_column);
    return { ...result, spreadsheet: artifactView(platform.registry.get(grant.inboxId, result.key)?.id) };
  }));

  server.tool('sheets_update_cells', 'Update a rectangular A1 range in one sheet tab, for example totals, status columns, or winner flags.', {
    title, sheet_name: segment, range: z.string().regex(/^[A-Za-z]\d{1,4}(?::[A-Za-z]\d{1,4})?$/), values: z.array(z.array(cell).max(26)).min(1).max(100),
  }, (input) => direct('sheets_update_cells', 'workspace:write', ['sheets'], async (ops) => {
    const result = await ops.updateCells(input.title, input.sheet_name, input.range, input.values);
    return { verified: result.verified, decision: result.decision, policy_rule_id: result.ruleId, spreadsheet: artifactView(result.artifactId) };
  }));

  server.tool('docs_create_or_update', 'Create a Google Doc or append/replace a section, with read-back verification of the document.', {
    title, folder_path: folderPath.optional(), heading: z.string().trim().min(1).max(200), text: z.string().min(1).max(20_000),
    mode: z.enum(['append', 'replace_section']).default('replace_section'),
  }, (input) => direct('docs_create_or_update', 'workspace:write', ['docs'], async (ops) => {
    const folder = input.folder_path ? (await ops.ensureFolderPath(input.folder_path)).key : null;
    const doc = await ops.upsertDoc(input.title, folder, input.heading, input.text, input.mode);
    return { verified: doc.verified, decision: doc.decision, policy_rule_id: doc.ruleId, document: artifactView(doc.artifactId) };
  }));

  server.tool('photos_start_picker', 'Live Google Photos: start a Picker session. Open picker_uri, choose the receipts Clam may read, then call ' +
    'photos_search_and_extract. Clam never sees photos you did not pick.', {}, () => workflow('photos_start_picker', 'photos:read', async () => {
    requireLive(['photos']);
    const adapter = inbox.workspace(mode);
    if (!adapter.startPhotoPicker) return { mode: 'sandbox', picker_required: false, note: 'The $0 sandbox Photos library needs no picker.' };
    return { picker_required: true, ...await adapter.startPhotoPicker() };
  }));

  server.tool('photos_search_and_extract', 'Search receipt, ticket, document, or screenshot photos (read-only) and extract structured details in the quarantined parser.', {
    query_category: z.enum(['RECEIPTS', 'DOCUMENTS', 'SCREENSHOTS']).default('RECEIPTS'),
    date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    limit: z.number().int().min(1).max(10).default(5),
  }, (input) => direct('photos_search_and_extract', 'photos:read', ['photos'], async (_ops, context) => {
    const adapter = inbox.workspace(mode);
    const items = await adapter.searchPhotos({ category: input.query_category, dateFrom: input.date_from, dateTo: input.date_to, limit: input.limit });
    const details = [];
    for (const item of items) {
      context.checkout();
      const extracted = await extractPhotoDetails(adapter, item.id);
      const step = context.record('CHECK', { action: 'extract_photo_details', outcome: extracted.quarantined ? 'QUARANTINED' : 'VERIFIED',
        media_item_id: item.id, content_sha256: extracted.content_sha256 });
      const agent = interactive();
      platform.log({ userId: grant.userId, agentId: agent.id, runId: context.runId, service: 'photos', action: 'extract_photo_details',
        input: item.filename, output: extracted.quarantined ? 'Quarantined' : JSON.stringify(extracted.fields),
        verdict: extracted.quarantined ? 'BLOCKED' : 'ALLOW_TIER_0', ruleId: extracted.quarantined ? 'HOSTILE_IMAGE_TEXT_QUARANTINED' : 'READ_ONLY_SCOPED',
        verified: true, traceStepHash: step.step_hash });
      details.push(extracted);
    }
    return { photos: details };
  }));
}
