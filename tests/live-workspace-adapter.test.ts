import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { GoogleAccounts, GoogleCapability } from '../apps/server/src/auth/google.js';
import { InboxStore } from '../apps/server/src/inbox/store.js';
import { canonicalJson } from '../apps/server/src/inbox/trace.js';
import { describeContent, LiveGoogleWorkspaceAdapter } from '../apps/server/src/workspace/adapters.js';
import { WorkspaceRegistry } from '../apps/server/src/workspace/registry.js';
import { verifiedState, type WorkspaceState } from '../apps/server/src/workspace/types.js';

type File = { id: string; name: string; mimeType: string; parents: string[]; trashed: boolean; size?: string; md5Checksum?: string };
type Paragraph = { text: string; style: string };

/** In-memory Google Drive / Sheets / Docs REST fake covering exactly the endpoints the live adapter uses. */
function fakeGoogle() {
  const files = new Map<string, File>();
  const sheets = new Map<string, Map<string, unknown[][]>>();
  const docs = new Map<string, Paragraph[]>();
  const calls: Array<{ capability: GoogleCapability; method: string; url: string }> = [];
  let next = 0;
  const id = () => 'g' + (++next).toString().padStart(4, '0');
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const docBody = (paragraphs: Paragraph[]) => {
    let index = 1;
    const content = [...paragraphs, { text: '', style: 'NORMAL_TEXT' }].map((paragraph) => {
      index += paragraph.text.length + 1;
      return { endIndex: index, paragraph: { paragraphStyle: { namedStyleType: paragraph.style }, elements: [{ textRun: { content: paragraph.text + '\n' } }] } };
    });
    return { body: { content: [{ endIndex: 1 }, ...content] } };
  };
  const api = async (_inbox: string, capability: GoogleCapability, raw: string, guard: () => void, init: RequestInit = {}) => {
    guard();
    const url = new URL(raw);
    const method = init.method ?? 'GET';
    calls.push({ capability, method, url: raw });
    const body = typeof init.body === 'string' ? JSON.parse(init.body || '{}') : init.body;
    const segments = url.pathname.split('/').filter(Boolean);
    if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/upload/drive/v3/files')) {
      const buffer = Buffer.from(body as Buffer);
      const boundary = /boundary=(\S+)/.exec(new Headers(init.headers).get('Content-Type')!)![1];
      const [, metaPart, mediaPart] = buffer.toString('latin1').split('--' + boundary);
      const metadata = JSON.parse(metaPart.split('\r\n\r\n')[1]);
      const media = Buffer.from(mediaPart.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''), 'latin1');
      const fileId = segments[4] ?? id();
      const previous = files.get(fileId);
      files.set(fileId, { id: fileId, name: metadata.name, mimeType: metadata.mimeType, parents: metadata.parents ?? previous?.parents ?? ['root'],
        trashed: false, ...{ size: String(describeContent(media).bytes), md5Checksum: describeContent(media).md5 } });
      return json({ id: fileId });
    }
    if (url.hostname === 'www.googleapis.com') {
      const fileId = segments[3];
      if (!fileId && method === 'GET') {
        const query = url.searchParams.get('q')!;
        const name = /name = '([^']+)'/.exec(query)![1];
        const parent = /'([^']+)' in parents/.exec(query)![1];
        return json({ files: [...files.values()].filter((file) => file.name === name && file.parents.includes(parent) && !file.trashed) });
      }
      if (!fileId && method === 'POST') {
        const created = { id: id(), name: body.name, mimeType: body.mimeType, parents: body.parents ?? ['root'], trashed: false };
        files.set(created.id, created);
        return json({ id: created.id });
      }
      const file = files.get(fileId);
      if (!file) return json({ error: { code: 404 } }, 404);
      if (method === 'DELETE') { files.delete(fileId); sheets.delete(fileId); docs.delete(fileId); return new Response(null, { status: 204 }); }
      if (method === 'PATCH') {
        file.parents = [...file.parents.filter((parent) => !(url.searchParams.get('removeParents') ?? '').split(',').includes(parent)), url.searchParams.get('addParents')!];
        return json({ id: fileId });
      }
      return json(file);
    }
    if (url.hostname === 'sheets.googleapis.com') {
      if (segments.length === 2 && method === 'POST') {
        const sheetId = id();
        files.set(sheetId, { id: sheetId, name: body.properties.title, mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['root'], trashed: false });
        sheets.set(sheetId, new Map(body.sheets.map((sheet: { properties: { title: string } }) => [sheet.properties.title, []])));
        return json({ spreadsheetId: sheetId });
      }
      const sheetId = decodeURIComponent(segments[2].split(':')[0]);
      const book = sheets.get(sheetId)!;
      if (segments[2].endsWith(':batchUpdate')) {
        for (const request of body.requests) book.set(request.addSheet.properties.title, []);
        return json({});
      }
      if (segments.length === 3) return json({ sheets: [...book.keys()].map((title) => ({ properties: { title } })) });
      if (segments[4] === 'values:batchGet' || segments[3] === 'values:batchGet') {
        expect(url.searchParams.get('valueRenderOption')).toBe('UNFORMATTED_VALUE');
        return json({ valueRanges: url.searchParams.getAll('ranges').map((range) => ({ values: book.get(/^'(.+)'!/.exec(range)![1].replace(/''/g, "'")) })) });
      }
      const range = decodeURIComponent(url.pathname.split('/values/')[1]);
      const tab = /^'(.+)'!/.exec(range)![1].replace(/''/g, "'");
      if (range.endsWith(':clear')) { book.set(tab, []); return json({}); }
      // Values are stored exactly as sent; the adapter must never ask Sheets to parse formulas.
      expect(url.searchParams.get('valueInputOption')).toBe('RAW');
      book.set(tab, body.values);
      return json({});
    }
    if (url.hostname === 'docs.googleapis.com') {
      if (segments.length === 2 && method === 'POST') {
        const docId = id();
        files.set(docId, { id: docId, name: body.title, mimeType: 'application/vnd.google-apps.document', parents: ['root'], trashed: false });
        docs.set(docId, []);
        return json({ documentId: docId });
      }
      const docId = decodeURIComponent(segments[2].split(':')[0]);
      if (segments[2].endsWith(':batchUpdate')) {
        let paragraphs = docs.get(docId)!;
        let text = '';
        const styles: Array<[number, number, string]> = [];
        for (const request of body.requests) {
          if (request.deleteContentRange) paragraphs = [];
          if (request.insertText) text = request.insertText.text;
          if (request.updateParagraphStyle) styles.push([request.updateParagraphStyle.range.startIndex, request.updateParagraphStyle.range.endIndex,
            request.updateParagraphStyle.paragraphStyle.namedStyleType]);
        }
        let start = 1;
        paragraphs = text.split('\n').slice(0, -1).map((line) => {
          const paragraph = { text: line, style: styles.filter(([from, to]) => from <= start && start < to).at(-1)?.[2] ?? 'NORMAL_TEXT' };
          start += line.length + 1;
          return paragraph;
        });
        docs.set(docId, paragraphs);
        return json({});
      }
      return json({ title: files.get(docId)!.name, ...docBody(docs.get(docId)!) });
    }
    throw new Error('Unexpected Google endpoint ' + raw);
  };
  return { api, files, calls };
}

it('round-trips Drive folders/files, Sheets (RAW), and Docs through the live Google adapter with exact read-back snapshots', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'clam-live-adapter-'));
  const store = new InboxStore(':memory:');
  try {
    const google = fakeGoogle();
    const registry = new WorkspaceRegistry(store.sqlite);
    const accounts = { api: google.api } as unknown as GoogleAccounts;
    const adapter = new LiveGoogleWorkspaceAdapter(accounts, 'inbox-1', registry, () => undefined, dir);
    const signal = new AbortController().signal;
    const write = async (key: string, state: WorkspaceState) => {
      const before = await adapter.read(key);
      const receipt = await adapter.write(key, before, state, signal);
      registry.upsert({ inboxId: 'inbox-1', key, userId: 'u', agentId: null, service: state.type, title: state.type === 'drive_folder' || state.type === 'drive_file' ? state.name : state.title,
        externalId: receipt.externalId, url: receipt.url, parentKey: state.type === 'drive_folder' ? state.parent : state.folder, runId: null });
      const after = await adapter.read(key);
      expect(canonicalJson(after)).toBe(canonicalJson(verifiedState(state)));
      return receipt;
    };

    const clam = await write('u/folder:Clam', { type: 'drive_folder', name: 'Clam', parent: null });
    expect(clam.url).toBe('https://drive.google.com/drive/folders/' + clam.externalId);
    await write('u/folder:Clam/Invoices', { type: 'drive_folder', name: 'Invoices', parent: 'u/folder:Clam' });
    // Idempotent: a lost registry entry is recovered by name + parent instead of creating a duplicate folder.
    store.sqlite.prepare("DELETE FROM workspace_artifacts WHERE logical_key='u/folder:Clam/Invoices'").run();
    expect(await adapter.read('u/folder:Clam/Invoices')).toEqual({ type: 'drive_folder', name: 'Invoices', parent: 'u/folder:Clam' });
    await write('u/folder:Clam/Invoices', { type: 'drive_folder', name: 'Invoices', parent: 'u/folder:Clam' });
    expect([...google.files.values()].filter((file) => file.name === 'Invoices')).toHaveLength(1);

    const text = 'Vendor,Amount\nFigma,45\n';
    const content = describeContent(Buffer.from(text));
    await write('u/file:Clam/Invoices/report.csv', { type: 'drive_file', name: 'report.csv', folder: 'u/folder:Clam/Invoices', mime: 'text/csv', ...content,
      source: { inline_text: text }, content_scan: { secret: false, injection: false, extracted: true } });

    const sheet: WorkspaceState = { type: 'google_sheet', title: 'Ledger', folder: 'u/folder:Clam/Invoices', tabs: [
      { name: 'Daily Invoices', headers: ['Invoice #', 'Amount', 'Notes'], rows: [['FIG-3391', 45, "'=IMPORTXML (\"x\")"]] }] };
    const created = await write('u/sheet:Ledger', sheet);
    expect(created.url).toBe(`https://docs.google.com/spreadsheets/d/${created.externalId}/edit`);
    await write('u/sheet:Ledger', { ...sheet, tabs: [{ ...sheet.tabs[0], rows: [...sheet.tabs[0].rows, ['PC-1207', 318.4, '']] },
      { name: "Vendor's Bills", headers: ['Vendor'], rows: [['Notion']] }] });

    const doc: WorkspaceState = { type: 'google_doc', title: 'Summary', folder: 'u/folder:Clam/Invoices',
      sections: [{ heading: 'Daily digest', text: 'Invoices logged: 2\n• Figma · 45.00' }, { heading: 'Flags', text: '' }] };
    await write('u/doc:Summary', doc);
    await write('u/doc:Summary', { ...doc, sections: [{ heading: 'Daily digest', text: 'Invoices logged: 3' }, ...doc.sections.slice(1)] });

    // Rollback removes only artifacts Clam created, by the id recorded in its own registry.
    await adapter.remove('u/doc:Summary', signal);
    expect(await adapter.read('u/doc:Summary')).toBeNull();

    // Least privilege: only Drive (drive.file), Sheets, and Docs capabilities were used; no Photos or Gmail calls.
    expect(new Set(google.calls.map((call) => call.capability))).toEqual(new Set(['drive:write', 'sheets:write', 'docs:write']));
    expect(google.calls.some((call) => call.method === 'DELETE' && !call.url.endsWith('/' + registry.get('inbox-1', 'u/doc:Summary')!.external_id))).toBe(false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
