import { createHash } from 'node:crypto';
import { scanOutboundSecrets, scanPromptInjection } from '@clam/shared';
import type { WorkspaceAdapter } from './types.js';

const maxPhotoBytes = 2_000_000;

export interface PhotoDetails {
  media_item_id: string;
  filename: string;
  category: string | null;
  created_at: string;
  extraction: 'image_text_layer' | 'metadata_only';
  fields: { merchant?: string; date?: string; amount?: number; currency?: string; due?: string; reference?: string };
  content_sha256: string;
  bytes: number;
  trust_level: 'untrusted_external';
  threat_signals: string[];
  quarantined: boolean;
}

/**
 * Plane A photo parser: bounded bytes in, a small typed record out. Raw image bytes and full extracted text
 * never leave this function, so traces, logs, and SSE events only ever carry the structured fields.
 * SVG receipts expose a text layer; raster images fall back to provider metadata (no OCR model is bundled).
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
  }
  text = [text, item.description].filter(Boolean).join('\n');
  const signals = scanPromptInjection(text);
  const secret = scanOutboundSecrets(text);
  const quarantined = signals.detected || Boolean(secret);
  const field = (name: RegExp) => quarantined ? undefined : name.exec(text)?.[1]?.trim().slice(0, 120);
  const total = field(/^(?:Total|Amount|Fine)\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)\s*[A-Z]{3}?/im);
  return {
    media_item_id: item.id, filename: item.filename, category: item.category, created_at: item.creationTime, extraction,
    fields: {
      merchant: field(/^Merchant\s*:\s*(.+)$/im),
      date: field(/^Date\s*:\s*(\d{4}-\d{2}-\d{2})$/im) ?? (item.creationTime ? item.creationTime.slice(0, 10) : undefined),
      amount: total ? Number(total) : undefined,
      currency: field(/^(?:Total|Amount|Fine)\s*:\s*[0-9.]+\s*([A-Z]{3})/im) ?? (total ? 'USD' : undefined),
      due: field(/^(?:Pay by|Due)\s*:\s*(\d{4}-\d{2}-\d{2})$/im),
      reference: field(/^(?:Ticket|Receipt|Invoice)\s*(?:#|No\.?)?\s*:\s*([A-Z0-9-]{2,40})$/im),
    },
    content_sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.length,
    trust_level: 'untrusted_external',
    threat_signals: [...signals.signals, ...(secret ? ['SECRET_IN_IMAGE_TEXT'] : [])],
    quarantined,
  };
}
