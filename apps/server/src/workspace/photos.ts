import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scanOutboundSecrets, scanPromptInjection } from '@siftvane/shared';
import type { WorkspaceAdapter } from './types.js';

const maxPhotoBytes = 2_000_000;
const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/tiff', 'image/bmp', 'image/gif']);

export interface PhotoDetails {
  media_item_id: string;
  filename: string;
  category: string | null;
  created_at: string;
  extraction: 'image_text_layer' | 'ocr' | 'metadata_only';
  /** When the photo was taken (YYYY-MM-DD). */
  date?: string;
  /** The photo's screened text (OCR or text layer), for the AI to read; empty when quarantined or no text was found. */
  text: string;
  content_sha256: string;
  bytes: number;
  trust_level: 'untrusted_external';
  threat_signals: string[];
  quarantined: boolean;
}

/**
 * Bounded OCR in a separate process: no shell, stdin bytes only, 6 s wall clock, 16 KB of output. Returns null when
 * Tesseract is not installed so the parser falls back to metadata instead of failing the mission.
 */
export function ocrImage(bytes: Buffer, binary = process.env.SIFTVANE_TESSERACT_BIN || 'tesseract'): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, ['stdin', 'stdout', '--psm', '6', '-l', 'eng'], { stdio: ['pipe', 'pipe', 'ignore'], env: { OMP_THREAD_LIMIT: '1', PATH: process.env.PATH ?? '' } });
    } catch {
      resolve(null);
      return;
    }
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 6000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 16_000) child.kill('SIGKILL');
    });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.stdin.on('error', () => undefined);
    child.once('close', (code) => { clearTimeout(timer); resolve(code === 0 ? output.slice(0, 16_000) : null); });
    child.stdin.end(bytes);
  });
}

/**
 * Reads a photo's text: bounded bytes in, screened text out. SVG images expose a text layer; raster photos are OCR'd
 * with Tesseract when it is installed. Nothing is assumed about what the photo is: agents pull whatever fields the user
 * asked for out of the text with the AI. Raw image bytes never leave this function, and text that carries prompt
 * injection or secrets is withheld.
 */
export async function extractPhotoDetails(adapter: WorkspaceAdapter, id: string): Promise<PhotoDetails> {
  const { item, data } = await adapter.photoBytes(id, maxPhotoBytes);
  let text = '';
  let extraction: PhotoDetails['extraction'] = 'metadata_only';
  if (item.mimeType === 'image/svg+xml' && !data.includes(0)) {
    const markup = data.toString('utf8').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    text = [...markup.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
      .map((match) => match[1].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim())
      .filter(Boolean).join('\n').slice(0, 4000);
    extraction = 'image_text_layer';
  } else if (rasterTypes.has(item.mimeType.toLowerCase())) {
    const recognized = await ocrImage(data);
    if (recognized?.trim()) {
      text = recognized;
      extraction = 'ocr';
    }
  }
  text = [text, item.description].filter(Boolean).join('\n');
  const signals = scanPromptInjection(text);
  const secret = scanOutboundSecrets(text);
  const quarantined = signals.detected || Boolean(secret);
  return {
    media_item_id: item.id, filename: item.filename, category: item.category, created_at: item.creationTime, extraction,
    date: item.creationTime ? item.creationTime.slice(0, 10) : undefined,
    text: quarantined ? '' : text.slice(0, 4000),
    content_sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.length,
    trust_level: 'untrusted_external',
    threat_signals: [...signals.signals, ...(secret ? ['SECRET_IN_IMAGE_TEXT'] : [])],
    quarantined,
  };
}
