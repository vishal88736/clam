import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { GoogleAccounts, GoogleCapability } from '../apps/server/src/auth/google.js';
import { InboxStore } from '../apps/server/src/inbox/store.js';
import { InboxEngine } from '../apps/server/src/inbox/engine.js';
import { SandboxTarget } from '../apps/server/src/inbox/targets.js';
import { canonicalJson } from '../apps/server/src/inbox/trace.js';
import { describeContent, LiveGoogleWorkspaceAdapter } from '../apps/server/src/workspace/adapters.js';
import { WorkspaceRegistry } from '../apps/server/src/workspace/registry.js';
import { verifiedState, type WorkspaceState } from '../apps/server/src/workspace/types.js';
import { extractPhotoDetails } from '../apps/server/src/workspace/photos.js';

type File = { id: string; name: string; mimeType: string; parents: string[]; trashed: boolean; size?: string; md5Checksum?: string };
type Paragraph = { text: string; style: string };

/** In-memory Google Drive / Sheets / Docs REST fake covering exactly the endpoints the live adapter uses. */
function fakeGoogle() {
  const files = new Map<string, File>();
  const sheets = new Map<string, Map<string, unknown[][]>>();
  const docs = new Map<string, Paragraph[]>();
  const calls: Array<{ capability: GoogleCapability; method: string; url: string }> = [];
  let rejectValues = false;
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
      if (segments[3] === 'values:batchUpdate' && method === 'POST') {
        if (rejectValues) { rejectValues = false; return json({ error: { code: 503 } }, 503); }
        expect(body.valueInputOption).toBe('RAW');
        for (const update of body.data) {
          const [, sheet, start] = /^'(.+)'!A(\d+)$/.exec(update.range)!;
          const table = book.get(sheet.replace(/''/g, "'"))!;
          update.values.forEach((values: unknown[], offset: number) => {
            const index = Number(start) - 1 + offset;
            while (table.length <= index) table.push([]);
            for (const [column, value] of values.entries()) if (value !== null) table[index][column] = value;
            while (table[index].at(-1) === '') table[index].pop();
          });
          while (table.at(-1)?.length === 0) table.pop();
        }
        return json({});
      }
      throw new Error('Unexpected Sheets operation: ' + url.pathname);
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
  return { api, files, calls, failNextCellWrite: () => { rejectValues = true; } };
}

it('round-trips Drive folders/files, Sheets (RAW), and Docs through the live Google adapter with exact read-back snapshots', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'siftvane-live-adapter-'));
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

    const siftvane = await write('u/folder:Siftvane', { type: 'drive_folder', name: 'Siftvane', parent: null });
    expect(siftvane.url).toBe('https://drive.google.com/drive/folders/' + siftvane.externalId);
    await write('u/folder:Siftvane/Invoices', { type: 'drive_folder', name: 'Invoices', parent: 'u/folder:Siftvane' });
    // Idempotent: a lost registry entry is recovered by name + parent instead of creating a duplicate folder.
    store.sqlite.prepare("DELETE FROM workspace_artifacts WHERE logical_key='u/folder:Siftvane/Invoices'").run();
    expect(await adapter.read('u/folder:Siftvane/Invoices')).toEqual({ type: 'drive_folder', name: 'Invoices', parent: 'u/folder:Siftvane' });
    await write('u/folder:Siftvane/Invoices', { type: 'drive_folder', name: 'Invoices', parent: 'u/folder:Siftvane' });
    expect([...google.files.values()].filter((file) => file.name === 'Invoices')).toHaveLength(1);

    const text = 'Vendor,Amount\nFigma,45\n';
    const content = describeContent(Buffer.from(text));
    await write('u/file:Siftvane/Invoices/report.csv', { type: 'drive_file', name: 'report.csv', folder: 'u/folder:Siftvane/Invoices', mime: 'text/csv', ...content,
      source: { inline_text: text }, content_scan: { secret: false, injection: false, extracted: true } });

    const sheet: WorkspaceState = { type: 'google_sheet', title: 'Ledger', folder: 'u/folder:Siftvane/Invoices', tabs: [
      { name: 'Daily Invoices', headers: ['Invoice #', 'Amount', 'Notes'], rows: [['FIG-3391', 45, "'=IMPORTXML (\"x\")"]] }] };
    const created = await write('u/sheet:Ledger', sheet);
    expect(created.url).toBe(`https://docs.google.com/spreadsheets/d/${created.externalId}/edit`);
    await write('u/sheet:Ledger', { ...sheet, tabs: [{ ...sheet.tabs[0], rows: [...sheet.tabs[0].rows, ['PC-1207', 318.4, '']] },
      { name: "Vendor's Bills", headers: ['Vendor'], rows: [['Notion']] }] });
    const beforeFailure = await adapter.read('u/sheet:Ledger');
    google.failNextCellWrite();
    await expect(adapter.write('u/sheet:Ledger', beforeFailure, sheet, signal)).rejects.toThrow('GOOGLE_WORKSPACE_503');
    expect(await adapter.read('u/sheet:Ledger')).toEqual(beforeFailure);
    expect(google.calls.some((call) => call.url.endsWith(':clear'))).toBe(false);

    const doc: WorkspaceState = { type: 'google_doc', title: 'Summary', folder: 'u/folder:Siftvane/Invoices',
      sections: [{ heading: 'Daily digest', text: 'Invoices logged: 2\n• Figma · 45.00' }, { heading: 'Flags', text: '' }] };
    await write('u/doc:Summary', doc);
    await write('u/doc:Summary', { ...doc, sections: [{ heading: 'Daily digest', text: 'Invoices logged: 3' }, ...doc.sections.slice(1)] });

    // Rollback removes only artifacts Siftvane created, by the id recorded in its own registry.
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

it('recovers a verified provider ID when a new Sheet fails before its first cells are written', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'siftvane-live-recovery-'));
  const mode = 'live:workspace-test';
  const google = fakeGoogle();
  const accounts = { api: google.api } as unknown as GoogleAccounts;
  const engine = new InboxEngine({ databasePath: ':memory:', tracesDir: dir, stagingDir: dir, live: {
    ready: () => true, modes: () => [mode], reader: async () => [], mutationScope: () => undefined,
    redact: (_mode, value) => value, target: (selected, guard, store) => new SandboxTarget(store, guard, selected),
    workspace: (_selected, guard, registry) => new LiveGoogleWorkspaceAdapter(accounts, 'workspace-test', registry, guard, dir),
  } });
  try {
    const key = 'owner/sheet:Receipt';
    google.failNextCellWrite();
    const run = await engine.mission('workspace-recovery-test', mode, async (context) => {
      await context.execute({ kind: 'workspace', target: key, sourceId: 'fixture', playbook: 'workspace_test',
        version: 'one', confidence: 1, requestedTier: 0, expectedBefore: null,
        after: { type: 'google_sheet', title: 'Receipt', folder: null, tabs: [{ name: 'Rows', headers: ['Order'], rows: [] }] },
        workspaceOwner: { userId: 'owner', agentId: null, runId: context.runId },
      });
    }).done;
    expect(run).toMatchObject({ status: 'FAILED', error: 'GOOGLE_WORKSPACE_503' });
    const [claim] = engine.store.actions(run.id);
    expect(claim).toMatchObject({ status: 'REVIEW_REQUIRED', creationPending: true, providerId: 'g0001' });
    expect(engine.hasRollback(run.id)).toBe(true);
    expect((await engine.rollback(run.id).done).status).toBe('COMPLETED');
    expect(await engine.workspace(mode).read(key)).toBeNull();
    expect(google.files.size).toBe(0);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('uses the Google Photos Picker: no reads before the user picks, then only picked items, downloaded with OAuth from googleusercontent', async () => {
  const store = new InboxStore(':memory:');
  try {
    const registry = new WorkspaceRegistry(store.sqlite);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>Merchant: Night Market</text><text>Total: 12.50 USD</text></svg>');
    let picked = false;
    const calls: Array<{ capability: GoogleCapability; url: string; method: string }> = [];
    const accounts = {
      connection: () => ({ status: 'active', granted_scopes: JSON.stringify(['https://www.googleapis.com/auth/photospicker.mediaitems.readonly']) }),
      api: async (_inbox: string, capability: GoogleCapability, raw: string, _guard: () => void, init: RequestInit = {}) => {
        calls.push({ capability, url: raw, method: init.method ?? 'GET' });
        const url = new URL(raw);
        if (url.hostname === 'lh3.googleusercontent.com') return new Response(svg);
        if (url.pathname === '/v1/sessions') return Response.json({ id: 'sess-1', pickerUri: 'https://photos.google.com/picker/sess-1', expireTime: '2099-01-01T00:00:00Z' });
        if (url.pathname === '/v1/sessions/sess-1') return Response.json({ id: 'sess-1', pickerUri: 'https://photos.google.com/picker/sess-1', mediaItemsSet: picked });
        if (url.pathname === '/v1/mediaItems') {
          expect(url.searchParams.get('sessionId')).toBe('sess-1');
          return Response.json({ mediaItems: [{ id: 'm1', createTime: '2026-12-02T08:00:00Z', type: 'PHOTO',
            mediaFile: { baseUrl: 'https://lh3.googleusercontent.com/pp/m1', mimeType: 'image/svg+xml', filename: 'night.svg' } }] });
        }
        throw new Error('Unexpected endpoint ' + raw);
      },
    } as unknown as GoogleAccounts;
    const adapter = new LiveGoogleWorkspaceAdapter(accounts, 'inbox-1', registry, () => undefined, tmpdir());
    await expect(adapter.searchPhotos({ limit: 5 })).rejects.toThrow('PHOTOS_PICKER_SELECTION_REQUIRED');
    const session = await adapter.startPhotoPicker();
    expect(session).toMatchObject({ session_id: 'sess-1', picker_uri: 'https://photos.google.com/picker/sess-1' });
    expect(await adapter.startPhotoPicker()).toMatchObject({ session_id: 'sess-1' });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(await adapter.photoPickerReady()).toBe(false);
    await expect(adapter.searchPhotos({ limit: 5 })).rejects.toThrow('PHOTOS_PICKER_SELECTION_REQUIRED');

    picked = true;
    expect(await adapter.searchPhotos({ limit: 5 })).toEqual([expect.objectContaining({ id: 'm1', filename: 'night.svg' })]);
    const details = await extractPhotoDetails(adapter, 'm1');
    expect(details).toMatchObject({ extraction: 'image_text_layer', fields: { merchant: 'Night Market', amount: 12.5, currency: 'USD' } });
    const download = calls.find((call) => call.url.startsWith('https://lh3.googleusercontent.com/'))!;
    expect(download).toMatchObject({ capability: 'photos:read', url: 'https://lh3.googleusercontent.com/pp/m1=d' });
    expect(calls.every((call) => call.capability === 'photos:read')).toBe(true);
  } finally {
    store.close();
  }
});
