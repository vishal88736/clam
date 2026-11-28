import type { Snapshot } from '../inbox/contracts.js';

export type ArtifactService = 'drive_folder' | 'drive_file' | 'google_doc' | 'google_sheet' | 'google_photo';
export type Cell = string | number;

export interface SheetTab {
  name: string;
  headers: string[];
  rows: Cell[][];
}

export interface DocSection {
  heading: string;
  text: string;
}

/** Where file bytes come from. Never part of the verified snapshot. */
export type ContentSource = { staged_path: string } | { inline_text: string } | { inline_base64: string };

export type WorkspaceState =
  | { type: 'drive_folder'; name: string; parent: string | null }
  | { type: 'drive_file'; name: string; folder: string | null; mime: string; bytes: number; md5: string; source?: ContentSource;
      content_scan?: { secret: boolean; injection: boolean; extracted: boolean } }
  | { type: 'google_sheet'; title: string; folder: string | null; tabs: SheetTab[] }
  | { type: 'google_doc'; title: string; folder: string | null; sections: DocSection[] };

export interface WriteReceipt {
  externalId: string;
  url: string | null;
}

export interface PhotoItem {
  id: string;
  filename: string;
  mimeType: string;
  category: string | null;
  creationTime: string;
  description: string;
  productUrl: string | null;
}

/** A file in the user's Drive that an agent found (read-only view). */
export interface FoundFile {
  id: string; name: string; kind: 'doc' | 'sheet' | 'pdf' | 'text' | 'folder' | 'file'; mime: string; modified: string | null; url: string | null;
}
export interface FileContent { file: FoundFile; text: string; tabs?: SheetTab[] }

export interface WorkspaceAdapter {
  readonly live: boolean;
  read(key: string): Promise<Snapshot>;
  write(key: string, before: Snapshot, after: WorkspaceState, signal: AbortSignal, onCreated?: (receipt: WriteReceipt) => void): Promise<WriteReceipt>;
  remove(key: string, signal: AbortSignal): Promise<void>;
  /** Current bytes of a Drive file Siftvane manages (null when unavailable or larger than maxBytes). */
  fileContent(key: string, maxBytes: number): Promise<{ mime: string; data: Buffer } | null>;
  searchPhotos(filter: { category?: string; dateFrom?: string; dateTo?: string; limit: number }): Promise<PhotoItem[]>;
  photoBytes(id: string, maxBytes: number): Promise<{ item: PhotoItem; data: Buffer }>;
  /** Live Google Photos Picker: start (or reuse) a session the user completes in Google's UI. */
  startPhotoPicker?(): Promise<{ session_id: string; picker_uri: string; expire_time: string | null }>;
  /** Whether the user finished picking items in the current picker session. */
  photoPickerReady?(): Promise<boolean>;
  /** Finds files in the user's Drive by name/content and type (live: all files with drive.readonly, else Siftvane's own). */
  searchFiles(filter: { query?: string; kind?: FoundFile['kind'] | 'any'; limit: number; namespaces?: string[] }): Promise<FoundFile[]>;
  /** Reads a found file as text (Docs, PDFs, text files) or tabs (Sheets). Never modifies it. */
  readFile(id: string, maxBytes: number): Promise<FileContent | null>;
  /** Content preview of a sandbox artifact (live artifacts are opened through their Google URL). */
  preview?(key: string): Promise<Record<string, unknown> | null>;
}


export function titleOf(state: WorkspaceState) {
  return state.type === 'drive_folder' || state.type === 'drive_file' ? state.name : state.title;
}

/** Snapshot used for read-back verification: content sources are dispatch hints, not provider state. */
export function verifiedState(state: WorkspaceState | Snapshot): Snapshot {
  if (!state) return null;
  const { source: _source, content_scan: _scan, ...rest } = state as Record<string, unknown>;
  if (rest.type === 'google_sheet') {
    rest.tabs = (rest.tabs as SheetTab[]).map((tab) => ({ ...tab, rows: tab.rows.map(trimRow) }));
  }
  if (rest.type === 'google_doc') {
    rest.sections = (rest.sections as DocSection[]).map((section) => ({ heading: section.heading.trim(), text: section.text.trim() }));
  }
  return rest;
}

export function trimRow(row: Cell[]) {
  const copy = [...row];
  while (copy.length && (copy[copy.length - 1] === '' || copy[copy.length - 1] === null || copy[copy.length - 1] === undefined)) copy.pop();
  return copy;
}
