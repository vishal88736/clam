import type { InboxCalendarEvent } from '@clam/shared';
import type { ActionKind, Claim, InboxTarget, SafeAction, Snapshot, Tier } from '../inbox/contracts.js';
import type { WorkspaceRegistry } from './registry.js';
import { titleOf, type WorkspaceAdapter, type WorkspaceState } from './types.js';

export interface WorkspaceOwner {
  userId: string;
  agentId: string | null;
  inboxId: string;
  runId?: string | null;
}

/**
 * Routes `workspace` actions to the Drive/Docs/Sheets adapter while every other kind keeps its existing
 * Gmail/Calendar target. Because it is an ordinary InboxTarget, workspace writes inherit the engine's
 * claim ledger, kill-switch triggers, read-back CHECK, idempotent reconciliation, and rollback.
 */
export class CompositeTarget implements InboxTarget {
  constructor(private readonly base: InboxTarget, private readonly workspace: WorkspaceAdapter,
    private readonly registry: WorkspaceRegistry, private readonly inboxId: string) {}

  read(action: Pick<SafeAction, 'kind' | 'target'>, providerId?: string | null): Promise<Snapshot> {
    return action.kind === 'workspace' ? this.workspace.read(action.target) : this.base.read(action, providerId);
  }

  calendar(): Promise<InboxCalendarEvent[]> {
    return this.base.calendar();
  }

  all(kind: ActionKind) {
    return this.base.all(kind);
  }

  async dispatch(action: SafeAction, tier: Tier, before: Snapshot, id: string, signal: AbortSignal) {
    if (action.kind !== 'workspace') return this.base.dispatch(action, tier, before, id, signal);
    const state = action.after as unknown as WorkspaceState;
    const owner = action.workspaceOwner;
    if (!owner) throw new Error('WORKSPACE_OWNER_REQUIRED');
    const receipt = await this.workspace.write(action.target, before, state, signal);
    this.registry.upsert({
      inboxId: this.inboxId, key: action.target, userId: owner.userId, agentId: owner.agentId, service: state.type,
      title: titleOf(state), externalId: receipt.externalId, url: receipt.url,
      parentKey: state.type === 'drive_folder' ? state.parent : state.folder, runId: owner.runId ?? null,
    });
    return action.target;
  }

  async restore(claim: Claim, signal: AbortSignal) {
    if (claim.kind !== 'workspace') return this.base.restore(claim, signal);
    if (claim.before === null) {
      await this.workspace.remove(claim.target, signal);
      this.registry.markRemoved(this.inboxId, claim.target);
      return;
    }
    const before = claim.before as unknown as WorkspaceState;
    if (before.type === 'drive_file') throw new Error('FILE_CONTENT_ROLLBACK_UNSUPPORTED');
    await this.workspace.write(claim.target, claim.after, before, signal);
  }
}
