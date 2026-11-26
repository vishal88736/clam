import { scanOutboundSecrets, scanPromptInjection } from '@clam/shared';
import type { PolicyVerdict, SafeAction } from '../inbox/contracts.js';
import { flattenText, hasLiveFormula } from './sanitize.js';
import { verifiedState, type WorkspaceState } from './types.js';

const allowedFileTypes = new Set(['application/pdf', 'text/plain', 'text/csv', 'text/markdown', 'application/json', 'image/svg+xml', 'image/png', 'image/jpeg']);
const verdict = (decision: PolicyVerdict['decision'], tier: PolicyVerdict['tier'], ruleId: string, reason: string): PolicyVerdict =>
  ({ decision, tier, ruleId, reason });

/**
 * Policy for Drive, Docs, and Sheets writes. Writes are reversible (Tier 0) once they pass the secret scanner,
 * the formula/taint firewall, and the file-type allowlist. Clam can never delete or share unrelated files:
 * the only provider deletion is a rollback of an artifact Clam itself created in this run.
 */
export function evaluateWorkspaceAction(action: SafeAction): PolicyVerdict {
  const state = action.after as unknown as WorkspaceState | null;
  if (!state || !['drive_folder', 'drive_file', 'google_doc', 'google_sheet'].includes(state.type)) {
    return verdict('BLOCKED', 2, 'WORKSPACE_ACTION_INVALID', 'Only Drive folders/files, Docs, and Sheets can be written.');
  }
  const text = flattenText(verifiedState(state)) +
    (state.type === 'drive_file' && state.source && 'inline_text' in state.source ? '\n' + state.source.inline_text : '');
  if (state.type === 'drive_file' && (!state.content_scan || state.content_scan.secret)) {
    return verdict('BLOCKED', 2, state.content_scan ? 'WORKSPACE_SECRET_BLOCKED' : 'WORKSPACE_CONTENT_UNSCANNED', 'File content failed or skipped the secret scanner.');
  }
  if (state.type === 'drive_file' && state.content_scan?.injection) {
    return verdict('BLOCKED', 2, 'WORKSPACE_UNTRUSTED_INSTRUCTION', 'File content carries an untrusted instruction.');
  }
  if (scanOutboundSecrets(text)) return verdict('BLOCKED', 2, 'WORKSPACE_SECRET_BLOCKED', 'Workspace content contains a credential or secret.');
  if (state.type === 'google_sheet' && state.tabs.some((tab) => hasLiveFormula(tab.rows) || hasLiveFormula(tab.headers))) {
    return verdict('BLOCKED', 2, 'WORKSPACE_FORMULA_INJECTION', 'A cell would be evaluated as a spreadsheet formula.');
  }
  if (scanPromptInjection(text).detected) {
    return verdict('BLOCKED', 2, 'WORKSPACE_UNTRUSTED_INSTRUCTION', 'Workspace content carries an untrusted instruction.');
  }
  if (state.type === 'drive_file' && !allowedFileTypes.has(state.mime)) {
    return verdict('BLOCKED', 2, 'WORKSPACE_FILE_TYPE_BLOCKED', 'This file type cannot be saved to Drive by an agent.');
  }
  if (action.requestedTier === 2) return verdict('APPROVAL_REQUIRED', 2, action.reason ?? 'WORKSPACE_OPERATOR_REVIEW', 'This workspace change requires review.');
  return verdict('AUTONOMOUS', 0, 'WORKSPACE_REVERSIBLE_WRITE', 'Reversible workspace write passed the secret, taint, and type checks.');
}
