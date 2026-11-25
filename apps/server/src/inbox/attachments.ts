import { spawn } from 'node:child_process';

export type ReaderAttachment = { name: string; mime: string; data: string };
const maxBytes = 750_000;

function pdfText(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('pdftotext', ['-f', '1', '-l', '3', '-', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ATTACHMENT_TIMEOUT'));
    }, 1500);
    let result = '';
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      result += data;
      if (result.length > 24_000) child.kill('SIGKILL');
    });
    child.once('error', reject);
    child.stdin.on('error', () => {});
    child.once('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(result) : reject(new Error('ATTACHMENT_UNREADABLE'));
    });
    child.stdin.end(buffer);
  });
}

const isoPattern = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const utcDate = (text: string) => text.replace(isoPattern, '$1-$2-$3T$4:$5:$6Z');

export async function readAttachments(parts: ReaderAttachment[]) {
  const extracted: string[] = [];
  for (const part of parts.slice(0, 3)) {
    if (part.data.length > maxBytes * 2) throw new Error('ATTACHMENT_TOO_LARGE');
    const bytes = Buffer.from(part.data, 'base64url');
    if (bytes.length > maxBytes) throw new Error('ATTACHMENT_TOO_LARGE');
    if (part.mime === 'application/pdf' || /\.pdf$/i.test(part.name)) {
      extracted.push(await pdfText(bytes));
    } else if (/\.ics$/i.test(part.name) || part.mime === 'text/calendar') {
      const text = bytes.toString('utf8').replace(/\r?\n[ \t]/g, '');
      const start = /^DTSTART[^:\n]*:([^\r\n]+)$/im.exec(text)?.[1];
      const end = /^DTEND[^:\n]*:([^\r\n]+)$/im.exec(text)?.[1];
      const duration = start && end && isoPattern.test(start) && isoPattern.test(end)
        ? (Date.parse(utcDate(end)) - Date.parse(utcDate(start))) / 60_000 : null;
      extracted.push(text, ...(start && duration ? ['Start: ' + utcDate(start), 'Duration: ' + duration] : []));
    } else if (part.mime === 'text/plain') {
      extracted.push(bytes.toString('utf8'));
    }
  }
  return extracted.join('\n').slice(0, 24_000);
}
