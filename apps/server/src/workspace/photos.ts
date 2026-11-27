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
  fields: { merchant?: string; date?: string; amount?: number; currency?: string; due?: string; reference?: string };
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

const iso = (value: string | undefined) => {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  return us ? `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` : undefined;
};
const datePattern = '(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{4})';

/** Parses labelled receipts ("Total: 32.00 USD") and typical OCR output ("TOTAL $32.00", "Pay by 12/20/2026"). */
export function parseReceiptText(text: string) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const labelled = (name: string) => new RegExp('^' + name + '\\s*:\\s*(.+)$', 'im').exec(text)?.[1]?.trim();
  const totalMatch = /\b(?:grand\s+total|total|amount\s+due|amount|fine|balance)\b[^0-9\n$€£]{0,12}([$€£])?\s*([0-9]{1,7}(?:[.,][0-9]{2})?)\s*([A-Z]{3})?/i.exec(text);
  // OCR often garbles the label ("JOTAL"); fall back to the largest currency-marked amount on the receipt.
  const marked = [...text.matchAll(/([$€£])\s*([0-9]{1,7}[.,][0-9]{2})\b/g)].sort((left, right) => Number(right[2].replace(',', '.')) - Number(left[2].replace(',', '.')))[0];
  const amountText = totalMatch?.[2] ?? marked?.[2];
  const symbol = totalMatch?.[1] ?? marked?.[1];
  const currency = totalMatch?.[3]?.toUpperCase() ?? (symbol === '€' ? 'EUR' : symbol === '£' ? 'GBP' : amountText ? 'USD' : undefined);
  const due = iso(new RegExp('\\b(?:pay\\s+by|due(?:\\s+date)?|payment\\s+due)\\b\\s*:?\\s*' + datePattern, 'i').exec(text)?.[1]);
  const anyDate = [...text.matchAll(new RegExp(datePattern, 'g'))].map((match) => iso(match[1])).filter(Boolean) as string[];
  const merchant = labelled('Merchant') ?? lines.find((line) => /[A-Za-z]{3}/.test(line) && !/\b(?:total|date|receipt|invoice|amount|card|tax)\b/i.test(line));
  return {
    merchant: merchant?.replace(/[^\w &'.,-]/g, '').slice(0, 120) || undefined,
    date: iso(labelled('Date')) ?? anyDate.find((value) => value !== due),
    amount: amountText ? Number(amountText.replace(',', '.')) : undefined,
    currency,
    due,
    reference: /\b(?:ticket|receipt|invoice|ref(?:erence)?)\s*(?:#|no\.?|number)?\s*:?\s*([A-Z0-9-]*\d[A-Z0-9-]*)\b/i.exec(text)?.[1]?.toUpperCase().slice(0, 40),
  };
}

/**
 * Plane A photo parser: bounded bytes in, a small typed record out. Raw image bytes and full extracted text
 * never leave this function, so traces, logs, and SSE events only ever carry the structured fields.
 * SVG receipts expose a text layer; raster photos are OCR'd with Tesseract when it is installed.
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
  const parsed: Partial<ReturnType<typeof parseReceiptText>> = quarantined ? {} : parseReceiptText(text);
  return {
    media_item_id: item.id, filename: item.filename, category: item.category, created_at: item.creationTime, extraction,
    fields: { ...parsed, date: quarantined ? undefined : parsed.date ?? (item.creationTime ? item.creationTime.slice(0, 10) : undefined) },
    content_sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.length,
    trust_level: 'untrusted_external',
    threat_signals: [...signals.signals, ...(secret ? ['SECRET_IN_IMAGE_TEXT'] : [])],
    quarantined,
  };
}
