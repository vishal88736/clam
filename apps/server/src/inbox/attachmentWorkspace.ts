import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReaderAttachment } from './attachments.js';

const allowedExtensions: Record<string, string> = {
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/calendar': '.ics',
};

export function safeAttachmentBytes(part: ReaderAttachment) {
  const extension = allowedExtensions[part.mime];
  if (!extension || !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,120}$/.test(part.name) ||
      part.name.includes('..') || path.extname(part.name).toLowerCase() !== extension) {
    throw new Error('ATTACHMENT_TYPE_OR_NAME_BLOCKED');
  }
  if (part.data.length > 1_000_004 || !/^[A-Za-z0-9_-]+={0,2}$/.test(part.data)) throw new Error('ATTACHMENT_INVALID');
  const bytes = Buffer.from(part.data, 'base64url');
  if (bytes.length > 750_000 || (extension === '.pdf' && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) ||
      (extension !== '.pdf' && bytes.includes(0))) throw new Error('ATTACHMENT_INVALID');
  return bytes;
}

export async function stageWorkspaceAttachment(root: string, messageId: string, part: ReaderAttachment, guard: () => void) {
  if (!/^[\w-]{1,160}$/.test(messageId)) throw new Error('ATTACHMENT_PATH_BLOCKED');
  const bytes = safeAttachmentBytes(part);
  guard();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const base = await realpath(root);
  const parent = path.join(base, messageId);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const entry = await lstat(parent);
  if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(parent) !== parent) throw new Error('ATTACHMENT_PATH_BLOCKED');
  const directory = await mkdtemp(path.join(parent, 'staged-'));
  const filename = path.join(directory, part.name);
  try {
    guard();
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    guard();
    return { path: filename, filename: part.name, bytes: bytes.length, mime: part.mime, trust_level: 'untrusted_external' as const };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
