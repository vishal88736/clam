import { createHash } from 'node:crypto';
import { scanOutboundSecrets, scanPromptInjection } from '@clam/shared';
import { readAttachments } from '../inbox/attachments.js';
import type { SafeAction, Snapshot } from '../inbox/contracts.js';
import type { MissionContext, MissionOutcome } from '../inbox/engine.js';
import { canonicalJson, sha256 } from '../inbox/trace.js';
import { describeContent, loadContent } from '../workspace/adapters.js';
import { sanitizeRows, sanitizeText } from '../workspace/sanitize.js';
import {
  trimRow, verifiedState, type Cell, type ContentSource, type DocSection, type SheetTab, type WorkspaceAdapter, type WorkspaceState,
} from '../workspace/types.js';
import type { LogService, PlatformService, PolicyVerdictLabel } from './service.js';

export interface MissionIdentity {
  userId: string;
  agentId: string;
  inboxId: string;
}

export const verdictLabel = (outcome: Pick<MissionOutcome, 'decision' | 'tier'>): PolicyVerdictLabel =>
  outcome.decision === 'BLOCKED' ? 'BLOCKED' : outcome.decision === 'APPROVAL_REQUIRED' ? 'GATE_TIER_2' : outcome.tier === 1 ? 'ALLOW_TIER_1' : 'ALLOW_TIER_0';

const serviceFor = (state: WorkspaceState): LogService =>
  state.type === 'google_sheet' ? 'sheets' : state.type === 'google_doc' ? 'docs' : 'drive';

/** Logical keys are namespaced per user so two operators never share sandbox artifacts. */
export const namespace = (userId: string) => 'u:' + createHash('sha256').update(userId).digest('hex').slice(0, 12);

/**
 * Policy-gated Drive/Docs/Sheets operations. Each method computes the complete desired state, submits it as a
 * single `workspace` action (POLICY → ACT → read-back CHECK), and journals the step in agent_execution_logs.
 */
export class WorkspaceOps {
  readonly flags = new Set<string>();

  constructor(private readonly context: MissionContext, private readonly adapter: WorkspaceAdapter,
    private readonly platform: PlatformService, private readonly who: MissionIdentity, private readonly stagingRoot: string) {}

  private get ns() { return namespace(this.who.userId); }
  folderKey(path: string[]) { return `${this.ns}/folder:${path.join('/')}`; }
  sheetKey(title: string) { return `${this.ns}/sheet:${title}`; }
  docKey(title: string) { return `${this.ns}/doc:${title}`; }
  fileKey(folder: string[], name: string) { return `${this.ns}/file:${folder.join('/')}/${name}`; }

  read(key: string) {
    return this.adapter.read(key);
  }

  async submit(key: string, after: WorkspaceState, before: Snapshot, operation: string, input: string, output: string,
    sourceId?: string): Promise<MissionOutcome & { artifactId: string | null }> {
    const version = sha256(canonicalJson(verifiedState(after)));
    const action: SafeAction = {
      kind: 'workspace', target: key, playbook: 'workspace_' + operation, sourceId: sourceId ?? 'agent:' + this.who.agentId,
      version, after: after as unknown as Record<string, unknown>, expectedBefore: before, requestedTier: 0, confidence: 1,
      workspaceOwner: { userId: this.who.userId, agentId: this.who.agentId, runId: this.context.runId },
    };
    const outcome = await this.context.execute(action);
    const artifact = this.platform.registry.get(this.who.inboxId, key);
    if (outcome.verified && artifact) this.platform.registry.summarize(this.who.inboxId, key, output, this.context.runId);
    this.platform.log({
      userId: this.who.userId, agentId: this.who.agentId, runId: this.context.runId, service: serviceFor(after), action: operation,
      input, output: outcome.decision === 'BLOCKED' ? `Blocked by ${outcome.ruleId}` : outcome.verified ? output : `${outcome.outcome || outcome.decision}`,
      verdict: verdictLabel(outcome), ruleId: outcome.ruleId, verified: outcome.verified,
      artifactId: artifact?.id ?? null, traceStepHash: (outcome.checkStep ?? outcome.policyStep).step_hash,
    });
    this.platform.artifactChanged(this.who.userId, artifact?.id ?? null);
    return { ...outcome, artifactId: artifact?.id ?? null };
  }

  /** Finds or creates each folder in the path (idempotent by name + parent). Returns the deepest key. */
  async ensureFolderPath(path: string[]) {
    let parent: string | null = null;
    let last: (MissionOutcome & { artifactId: string | null }) | null = null;
    for (let depth = 1; depth <= path.length; depth++) {
      const key = this.folderKey(path.slice(0, depth));
      const before = await this.read(key);
      const after: WorkspaceState = { type: 'drive_folder', name: path[depth - 1], parent };
      last = await this.submit(key, after, before, 'ensure_drive_folder', `name=${path[depth - 1]} parent=${parent ? path.slice(0, depth - 1).join('/') : 'root'}`,
        `Folder ${path.slice(0, depth).join(' / ')} ${before ? 'already present' : 'created'}`);
      if (!last.verified) throw new Error(last.decision === 'BLOCKED' ? last.ruleId : 'WORKSPACE_FOLDER_UNVERIFIED');
      parent = key;
    }
    return { key: parent!, outcome: last! };
  }

  async saveFile(folder: string[], name: string, mime: string, source: ContentSource, sourceId?: string) {
    const bytes = await loadContent(source, this.stagingRoot);
    const folderKey = this.folderKey(folder);
    const key = this.fileKey(folder, name);
    const before = await this.read(key);
    // Secret scanner on file content: text is scanned directly, PDFs through the quarantined text extractor.
    const textual = mime === 'application/pdf' ? await readAttachments([{ name: 'scan.pdf', mime, data: bytes.toString('base64url') }]).catch(() => null)
      : /^(?:text\/|application\/json)/.test(mime) ? bytes.toString('utf8') : null;
    const content_scan = { secret: textual === null ? false : Boolean(scanOutboundSecrets(textual)),
      injection: textual === null ? false : scanPromptInjection(textual).detected, extracted: textual !== null };
    const after: WorkspaceState = { type: 'drive_file', name, folder: folderKey, mime, ...describeContent(bytes), source, content_scan };
    return { key, ...await this.submit(key, after, before, 'upload_or_update_drive_file', `${name} (${mime}, ${bytes.length} bytes) → ${folder.join(' / ')}`,
      `Saved ${name} to ${folder.join(' / ')}`, sourceId) };
  }

  /** Creates the spreadsheet (or adds missing tabs) with header rows. Existing rows are never touched. */
  async ensureSpreadsheet(title: string, folderKey: string | null, tabs: { name: string; headers: string[] }[]) {
    const key = this.sheetKey(title);
    const before = await this.read(key) as unknown as Extract<WorkspaceState, { type: 'google_sheet' }> | null;
    const existing = before?.tabs ?? [];
    const merged: SheetTab[] = [...existing.map((tab) => ({ ...tab })), ...tabs.filter((tab) => !existing.some((item) => item.name === tab.name))
      .map((tab) => ({ name: tab.name, headers: tab.headers, rows: [] }))];
    const after: WorkspaceState = { type: 'google_sheet', title, folder: before ? before.folder : folderKey, tabs: merged };
    const outcome = await this.submit(key, after, before as unknown as Snapshot, 'create_or_get_spreadsheet', `${title} tabs=${tabs.map((tab) => tab.name).join(', ')}`,
      before ? `Spreadsheet ${title} ready (${merged.length} tabs)` : `Created spreadsheet ${title}`);
    return { key, ...outcome };
  }

  /** Idempotent append: rows whose dedupe column value is already present are skipped. Returns the read-back row count. */
  async appendRows(title: string, tabName: string, rows: unknown[][], dedupeColumn?: string, sourceId?: string) {
    const key = this.sheetKey(title);
    const before = await this.read(key) as unknown as Extract<WorkspaceState, { type: 'google_sheet' }> | null;
    if (!before) throw new Error('SPREADSHEET_NOT_AVAILABLE');
    const tab = before.tabs.find((item) => item.name === tabName);
    if (!tab) throw new Error('SHEET_TAB_NOT_AVAILABLE');
    const clean = sanitizeRows(rows);
    clean.flags.forEach((flag) => this.flags.add(flag));
    const column = dedupeColumn ? tab.headers.indexOf(dedupeColumn) : -1;
    const seen = new Set(column >= 0 ? tab.rows.map((row) => String(row[column] ?? '')) : []);
    const fresh: Cell[][] = [];
    for (const row of clean.value) {
      const id = column >= 0 ? String(row[column] ?? '') : canonicalJson(row);
      if (column >= 0 && seen.has(id)) continue;
      if (column < 0 && tab.rows.some((existing) => canonicalJson(trimRow(existing)) === canonicalJson(trimRow(row)))) continue;
      seen.add(id);
      fresh.push(trimRow(row));
    }
    const skipped = clean.value.length - fresh.length;
    if (!fresh.length) {
      const record = this.context.record('CHECK', { action: 'append_sheet_rows', target: key, outcome: 'ALREADY_CURRENT', rows_skipped_duplicates: skipped, row_count: tab.rows.length });
      this.platform.log({ userId: this.who.userId, agentId: this.who.agentId, runId: this.context.runId, service: 'sheets', action: 'append_sheet_rows',
        input: `${title} / ${tabName}: ${rows.length} candidate rows`, output: `${tabName}: no new rows; ${skipped} duplicates skipped (row count ${tab.rows.length})`,
        verdict: 'ALLOW_TIER_0', ruleId: 'IDEMPOTENT_DEDUPE', verified: true, artifactId: this.platform.registry.get(this.who.inboxId, key)?.id, traceStepHash: record.step_hash });
      return { key, appended: 0, skipped, rowCount: tab.rows.length, verified: true, decision: 'AUTONOMOUS' as const, ruleId: 'IDEMPOTENT_DEDUPE', flags: clean.flags };
    }
    const after: WorkspaceState = { type: 'google_sheet', title, folder: before.folder,
      tabs: before.tabs.map((item) => item.name === tabName ? { ...item, rows: [...item.rows, ...fresh] } : item) };
    const outcome = await this.submit(key, after, before as unknown as Snapshot, 'append_sheet_rows',
      `${title} / ${tabName}: ${rows.length} candidate rows${clean.flags.length ? ' · sanitized ' + clean.flags.join(', ') : ''}`,
      `${tabName}: appended ${fresh.length} rows (${skipped} duplicates skipped); read-back row count ${tab.rows.length + fresh.length}`, sourceId);
    const actual = await this.read(key) as unknown as Extract<WorkspaceState, { type: 'google_sheet' }> | null;
    const rowCount = actual?.tabs.find((item) => item.name === tabName)?.rows.length ?? 0;
    return { key, appended: outcome.verified ? fresh.length : 0, skipped, rowCount, verified: outcome.verified, decision: outcome.decision,
      ruleId: outcome.ruleId, flags: clean.flags, artifactId: outcome.artifactId };
  }

  /** Updates a rectangular A1 range (e.g. "I2:I4") inside one tab. Row 1 is the header row. */
  async updateCells(title: string, tabName: string, range: string, values: unknown[][]) {
    const key = this.sheetKey(title);
    const before = await this.read(key) as unknown as Extract<WorkspaceState, { type: 'google_sheet' }> | null;
    if (!before) throw new Error('SPREADSHEET_NOT_AVAILABLE');
    const match = /^([A-Z])(\d{1,4})(?::([A-Z])(\d{1,4}))?$/.exec(range.toUpperCase());
    if (!match) throw new Error('INVALID_RANGE');
    const [startCol, startRow] = [match[1].charCodeAt(0) - 65, Number(match[2])];
    const [endCol, endRow] = [match[3] ? match[3].charCodeAt(0) - 65 : startCol, match[4] ? Number(match[4]) : startRow];
    if (startRow < 1 || endRow < startRow || endCol < startCol || values.length !== endRow - startRow + 1 ||
        values.some((row) => row.length !== endCol - startCol + 1)) throw new Error('INVALID_RANGE');
    const clean = sanitizeRows(values);
    clean.flags.forEach((flag) => this.flags.add(flag));
    const tabs = before.tabs.map((tab) => {
      if (tab.name !== tabName) return tab;
      const grid: Cell[][] = [tab.headers, ...tab.rows].map((row) => [...row]);
      for (let r = startRow; r <= endRow; r++) {
        while (grid.length < r) grid.push([]);
        const row = grid[r - 1];
        for (let c = startCol; c <= endCol; c++) {
          while (row.length < c) row.push('');
          row[c] = clean.value[r - startRow][c - startCol];
        }
      }
      return { ...tab, headers: grid[0].map(String), rows: grid.slice(1).map(trimRow) };
    });
    if (!tabs.some((tab) => tab.name === tabName)) throw new Error('SHEET_TAB_NOT_AVAILABLE');
    const after: WorkspaceState = { type: 'google_sheet', title, folder: before.folder, tabs };
    return { key, ...await this.submit(key, after, before as unknown as Snapshot, 'update_sheet_cells', `${title} / ${tabName}!${range}`,
      `Updated ${tabName}!${range}`) };
  }

  async upsertDoc(title: string, folderKey: string | null, heading: string, body: string, mode: 'append' | 'replace_section', sourceId?: string) {
    const key = this.docKey(title);
    const before = await this.read(key) as unknown as Extract<WorkspaceState, { type: 'google_doc' }> | null;
    const clean = sanitizeText(body);
    clean.flags.forEach((flag) => this.flags.add(flag));
    const section: DocSection = { heading: sanitizeText(heading, 200).value.replace(/\n/g, ' ').trim(), text: clean.value.trim() };
    const sections = [...before?.sections ?? []];
    const index = sections.findIndex((item) => item.heading === section.heading);
    if (mode === 'replace_section' && index >= 0) sections[index] = section;
    else sections.push(section);
    const after: WorkspaceState = { type: 'google_doc', title, folder: before ? before.folder : folderKey, sections };
    return { key, ...await this.submit(key, after, before as unknown as Snapshot, 'append_or_update_doc_section',
      `${title} § ${section.heading} (${mode})`, `${mode === 'replace_section' && index >= 0 ? 'Replaced' : 'Wrote'} section "${section.heading}"; ${sections.length} sections verified`, sourceId) };
  }
}
