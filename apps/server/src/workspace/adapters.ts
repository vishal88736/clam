import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { GoogleAccounts, GoogleCapability } from '../auth/google.js';
import type { Snapshot } from '../inbox/contracts.js';
import type { InboxStore } from '../inbox/store.js';
import type { SandboxPhoto } from '../sandbox/seed.js';
import { canonicalJson } from '../inbox/trace.js';
import type { WorkspaceRegistry } from './registry.js';
import {
  trimRow, verifiedState, type Cell, type ContentSource, type DocSection, type PhotoItem, type SheetTab,
  type WorkspaceAdapter, type WorkspaceState, type WriteReceipt,
} from './types.js';

export const maxFileBytes = 750_000;
const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest('hex');

/** Resolves file bytes for a Drive upload. Staged paths must stay inside the quarantined staging root. */
export async function loadContent(source: ContentSource | undefined, stagingRoot: string): Promise<Buffer> {
  if (!source) throw new Error('WORKSPACE_CONTENT_MISSING');
  let bytes: Buffer;
  if ('inline_text' in source) bytes = Buffer.from(source.inline_text, 'utf8');
  else if ('inline_base64' in source) bytes = Buffer.from(source.inline_base64, 'base64url');
  else {
    const root = await realpath(stagingRoot).catch(() => { throw new Error('WORKSPACE_STAGING_UNAVAILABLE'); });
    const file = await realpath(source.staged_path).catch(() => { throw new Error('WORKSPACE_STAGED_FILE_MISSING'); });
    if (!file.startsWith(root + path.sep)) throw new Error('WORKSPACE_PATH_BLOCKED');
    bytes = await readFile(file);
  }
  if (bytes.length > maxFileBytes) throw new Error('WORKSPACE_FILE_TOO_LARGE');
  return bytes;
}

export function describeContent(bytes: Buffer) {
  return { bytes: bytes.length, md5: md5(bytes) };
}

/* ----------------------------------------------------------------------------------------------
 * $0 SandboxWorkspaceAdapter — SQLite-backed Drive, Docs, Sheets and a seeded read-only Photos library.
 * -------------------------------------------------------------------------------------------- */
export class SandboxWorkspaceAdapter implements WorkspaceAdapter {
  readonly live = false;

  constructor(private readonly store: InboxStore, private readonly guard: () => void, private readonly stagingRoot: string,
    private readonly mode = 'sandbox') {
    store.sqlite.exec('CREATE TABLE IF NOT EXISTS workspace_sandbox_blobs (key TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL)');
  }

  async read(key: string): Promise<Snapshot> {
    this.guard();
    return verifiedState(this.store.entity(this.mode as 'sandbox', 'workspace', key));
  }

  async write(key: string, before: Snapshot, after: WorkspaceState, signal: AbortSignal): Promise<WriteReceipt> {
    this.guard();
    signal.throwIfAborted();
    const bytes = after.type === 'drive_file' ? await loadContent(after.source, this.stagingRoot) : null;
    if (bytes && after.type === 'drive_file' && md5(bytes) !== after.md5) throw new Error('WORKSPACE_CONTENT_CHANGED');
    this.store.transaction(() => {
      const current = verifiedState(this.store.entity(this.mode as 'sandbox', 'workspace', key));
      if (canonicalJson(current) !== canonicalJson(before)) throw new Error('TARGET_VERSION_CHANGED');
      this.store.setEntity(this.mode as 'sandbox', 'workspace', key, verifiedState(after));
      if (bytes && after.type === 'drive_file') {
        this.store.sqlite.prepare('INSERT INTO workspace_sandbox_blobs VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET mime=excluded.mime, data=excluded.data')
          .run(key, after.mime, bytes);
      }
    });
    return { externalId: 'sbx_' + createHash('sha256').update(key).digest('hex').slice(0, 20), url: null };
  }

  async remove(key: string, signal: AbortSignal) {
    this.guard();
    signal.throwIfAborted();
    this.store.transaction(() => {
      this.store.setEntity(this.mode as 'sandbox', 'workspace', key, null);
      this.store.sqlite.prepare('DELETE FROM workspace_sandbox_blobs WHERE key=?').run(key);
    });
  }

  private photos(): SandboxPhoto[] {
    return this.store.sqlite.prepare('SELECT body FROM sandbox_photos ORDER BY id').all()
      .map((row) => JSON.parse(String(row.body)) as SandboxPhoto);
  }

  private item(photo: SandboxPhoto): PhotoItem {
    return { id: photo.id, filename: photo.filename, mimeType: photo.mimeType, category: photo.category,
      creationTime: photo.creationTime, description: photo.description, productUrl: null };
  }

  async searchPhotos(filter: { category?: string; dateFrom?: string; dateTo?: string; limit: number }) {
    this.guard();
    return this.photos().filter((photo) => (!filter.category || photo.category === filter.category.toUpperCase()) &&
      (!filter.dateFrom || photo.creationTime.slice(0, 10) >= filter.dateFrom) &&
      (!filter.dateTo || photo.creationTime.slice(0, 10) <= filter.dateTo)).slice(0, filter.limit).map((photo) => this.item(photo));
  }

  async photoBytes(id: string, maxBytes: number) {
    this.guard();
    const photo = this.photos().find((entry) => entry.id === id);
    if (!photo) throw new Error('PHOTO_NOT_AVAILABLE');
    const data = Buffer.from(photo.data, 'base64url');
    if (data.length > maxBytes) throw new Error('PHOTO_TOO_LARGE');
    return { item: this.item(photo), data };
  }

  async preview(key: string) {
    const state = this.store.entity(this.mode as 'sandbox', 'workspace', key);
    if (!state) return null;
    if (state.type === 'drive_file') {
      const blob = this.store.sqlite.prepare('SELECT mime, data FROM workspace_sandbox_blobs WHERE key=?').get(key) as
        { mime: string; data: Uint8Array } | undefined;
      const textual = blob && /^(?:text\/|application\/json)/.test(blob.mime);
      return { ...state, text_preview: textual ? Buffer.from(blob.data).toString('utf8').slice(0, 4000) : null,
        pdf_text: null as string | null, blob_available: Boolean(blob) };
    }
    if (state.type === 'drive_folder') {
      const children = this.store.entities<Record<string, unknown>>(this.mode as 'sandbox', 'workspace')
        .filter((entry) => entry && (entry.parent === key || entry.folder === key))
        .map((entry) => ({ type: entry.type, name: entry.name ?? entry.title }));
      return { ...state, children };
    }
    return state;
  }

  blob(key: string) {
    return this.store.sqlite.prepare('SELECT mime, data FROM workspace_sandbox_blobs WHERE key=?').get(key) as
      { mime: string; data: Uint8Array } | undefined;
  }
}

/* ----------------------------------------------------------------------------------------------
 * LiveGoogleWorkspaceAdapter — least-privilege Drive (drive.file), Docs, Sheets (RAW input), Photos (read-only).
 * Every request runs through GoogleAccounts.api: encrypted token vault, scope checks, quota, and kill-switch guard.
 * -------------------------------------------------------------------------------------------- */
type DriveFile = { id: string; name: string; mimeType: string; parents?: string[]; trashed?: boolean; size?: string; md5Checksum?: string };
type DocBody = {
  title: string;
  body: { content: Array<{ endIndex: number; paragraph?: { paragraphStyle?: { namedStyleType?: string }; elements: Array<{ textRun?: { content: string } }> } }> };
};

const folderMime = 'application/vnd.google-apps.folder';
const urls = {
  drive_folder: (id: string) => 'https://drive.google.com/drive/folders/' + id,
  drive_file: (id: string) => 'https://drive.google.com/file/d/' + id + '/view',
  google_sheet: (id: string) => 'https://docs.google.com/spreadsheets/d/' + id + '/edit',
  google_doc: (id: string) => 'https://docs.google.com/document/d/' + id + '/edit',
};

export class LiveGoogleWorkspaceAdapter implements WorkspaceAdapter {
  readonly live = true;

  constructor(private readonly accounts: GoogleAccounts, private readonly inboxId: string, private readonly registry: WorkspaceRegistry,
    private readonly guard: () => void, private readonly stagingRoot: string) {}

  private async call<T>(capability: GoogleCapability, url: string, init: RequestInit = {}, expectJson = true): Promise<T> {
    const response = await this.accounts.api(this.inboxId, capability, url, this.guard, init);
    if (response.status === 404) throw new Error('WORKSPACE_NOT_FOUND');
    if (!response.ok) throw new Error('GOOGLE_WORKSPACE_' + response.status);
    return (expectJson && response.status !== 204 ? await response.json() : undefined) as T;
  }

  private external(key: string | null) {
    return this.registry.externalId(this.inboxId, key);
  }

  async read(key: string): Promise<Snapshot> {
    this.guard();
    const row = this.registry.get(this.inboxId, key);
    let id = row && !row.removed_at ? row.external_id : null;
    if (!id && key.includes('/folder:')) id = await this.findFolder(key);
    if (!id) return null;
    try {
      const meta = await this.call<DriveFile>('drive:write', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) +
        '?fields=id,name,mimeType,parents,trashed,size,md5Checksum');
      if (meta.trashed) return null;
      const folder = this.registry.keyFor(this.inboxId, meta.parents?.[0]);
      if (meta.mimeType === folderMime) return { type: 'drive_folder', name: meta.name, parent: folder };
      if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') return { type: 'google_sheet', title: meta.name, folder, tabs: await this.readTabs(id) };
      if (meta.mimeType === 'application/vnd.google-apps.document') {
        const doc = await this.call<DocBody>('docs:write', 'https://docs.googleapis.com/v1/documents/' + encodeURIComponent(id));
        return { type: 'google_doc', title: doc.title, folder, sections: parseSections(doc) };
      }
      return { type: 'drive_file', name: meta.name, folder, mime: meta.mimeType, bytes: Number(meta.size ?? 0), md5: meta.md5Checksum ?? '' };
    } catch (error) {
      if (error instanceof Error && error.message === 'WORKSPACE_NOT_FOUND') return null;
      throw error;
    }
  }

  /** Idempotent folder lookup by name + parent, limited by drive.file to folders Clam itself created. */
  private async findFolder(key: string) {
    const name = key.split('/').at(-1)!.replace(/^folder:/, '');
    const segments = key.split('/');
    const parentKey = segments.length > 2 ? segments.slice(0, -1).join('/') : null;
    const parent = parentKey ? this.external(parentKey) : 'root';
    if (!parent) return null;
    const query = `name = '${name.replace(/['\\]/g, '\\$&')}' and mimeType = '${folderMime}' and '${parent}' in parents and trashed = false`;
    const list = await this.call<{ files: DriveFile[] }>('drive:write', 'https://www.googleapis.com/drive/v3/files?' +
      new URLSearchParams({ q: query, fields: 'files(id,name)', pageSize: '2', spaces: 'drive' }));
    return list.files?.[0]?.id ?? null;
  }

  private async readTabs(id: string): Promise<SheetTab[]> {
    const meta = await this.call<{ sheets: { properties: { title: string } }[] }>('sheets:write',
      'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(id) + '?fields=sheets.properties.title');
    const titles = meta.sheets.map((sheet) => sheet.properties.title);
    if (!titles.length) return [];
    const query = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE', majorDimension: 'ROWS' });
    for (const title of titles) query.append('ranges', `'${title.replace(/'/g, "''")}'!A1:Z1000`);
    const values = await this.call<{ valueRanges: { values?: Cell[][] }[] }>('sheets:write',
      'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(id) + '/values:batchGet?' + query);
    return titles.map((name, index) => {
      const [headers = [], ...rows] = values.valueRanges[index]?.values ?? [];
      return { name, headers: headers.map(String), rows: rows.map(trimRow) };
    });
  }

  private async move(id: string, folderKey: string | null, signal: AbortSignal) {
    const folder = this.external(folderKey);
    if (!folderKey) return;
    if (!folder) throw new Error('WORKSPACE_PARENT_MISSING');
    const meta = await this.call<DriveFile>('drive:write', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?fields=parents', { signal });
    if (meta.parents?.includes(folder)) return;
    await this.call('drive:write', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?' + new URLSearchParams({
      addParents: folder, removeParents: (meta.parents ?? []).join(','), fields: 'id',
    }), { method: 'PATCH', body: '{}', signal });
  }

  async write(key: string, before: Snapshot, after: WorkspaceState, signal: AbortSignal): Promise<WriteReceipt> {
    this.guard();
    const current = await this.read(key);
    if (canonicalJson(current) !== canonicalJson(before)) throw new Error('TARGET_VERSION_CHANGED');
    let id = this.external(key);
    if (after.type === 'drive_folder') {
      if (!id) id = await this.findFolder(key);
      if (!id) {
        const parent = after.parent ? this.external(after.parent) : null;
        if (after.parent && !parent) throw new Error('WORKSPACE_PARENT_MISSING');
        id = (await this.call<DriveFile>('drive:write', 'https://www.googleapis.com/drive/v3/files?fields=id', {
          method: 'POST', signal, body: JSON.stringify({ name: after.name, mimeType: folderMime, ...(parent ? { parents: [parent] } : {}) }),
        })).id;
      }
      return { externalId: id, url: urls.drive_folder(id) };
    }
    if (after.type === 'drive_file') {
      const bytes = await loadContent(after.source, this.stagingRoot);
      if (md5(bytes) !== after.md5) throw new Error('WORKSPACE_CONTENT_CHANGED');
      const parent = after.folder ? this.external(after.folder) : null;
      if (after.folder && !parent) throw new Error('WORKSPACE_PARENT_MISSING');
      const boundary = 'clam' + md5(Buffer.from(key)).slice(0, 16);
      const metadata = JSON.stringify({ name: after.name, mimeType: after.mime, ...(!id && parent ? { parents: [parent] } : {}) });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${after.mime}\r\n\r\n`),
        bytes, Buffer.from(`\r\n--${boundary}--`),
      ]);
      const url = id ? 'https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(id) + '?uploadType=multipart&fields=id'
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
      id = (await this.call<DriveFile>('drive:write', url, {
        method: id ? 'PATCH' : 'POST', body, signal, headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      })).id;
      return { externalId: id, url: urls.drive_file(id) };
    }
    if (after.type === 'google_sheet') {
      if (!id) {
        id = (await this.call<{ spreadsheetId: string }>('sheets:write', 'https://sheets.googleapis.com/v4/spreadsheets', {
          method: 'POST', signal, body: JSON.stringify({ properties: { title: after.title }, sheets: after.tabs.map((tab) => ({ properties: { title: tab.name } })) }),
        })).spreadsheetId;
        await this.move(id, after.folder, signal);
      }
      const existing = before?.type === 'google_sheet' ? (before.tabs as SheetTab[]) : [];
      const missing = after.tabs.filter((tab) => !existing.some((item) => item.name === tab.name));
      if (before && missing.length) {
        await this.call('sheets:write', 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(id) + ':batchUpdate', {
          method: 'POST', signal, body: JSON.stringify({ requests: missing.map((tab) => ({ addSheet: { properties: { title: tab.name } } })) }),
        });
      }
      for (const tab of after.tabs) {
        const previous = existing.find((item) => item.name === tab.name);
        if (previous && canonicalJson(previous) === canonicalJson({ ...tab, rows: tab.rows.map(trimRow) })) continue;
        const range = `'${tab.name.replace(/'/g, "''")}'!A1:Z1000`;
        await this.call('sheets:write', 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(id) + '/values/' +
          encodeURIComponent(range) + ':clear', { method: 'POST', body: '{}', signal });
        // RAW input: Sheets stores every value literally and never evaluates formulas from untrusted sources.
        await this.call('sheets:write', 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(id) + '/values/' +
          encodeURIComponent(`'${tab.name.replace(/'/g, "''")}'!A1`) + '?valueInputOption=RAW', {
          method: 'PUT', signal, body: JSON.stringify({ majorDimension: 'ROWS', values: [tab.headers, ...tab.rows] }),
        });
      }
      return { externalId: id, url: urls.google_sheet(id) };
    }
    if (!id) {
      id = (await this.call<{ documentId: string }>('docs:write', 'https://docs.googleapis.com/v1/documents', {
        method: 'POST', signal, body: JSON.stringify({ title: after.title }),
      })).documentId;
      await this.move(id, after.folder, signal);
    }
    const doc = await this.call<DocBody>('docs:write', 'https://docs.googleapis.com/v1/documents/' + encodeURIComponent(id), { signal });
    await this.call('docs:write', 'https://docs.googleapis.com/v1/documents/' + encodeURIComponent(id) + ':batchUpdate', {
      method: 'POST', signal, body: JSON.stringify({ requests: rewriteRequests(doc, after.sections) }),
    });
    return { externalId: id, url: urls.google_doc(id) };
  }

  async remove(key: string, signal: AbortSignal) {
    // drive.file only reaches files Clam created; the id comes from Clam's own artifact registry.
    const id = this.external(key);
    if (!id) return;
    await this.call('drive:write', 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id), { method: 'DELETE', signal }, false);
  }

  async searchPhotos(filter: { category?: string; dateFrom?: string; dateTo?: string; limit: number }) {
    const date = (value: string) => ({ year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)), day: Number(value.slice(8, 10)) });
    const filters: Record<string, unknown> = {};
    if (filter.category) filters.contentFilter = { includedContentCategories: [filter.category.toUpperCase()] };
    if (filter.dateFrom || filter.dateTo) {
      filters.dateFilter = { ranges: [{ startDate: date(filter.dateFrom ?? '1970-01-01'), endDate: date(filter.dateTo ?? '2100-12-31') }] };
    }
    const result = await this.call<{ mediaItems?: Array<{ id: string; filename: string; mimeType: string; description?: string; productUrl?: string;
      mediaMetadata?: { creationTime?: string } }> }>('photos:read', 'https://photoslibrary.googleapis.com/v1/mediaItems:search', {
      method: 'POST', body: JSON.stringify({ pageSize: Math.min(filter.limit, 25), ...(Object.keys(filters).length ? { filters } : {}) }),
    });
    return (result.mediaItems ?? []).slice(0, filter.limit).map((item) => ({
      id: item.id, filename: item.filename, mimeType: item.mimeType, category: filter.category?.toUpperCase() ?? null,
      creationTime: item.mediaMetadata?.creationTime ?? '', description: item.description ?? '', productUrl: item.productUrl ?? null,
    }));
  }

  async photoBytes(id: string, maxBytes: number) {
    const item = await this.call<{ id: string; filename: string; mimeType: string; baseUrl: string; description?: string; productUrl?: string;
      mediaMetadata?: { creationTime?: string } }>('photos:read', 'https://photoslibrary.googleapis.com/v1/mediaItems/' + encodeURIComponent(id));
    const source = new URL(item.baseUrl + '=d');
    if (source.protocol !== 'https:' || !/(?:^|\.)googleusercontent\.com$/.test(source.hostname)) throw new Error('PHOTO_SOURCE_BLOCKED');
    this.guard();
    // Base URLs are pre-signed; no OAuth token is sent to the content host.
    const response = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(12_000) });
    if (!response.ok || !response.body) throw new Error('PHOTO_NOT_AVAILABLE');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('PHOTO_TOO_LARGE');
      chunks.push(Buffer.from(chunk));
    }
    return { item: { id: item.id, filename: item.filename, mimeType: item.mimeType, category: null,
      creationTime: item.mediaMetadata?.creationTime ?? '', description: item.description ?? '', productUrl: item.productUrl ?? null },
    data: Buffer.concat(chunks) };
  }
}

export function parseSections(doc: DocBody): DocSection[] {
  const sections: DocSection[] = [];
  for (const block of doc.body.content) {
    if (!block.paragraph) continue;
    const text = block.paragraph.elements.map((element) => element.textRun?.content ?? '').join('').replace(/\n$/, '');
    if (block.paragraph.paragraphStyle?.namedStyleType === 'HEADING_2') sections.push({ heading: text.trim(), text: '' });
    else if (sections.length) sections[sections.length - 1].text += (sections[sections.length - 1].text ? '\n' : '') + text;
  }
  return sections.map((section) => ({ heading: section.heading, text: section.text.trim() }));
}

function rewriteRequests(doc: DocBody, sections: DocSection[]) {
  const end = doc.body.content.at(-1)?.endIndex ?? 1;
  const requests: unknown[] = [];
  if (end > 2) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1 } } });
  let text = '';
  const headings: Array<[number, number]> = [];
  for (const section of sections) {
    const start = 1 + text.length;
    text += section.heading + '\n';
    headings.push([start, 1 + text.length]);
    text += section.text.trim() + '\n';
  }
  if (!text) return requests;
  requests.push({ insertText: { location: { index: 1 }, text } });
  requests.push({ updateParagraphStyle: { range: { startIndex: 1, endIndex: 1 + text.length }, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } });
  for (const [startIndex, endIndex] of headings) {
    requests.push({ updateParagraphStyle: { range: { startIndex, endIndex }, paragraphStyle: { namedStyleType: 'HEADING_2' }, fields: 'namedStyleType' } });
  }
  return requests;
}
