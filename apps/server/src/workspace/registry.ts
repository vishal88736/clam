import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ArtifactService } from './types.js';

export interface ArtifactRow {
  id: string;
  user_id: string;
  agent_id: string | null;
  inbox_id: string;
  service: ArtifactService;
  logical_key: string;
  external_id: string | null;
  title: string;
  url: string | null;
  parent_folder_id: string | null;
  summary: string;
  last_updated_by_run_id: string | null;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
}

/** Maps Clam's logical workspace keys to provider ids, and tracks every artifact Clam created. */
export class WorkspaceRegistry {
  constructor(private readonly db: DatabaseSync) {}

  get(inboxId: string, key: string): ArtifactRow | undefined {
    return this.db.prepare('SELECT * FROM workspace_artifacts WHERE inbox_id=? AND logical_key=?').get(inboxId, key) as ArtifactRow | undefined;
  }

  byId(id: string): ArtifactRow | undefined {
    return this.db.prepare('SELECT * FROM workspace_artifacts WHERE id=?').get(id) as ArtifactRow | undefined;
  }

  externalId(inboxId: string, key: string | null) {
    if (!key) return null;
    const row = this.get(inboxId, key);
    return row && !row.removed_at ? row.external_id : null;
  }

  keyFor(inboxId: string, externalId: string | undefined) {
    if (!externalId) return null;
    const row = this.db.prepare('SELECT logical_key FROM workspace_artifacts WHERE inbox_id=? AND external_id=? AND removed_at IS NULL')
      .get(inboxId, externalId) as { logical_key: string } | undefined;
    return row?.logical_key ?? null;
  }

  upsert(entry: {
    inboxId: string; key: string; userId: string; agentId: string | null; service: ArtifactService; title: string;
    externalId: string | null; url: string | null; parentKey: string | null; runId: string | null; summary?: string;
  }): ArtifactRow {
    const at = new Date().toISOString();
    const parent = entry.parentKey ? this.get(entry.inboxId, entry.parentKey)?.id ?? null : null;
    const existing = this.get(entry.inboxId, entry.key);
    if (existing) {
      this.db.prepare(`UPDATE workspace_artifacts SET agent_id=coalesce(?,agent_id), title=?, external_id=coalesce(?,external_id),
        url=coalesce(?,url), parent_folder_id=?, summary=coalesce(?,summary), last_updated_by_run_id=coalesce(?,last_updated_by_run_id),
        updated_at=?, removed_at=NULL WHERE id=?`).run(entry.agentId, entry.title, entry.externalId, entry.url, parent,
        entry.summary ?? null, entry.runId, at, existing.id);
    } else {
      this.db.prepare(`INSERT INTO workspace_artifacts (id,user_id,agent_id,inbox_id,service,logical_key,external_id,title,url,
        parent_folder_id,summary,last_updated_by_run_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(), entry.userId, entry.agentId, entry.inboxId, entry.service, entry.key, entry.externalId, entry.title,
        entry.url, parent, entry.summary ?? '', entry.runId, at, at);
    }
    return this.get(entry.inboxId, entry.key)!;
  }

  summarize(inboxId: string, key: string, summary: string, runId: string | null) {
    this.db.prepare('UPDATE workspace_artifacts SET summary=?, last_updated_by_run_id=coalesce(?,last_updated_by_run_id), updated_at=? WHERE inbox_id=? AND logical_key=?')
      .run(summary.slice(0, 400), runId, new Date().toISOString(), inboxId, key);
  }

  markRemoved(inboxId: string, key: string) {
    this.db.prepare('UPDATE workspace_artifacts SET removed_at=?, updated_at=? WHERE inbox_id=? AND logical_key=?')
      .run(new Date().toISOString(), new Date().toISOString(), inboxId, key);
  }

  list(userId: string, options: { agentId?: string; includeRemoved?: boolean } = {}): ArtifactRow[] {
    return this.db.prepare(`SELECT * FROM workspace_artifacts WHERE user_id=? AND (? IS NULL OR agent_id=?)
      AND (? OR removed_at IS NULL) ORDER BY updated_at DESC LIMIT 200`)
      .all(userId, options.agentId ?? null, options.agentId ?? null, Number(Boolean(options.includeRemoved))) as unknown as ArtifactRow[];
  }
}
