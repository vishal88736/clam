/** Small, task-free helpers for reading mail: the address in a From header, its domain, and visible text from HTML. */

const emailPattern = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
export const address = (value: string) => value.match(emailPattern)?.[0].toLowerCase() ?? '';
export const domain = (value: string) => address(value).split('@')[1] ?? '';

export function stripHtml(html: string): string {
  return html
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/<(script|style|head|template)\b[^>]*>[^]*?<\/\1\s*>/gi, ' ')
    .replace(/<([a-z\d]+)\b[^>]*(?:\bhidden\b|aria-hidden=["']true|display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px)?|opacity\s*:\s*0(?:[; "'>])|color\s*:\s*(?:white|#fff(?:fff)?))[^>]*>[^]*?<\/\1\s*>/gi, ' ')
    .replace(/<(?:br\b[^>]*|\/(?:div|p|li|td|tr))\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#32;/gi, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
}
