import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SafeAction } from '../inbox/contracts.js';
import type { InboxEngine, MissionContext, MissionOutcome } from '../inbox/engine.js';
import { address } from '../inbox/reader.js';
import { canonicalJson, sha256 } from '../inbox/trace.js';
import { sanitizeCell } from '../workspace/sanitize.js';
import { describeStep, genericProgramSchema, genericStepScopes, opService, type GenericStep } from './generic.js';
import { fieldFor, key, lookup, money, ProgramExecutor, type Row, type Value } from './programExecutor.js';
import type { MissionRunner } from './runner.js';
import type { AgentRecord, PlatformService, SourceCli } from './service.js';
import { WorkspaceOps } from './workspaceOps.js';
import type { mcpScopes } from '../auth/google.js';

type McpScope = (typeof mcpScopes)[number];

/*
 * Saved recipes ("muscle memory"). An agent that did a job right is turned into a recipe by code, not by a model:
 * its verified program is kept, every argument is traced to where it comes from (the email, an earlier step, a
 * fixed value, a formula, or a built-in), and anything that cannot be proven becomes a question for the user.
 * Rules decide per email whether to run, ask for approval (the engine's Tier 2 gate), skip, or hand the email to
 * an LLM agent. Recipes run as ordinary engine missions, so policy, taint firewall, read-back verification, the
 * kill switch, and the hash-chained trace all still apply — but with zero model calls.
 */

const fieldName = z.string().trim().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9_ ]*$/);
export const recipeRuleSchema = z.object({
  field: fieldName,
  op: z.enum(['>', '>=', '<', '<=', '=', '!=', 'contains', 'missing']),
  value: z.string().trim().max(80).default(''),
  then: z.enum(['approve', 'skip', 'agent']),
}).strict();
export const recipeComputedSchema = z.object({ name: fieldName, expr: z.string().trim().max(200) }).strict();
export type RecipeRule = z.infer<typeof recipeRuleSchema>;
export type RecipeComputed = z.infer<typeof recipeComputedSchema>;
export type Provenance = 'request' | 'step' | 'constant' | 'formula' | 'builtin' | 'ask';
export type RecipeStatus = 'draft' | 'enabled' | 'paused' | 'archived';
type Decision = 'run' | 'approve' | 'skip' | 'agent';

export interface Binding { step: string; arg: string; kind: Provenance; detail: string; field?: string; name?: string }

interface Baseline { runs: number; avg_tokens: number | null; avg_ms: number | null; model: string | null; planner: string }
interface RecipeSpec {
  program: GenericStep[];
  trigger: string;
  computed: RecipeComputed[];
  rules: RecipeRule[];
  observed_fields: string[];
  handled_by_agent: string[];
  mcp_scopes?: McpScope[];
  source_cli: SourceCli;
  baseline: Baseline;
}
interface BacktestRow {
  message_id: string; date: string; from: string; subject: string; decision: Decision | 'filtered'; reason: string;
  actions: string[]; agent_handled: boolean;
}
interface Backtest {
  version: number; at: string; run_id: string; duration_ms: number; per_email_ms: number; tokens: number;
  counts: Record<Decision | 'filtered', number>; agreement: { agent_handled: number; agree: number; rate: number | null };
  rows: BacktestRow[];
}
interface RecipeStats { runs: number; handled: number; held: number; escalated: number; skipped: number; total_ms: number; last_ms: number | null; tokens: number }
interface RecipeRow {
  id: string; user_id: string; inbox_id: string; source_agent_id: string; name: string; goal_prompt: string; status: RecipeStatus;
  version: number; spec: RecipeSpec; backtest: Backtest | null; stats: RecipeStats; interval_seconds: number;
  next_run_at: string | null; last_run_at: string | null; created_at: string; updated_at: string;
}
export interface RecipeItem {
  recipe_id: string; message_id: string; status: 'done' | 'awaiting_approval' | 'declined' | 'escalated' | 'skipped';
  reason: string; summary: string; approval_id: string | null; run_id: string | null; agent_id: string | null; created_at: string; updated_at: string;
}

const now = () => new Date().toISOString();
const builtins = new Set(['count', 'date', 'summary', 'rows']);
const placeholders = (template: string) => [...template.matchAll(/\{\{\s*([a-zA-Z_ ]{1,40})\s*\}\}/g)].map((match) => key(match[1]));
const emptyStats = (): RecipeStats => ({ runs: 0, handled: 0, held: 0, escalated: 0, skipped: 0, total_ms: 0, last_ms: null, tokens: 0 });

/* ------------------------------------------------ Formulas ------------------------------------------------ */

type Node = { type: 'number'; value: number } | { type: 'field'; name: string } | { type: 'text'; value: string } |
  { type: 'binary'; op: string; left: Node; right: Node } | { type: 'negate'; value: Node } | { type: 'call'; name: string; args: Node[] };
const functions: Record<string, (...args: number[]) => number> = {
  round: (value, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits,
  min: Math.min, max: Math.max, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
};

/** Parses a tiny, side-effect-free formula language: numbers, field names, + - * / %, parentheses, and round/min/max/abs/floor/ceil. */
export function parseFormula(source: string): Node {
  const text = source.trim();
  if (!text) return { type: 'text', value: '' };
  const quoted = /^"([^"\\]{0,120})"$/.exec(text);
  if (quoted) return { type: 'text', value: quoted[1] };
  const tokens = text.match(/\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/%(),]|\S/g) ?? [];
  let index = 0;
  const peek = () => tokens[index];
  const take = (expected?: string) => {
    const token = tokens[index++];
    if (token === undefined || (expected && token !== expected)) throw new Error('RECIPE_FORMULA_INVALID');
    return token;
  };
  const primary = (): Node => {
    const token = take();
    if (token === '(') { const inner = sum(); take(')'); return inner; }
    if (token === '-') return { type: 'negate', value: primary() };
    if (/^\d/.test(token)) return { type: 'number', value: Number(token) };
    if (/^[A-Za-z_]/.test(token)) {
      if (peek() !== '(') return { type: 'field', name: key(token) };
      if (!Object.hasOwn(functions, token.toLowerCase())) throw new Error('RECIPE_FORMULA_INVALID');
      take('(');
      const args: Node[] = [];
      if (peek() !== ')') { args.push(sum()); while (peek() === ',') { take(','); args.push(sum()); } }
      take(')');
      return { type: 'call', name: token.toLowerCase(), args };
    }
    throw new Error('RECIPE_FORMULA_INVALID');
  };
  const product = (): Node => {
    let node = primary();
    while (['*', '/', '%'].includes(peek())) { const op = take(); node = { type: 'binary', op, left: node, right: primary() }; }
    return node;
  };
  const sum = (): Node => {
    let node = product();
    while (['+', '-'].includes(peek())) { const op = take(); node = { type: 'binary', op, left: node, right: product() }; }
    return node;
  };
  if (tokens.length > 60) throw new Error('RECIPE_FORMULA_INVALID');
  const tree = sum();
  if (index !== tokens.length) throw new Error('RECIPE_FORMULA_INVALID');
  return tree;
}

const formulaFields = (node: Node): string[] => node.type === 'field' ? [node.name] : node.type === 'binary' ? [...formulaFields(node.left), ...formulaFields(node.right)] :
  node.type === 'negate' ? formulaFields(node.value) : node.type === 'call' ? node.args.flatMap(formulaFields) : [];

const numeric = (value: Value | undefined): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const parsed = value ? money(String(value).replace(/,/g, '')) : undefined;
  return parsed === undefined ? undefined : Number(parsed);
};

/** Evaluates a formula against a row; returns undefined when a field it needs is missing (the recipe then asks). */
export function evaluateFormula(node: Node, row: Row): Value | undefined {
  const value = (current: Node): number | undefined => {
    switch (current.type) {
      case 'number': return current.value;
      case 'text': return undefined;
      case 'field': return numeric(lookup(row, current.name));
      case 'negate': { const inner = value(current.value); return inner === undefined ? undefined : -inner; }
      case 'call': {
        const args = current.args.map(value);
        return args.some((arg) => arg === undefined) ? undefined : functions[current.name](...args as number[]);
      }
      case 'binary': {
        const left = value(current.left);
        const right = value(current.right);
        if (left === undefined || right === undefined) return undefined;
        if ((current.op === '/' || current.op === '%') && right === 0) return undefined;
        const result = current.op === '+' ? left + right : current.op === '-' ? left - right : current.op === '*' ? left * right :
          current.op === '/' ? left / right : left % right;
        return Number.isFinite(result) ? Math.round(result * 1e6) / 1e6 : undefined;
      }
    }
  };
  if (node.type === 'text') return node.value;
  return value(node);
}

/* ------------------------------------------------ Provenance ------------------------------------------------ */

/**
 * Traces every argument of every step to its source. Field references must resolve against fields the trigger
 * actually produced on real mail (or a formula the user defined); anything else is an open question ("ask").
 */
export function analyzeBindings(program: GenericStep[], triggerId: string, observed: string[], computed: RecipeComputed[]): Binding[] {
  const computedNames = new Map(computed.map((entry) => [key(entry.name), entry.expr]));
  const fields = [...observed, ...computedNames.keys()];
  const savesAttachments = program.some((step) => step.op === 'drive.save_attachments');
  const bindings: Binding[] = [];
  const reference = (step: string, arg: string, name: string, label = name): Binding => {
    const id = key(name);
    if (computedNames.has(id)) {
      const expr = computedNames.get(id)!;
      return { step, arg, kind: 'formula', name: id, detail: expr === '""' || expr === '' ? `${label} is left blank` : `${label} = ${expr}` };
    }
    if (['drive_link', 'link'].includes(id) && savesAttachments) return { step, arg, kind: 'step', name: id, detail: `${label}: Drive link of the saved attachment` };
    const field = fieldFor(fields, name);
    return field ? { step, arg, kind: 'request', name: id, field, detail: field === id ? label : `${label} ← email "${field}"` }
      : { step, arg, kind: 'ask', name: id, detail: `Where does "${label}" come from?` };
  };
  const template = (step: string, arg: string, value: string | undefined) => {
    if (value === undefined) return;
    const names = [...new Set(placeholders(value))];
    if (!names.length) { bindings.push({ step, arg, kind: 'constant', detail: value.length > 70 ? value.slice(0, 69) + '…' : value || '(empty)' }); return; }
    for (const name of names) {
      if (builtins.has(name)) bindings.push({ step, arg, kind: 'builtin', name, detail: `{{${name}}} is filled in by the recipe` });
      else bindings.push(reference(step, arg, name, `{{${name}}}`));
    }
  };
  const from = (step: GenericStep) => {
    if ('from' in step && step.from) bindings.push({ step: step.id, arg: 'from', kind: 'step', detail: step.from === triggerId ? 'the matching emails' : `rows from step "${step.from}"` });
  };
  for (const step of program) {
    if (step.id === triggerId) continue;
    from(step);
    switch (step.op) {
      case 'mail.search': bindings.push({ step: step.id, arg: 'search', kind: 'constant', detail: describeStep(step) }); break;
      case 'photos.extract': bindings.push({ step: step.id, arg: 'category', kind: 'constant', detail: step.category }); break;
      case 'filter':
        bindings.push(reference(step.id, 'field', step.field));
        bindings.push({ step: step.id, arg: 'test', kind: 'constant', detail: step.contains ? `contains "${step.contains}"` : step.exists === false ? 'is empty' : 'is present' });
        break;
      case 'summarize': template(step.id, 'heading', step.heading); break;
      case 'drive.folder': bindings.push({ step: step.id, arg: 'path', kind: 'constant', detail: step.path.join(' / ') }); break;
      case 'drive.find': case 'drive.read': case 'sheets.read':
        bindings.push({ step: step.id, arg: 'source', kind: 'constant', detail: describeStep(step) }); break;
      case 'drive.save_attachments':
        bindings.push({ step: step.id, arg: 'files', kind: 'request', field: 'attachments', detail: 'its attachments' });
        bindings.push({ step: step.id, arg: 'folder', kind: 'constant', detail: step.folder.join(' / ') });
        break;
      case 'drive.save_text':
        bindings.push({ step: step.id, arg: 'file', kind: 'constant', detail: `${step.folder.join(' / ')} / ${step.name}` });
        template(step.id, 'content', step.content);
        break;
      case 'sheets.append':
        bindings.push({ step: step.id, arg: 'sheet', kind: 'constant', detail: `"${step.title}" › ${step.tab}` });
        for (const column of step.columns) {
          if (['source_id', 'message_id'].includes(key(column))) bindings.push({ step: step.id, arg: 'column', kind: 'request', field: 'message_id', name: key(column), detail: `${column} (email id)` });
          else bindings.push(reference(step.id, 'column', column));
        }
        break;
      case 'docs.write':
        bindings.push({ step: step.id, arg: 'doc', kind: 'constant', detail: `"${step.title}" (${step.mode === 'append' ? 'append' : 'replace section'})` });
        template(step.id, 'heading', step.heading);
        template(step.id, 'content', step.content);
        break;
      case 'calendar.reminders':
        bindings.push(reference(step.id, 'date', step.date_field));
        template(step.id, 'title', step.title);
        break;
      case 'mail.label': bindings.push({ step: step.id, arg: 'label', kind: 'constant', detail: step.label }); break;
      case 'mail.draft_replies':
        bindings.push({ step: step.id, arg: 'to', kind: 'request', field: 'from', detail: 'reply to its sender' });
        template(step.id, 'subject', step.subject);
        template(step.id, 'body', step.body);
        break;
      case 'mail.send':
        bindings.push({ step: step.id, arg: 'to', kind: 'constant', detail: step.to.join(', ') + ' (typed by you)' });
        template(step.id, 'subject', step.subject);
        template(step.id, 'body', step.body);
        break;
    }
  }
  return bindings;
}

const ruleText = (rule: RecipeRule) => `${rule.field} ${rule.op === 'missing' ? 'is missing' : rule.op + ' ' + rule.value}`;
const thenText: Record<RecipeRule['then'], string> = { approve: 'ask me first', skip: 'skip it', agent: 'hand it to an agent' };

/** Applies formulas and rules to one email. The first matching rule wins; a rule that cannot be evaluated asks. */
export function decide(spec: Pick<RecipeSpec, 'computed' | 'rules'>, row: Row): { decision: Decision; reason: string; rule?: RecipeRule } {
  for (const entry of spec.computed) {
    const result = evaluateFormula(parseFormula(entry.expr), row);
    if (result === undefined) return { decision: 'agent', reason: `Could not work out ${entry.name} (${entry.expr}) from this email` };
    row.fields[key(entry.name)] = result;
  }
  for (const rule of spec.rules) {
    const raw = lookup(row, rule.field);
    const present = raw !== '' && raw !== undefined;
    if (rule.op === 'missing') {
      if (!present) return { decision: rule.then, reason: `${rule.field} is missing → ${thenText[rule.then]}`, rule };
      continue;
    }
    if (!present) return { decision: 'agent', reason: `Rule "${ruleText(rule)}" needs ${rule.field}, but this email has none` };
    let matched: boolean;
    if (['>', '>=', '<', '<='].includes(rule.op)) {
      const left = numeric(raw);
      const right = Number(rule.value);
      if (left === undefined || !Number.isFinite(right)) return { decision: 'agent', reason: `Rule "${ruleText(rule)}" could not read a number from ${rule.field}` };
      matched = rule.op === '>' ? left > right : rule.op === '>=' ? left >= right : rule.op === '<' ? left < right : left <= right;
    } else if (rule.op === 'contains') matched = String(raw).toLowerCase().includes(rule.value.toLowerCase());
    else {
      const left = numeric(raw);
      const right = Number(rule.value);
      const same = left !== undefined && rule.value !== '' && Number.isFinite(right) ? left === right : String(raw).trim().toLowerCase() === rule.value.toLowerCase();
      matched = rule.op === '=' ? same : !same;
    }
    if (matched) return { decision: rule.then, reason: `${ruleText(rule)} (${String(raw).slice(0, 40)}) → ${thenText[rule.then]}`, rule };
  }
  return { decision: 'run', reason: 'Matches the recipe' };
}

/** What the recipe would do for one email, in plain words (used by the backtest). */
function previewActions(program: GenericStep[], triggerId: string, row: Row): { actions: string[]; filtered: string | null } {
  const alive = new Map<string, boolean>([[triggerId, true]]);
  const actions: string[] = [];
  let filtered: string | null = null;
  const render = (value: string) => value.replace(/\{\{\s*([a-zA-Z_ ]{1,40})\s*\}\}/g, (_match, raw: string) => {
    const name = key(raw);
    return name === 'summary' ? '[summary]' : name === 'count' ? '[count]' : name === 'rows' ? '[list]' : name === 'date' ? '[today]' : String(lookup(row, name) ?? '');
  });
  for (const step of program) {
    if (step.id === triggerId) continue;
    const source = 'from' in step && step.from ? alive.get(step.from) ?? false : true;
    alive.set(step.id, source);
    if (!source) continue;
    switch (step.op) {
      case 'filter': {
        const value = String(lookup(row, step.field) ?? '');
        const keep = step.contains ? value.toLowerCase().includes(step.contains.toLowerCase()) : step.exists === false ? !value : Boolean(value);
        alive.set(step.id, keep);
        if (!keep) filtered ??= `Left out by step "${step.id}" (${describeStep(step)})`;
        break;
      }
      case 'summarize': actions.push('Included in the summary'); break;
      case 'drive.folder': actions.push(`Drive folder ${step.path.join(' / ')}`); break;
      case 'drive.find': case 'drive.read': case 'sheets.read': actions.push(describeStep(step)); break;
      case 'drive.save_attachments': actions.push(`Save ${Number(row.fields.attachments ?? 0)} attachment(s) to ${step.folder.join(' / ')}`); break;
      case 'drive.save_text': actions.push(`Write ${step.name}`); break;
      case 'sheets.append': actions.push(`Row in "${step.title}": ${step.columns.filter((column) => !['source_id', 'message_id'].includes(key(column)))
        .map((column) => `${column} = ${String(sanitizeCell(lookup(row, column) ?? '').value).slice(0, 40) || '—'}`).join(', ')}`); break;
      case 'docs.write': actions.push(`Update doc "${step.title}"`); break;
      case 'calendar.reminders': {
        const date = /^(\d{4}-\d{2}-\d{2})/.exec(String(lookup(row, step.date_field) ?? ''))?.[1];
        actions.push(date ? `Reminder "${render(step.title).slice(0, 60)}" on ${date}` : `No reminder (no ${step.date_field})`);
        break;
      }
      case 'mail.label': actions.push(`Label ${step.label}`); break;
      case 'mail.draft_replies': actions.push(`Draft "${render(step.subject).slice(0, 60)}" to ${row.fields.from} (you approve it)`); break;
      case 'mail.send': actions.push(`Included in the email to ${step.to.join(', ')}`); break;
      case 'mail.search': case 'photos.extract': actions.push(describeStep(step)); break;
    }
  }
  return { actions, filtered };
}

/* ------------------------------------------------ Service ------------------------------------------------ */

export class RecipeService {
  private readonly escalating = new Set<string>();

  constructor(private readonly engine: InboxEngine, private readonly platform: PlatformService, private readonly missions: MissionRunner) {}

  private get db() { return this.engine.store.sqlite; }

  private decode(row: Record<string, unknown>): RecipeRow {
    const { spec_json, backtest_json, stats_json, ...rest } = row;
    return { ...(rest as unknown as Omit<RecipeRow, 'spec' | 'backtest' | 'stats'>), spec: JSON.parse(String(spec_json)) as RecipeSpec,
      backtest: backtest_json ? JSON.parse(String(backtest_json)) as Backtest : null, stats: { ...emptyStats(), ...JSON.parse(String(stats_json)) } };
  }

  private recipe(id: string) {
    const row = this.db.prepare('SELECT * FROM agent_recipes WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? this.decode(row) : null;
  }

  private owned(userId: string, id: string) {
    const recipe = this.recipe(id);
    if (!recipe || recipe.user_id !== userId || recipe.status === 'archived') throw new Error('RECIPE_NOT_AVAILABLE');
    return recipe;
  }

  private publish(recipe: Pick<RecipeRow, 'id' | 'user_id'>) {
    this.platform.publish({ type: 'recipe.updated', user_id: recipe.user_id, data: { id: recipe.id } });
  }

  private save(id: string, patch: Partial<Pick<RecipeRow, 'name' | 'status' | 'version' | 'spec' | 'backtest' | 'stats' | 'next_run_at' | 'last_run_at' | 'interval_seconds'>>) {
    const current = this.recipe(id);
    if (!current) throw new Error('RECIPE_NOT_AVAILABLE');
    const next = { ...current, ...patch, updated_at: now() };
    this.db.prepare(`UPDATE agent_recipes SET name=?, status=?, version=?, spec_json=?, backtest_json=?, stats_json=?, next_run_at=?, last_run_at=?,
      interval_seconds=?, updated_at=? WHERE id=?`).run(next.name, next.status, next.version, JSON.stringify(next.spec),
      next.backtest ? JSON.stringify(next.backtest) : null, JSON.stringify(next.stats), next.next_run_at, next.last_run_at, next.interval_seconds, next.updated_at, id);
    this.publish(next);
    return next;
  }

  item(recipeId: string, messageId: string) {
    return this.db.prepare('SELECT * FROM recipe_items WHERE recipe_id=? AND message_id=?').get(recipeId, messageId) as RecipeItem | undefined;
  }

  private setItem(recipeId: string, messageId: string, patch: Pick<RecipeItem, 'status' | 'reason'> & Partial<Pick<RecipeItem, 'summary' | 'approval_id' | 'run_id' | 'agent_id'>>) {
    const at = now();
    const current = this.item(recipeId, messageId);
    this.db.prepare(`INSERT INTO recipe_items (recipe_id,message_id,status,reason,summary,approval_id,run_id,agent_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(recipe_id,message_id) DO UPDATE SET status=excluded.status, reason=excluded.reason,
      summary=excluded.summary, approval_id=excluded.approval_id, run_id=excluded.run_id, agent_id=excluded.agent_id, updated_at=excluded.updated_at`)
      .run(recipeId, messageId, patch.status, patch.reason.slice(0, 300), (patch.summary ?? current?.summary ?? '').slice(0, 200),
        patch.approval_id !== undefined ? patch.approval_id : current?.approval_id ?? null, patch.run_id !== undefined ? patch.run_id : current?.run_id ?? null,
        patch.agent_id !== undefined ? patch.agent_id : current?.agent_id ?? null, current?.created_at ?? at, at);
  }

  items(recipeId: string, limit = 100) {
    return this.db.prepare('SELECT * FROM recipe_items WHERE recipe_id=? ORDER BY updated_at DESC LIMIT ?').all(recipeId, limit) as unknown as RecipeItem[];
  }

  runs(recipeId: string, limit = 20) {
    return this.db.prepare('SELECT * FROM recipe_runs WHERE recipe_id=? ORDER BY created_at DESC LIMIT ?').all(recipeId, limit) as Record<string, unknown>[];
  }

  toolName(recipe: Pick<RecipeRow, 'id' | 'name'>) {
    const slug = recipe.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'recipe';
    return `recipe_${slug}_${recipe.id.slice(0, 4)}`;
  }

  /** Scopes an MCP token needs to run this recipe (never more than the agent it was learned from). */
  scopes(recipe: Pick<RecipeRow, 'spec'>) {
    return [...new Set(recipe.spec.program.flatMap(genericStepScopes))];
  }

  view(recipe: RecipeRow) {
    const { spec } = recipe;
    const bindings = analyzeBindings(spec.program, spec.trigger, spec.observed_fields, spec.computed);
    const asks = bindings.filter((binding) => binding.kind === 'ask');
    const trigger = spec.program.find((step) => step.id === spec.trigger)!;
    const backtestCurrent = Boolean(recipe.backtest && recipe.backtest.version === recipe.version);
    const blockers = [...(asks.length ? [`Answer ${asks.length} open question${asks.length > 1 ? 's' : ''}`] : []),
      ...(!backtestCurrent ? ['Run a backtest on this version'] : [])];
    const counts = Object.fromEntries((this.db.prepare('SELECT status, count(*) AS n FROM recipe_items WHERE recipe_id=? GROUP BY status').all(recipe.id) as
      { status: string; n: number }[]).map((row) => [row.status, Number(row.n)]));
    const source = this.platform.agent(recipe.source_agent_id);
    return {
      id: recipe.id, name: recipe.name, goal_prompt: recipe.goal_prompt, status: recipe.status, version: recipe.version, mode: recipe.inbox_id === 'sandbox' ? 'sandbox' : 'live',
      source_agent: { id: recipe.source_agent_id, name: source?.name ?? 'Agent' },
      trigger: { step: trigger.id, description: describeStep(trigger), search: trigger },
      steps: spec.program.filter((step) => step.id !== spec.trigger).map((step) => ({
        id: step.id, op: step.op, service: opService[step.op], label: describeStep(step),
        tier2: step.op === 'mail.draft_replies' || step.op === 'mail.send',
        bindings: bindings.filter((binding) => binding.step === step.id),
      })),
      computed: spec.computed, rules: spec.rules, observed_fields: spec.observed_fields.filter((field) => !['thread_id'].includes(field)),
      asks, ready: !blockers.length, blockers, backtest: recipe.backtest, backtest_current: backtestCurrent,
      stats: recipe.stats, baseline: spec.baseline, item_counts: counts, interval_seconds: recipe.interval_seconds,
      next_run_at: recipe.next_run_at, last_run_at: recipe.last_run_at, created_at: recipe.created_at, updated_at: recipe.updated_at,
      tool_name: this.toolName(recipe), required_scopes: this.scopes(recipe),
    };
  }

  list(userId: string) {
    return (this.db.prepare("SELECT * FROM agent_recipes WHERE user_id=? AND status<>'archived' ORDER BY created_at DESC").all(userId) as Record<string, unknown>[])
      .map((row) => this.view(this.decode(row)));
  }

  enabledFor(userId: string, inboxId: string) {
    return (this.db.prepare("SELECT * FROM agent_recipes WHERE user_id=? AND inbox_id=? AND status='enabled' ORDER BY created_at LIMIT 20").all(userId, inboxId) as
      Record<string, unknown>[]).map((row) => this.decode(row));
  }

  detail(userId: string, id: string) {
    const recipe = this.owned(userId, id);
    return { recipe: this.view(recipe), items: this.items(id), runs: this.runs(id) };
  }

  /** Agents a recipe can be learned from, with the reason when one cannot. */
  learnable(userId: string) {
    return this.platform.agents(userId).filter((agent) => !agent.state.interactive && agent.status !== 'archived').map((agent) => {
      const program = agent.workflow_plan.params.program;
      const reason = agent.workflow_plan.template !== 'generic' || !program ? 'Only agents with a step-by-step plan can be taught as recipes.' :
        program[0]?.op !== 'mail.search' ? 'Recipes start from incoming email; this agent starts from photos or Drive files.' :
        program.some((step) => step.op === 'extract' || step.op === 'classify' || step.op === 'mail.search' && step.about) ?
          'This agent relies on AI reading (extract/classify); a recipe runs with zero model calls, so it cannot repeat that exactly.' :
        !agent.state.last_run_id ? 'Let the agent finish one run first.' :
        this.engine.store.run(agent.state.last_run_id)?.status !== 'COMPLETED' ? 'The last run did not complete; fix it before teaching.' : null;
      return { agent_id: agent.id, name: agent.name, ready: !reason, reason };
    });
  }

  private baseline(agent: AgentRecord): Baseline {
    const runs = (this.db.prepare("SELECT body FROM inbox_runs WHERE json_extract(body,'$.trigger')=? AND json_extract(body,'$.status')='COMPLETED' ORDER BY rowid DESC LIMIT 20")
      .all('agent:' + agent.id) as { body: string }[]).map((row) => JSON.parse(row.body) as { startedAt: string; completedAt: string; tokens?: number; model_usage?: { model?: string } });
    const timed = runs.filter((run) => run.completedAt);
    return {
      runs: runs.length, planner: agent.workflow_plan.planner,
      avg_tokens: runs.length ? Math.round(runs.reduce((sum, run) => sum + (run.tokens ?? 0), 0) / runs.length) : null,
      avg_ms: timed.length ? Math.round(timed.reduce((sum, run) => sum + Date.parse(run.completedAt) - Date.parse(run.startedAt), 0) / timed.length) : null,
      model: runs.find((run) => run.model_usage?.model)?.model_usage?.model ?? null,
    };
  }

  /** Runs one read-only mission (traced, kill-switch guarded) as the source agent. */
  private async readOnly<T>(trigger: string, agent: AgentRecord, work: (executor: ProgramExecutor, context: MissionContext) => Promise<T>) {
    return this.missions.exclusive(async () => {
      let result: T | undefined;
      const mode = agent.inbox_id === 'sandbox' ? 'sandbox' as const : `live:${agent.inbox_id}` as const;
      const handle = this.engine.mission(trigger, mode, async (context) => {
        const ops = new WorkspaceOps(context, this.engine.workspace(mode), this.platform,
          { userId: agent.user_id, agentId: agent.id, inboxId: agent.inbox_id }, this.engine.stagingRoot());
        result = await work(new ProgramExecutor(this.engine, this.platform, agent, context, ops, { review: false }), context);
      });
      const run = await handle.done;
      if (run.status !== 'COMPLETED') throw new Error(run.error ?? 'RECIPE_READ_FAILED');
      return { result: result as T, run };
    });
  }

  /** Learns a recipe from an agent's verified program. Code, not a model, does the compiling. */
  async learn(userId: string, agentId: string, name?: string) {
    const agent = this.platform.ownedAgent(userId, agentId);
    const eligibility = this.learnable(userId).find((entry) => entry.agent_id === agentId);
    if (!eligibility?.ready) throw new Error(eligibility?.reason ? 'RECIPE_AGENT_NOT_READY' : 'AGENT_NOT_AVAILABLE');
    const program = genericProgramSchema.parse(agent.workflow_plan.params.program);
    const trigger = program[0] as Extract<GenericStep, { op: 'mail.search' }>;
    // Observe real mail through the same search the agent used, so every field reference is proven against data.
    const { result: rows } = await this.readOnly('recipe:learn:' + agent.id, agent, (executor) => executor.searchRows(trigger));
    const observed = [...new Set([...rows.flatMap((row) => Object.keys(row.fields)), ...agent.state.observed?.fields ?? []])].sort();
    const handled = agent.state.observed?.message_ids ?? [];
    const spec: RecipeSpec = {
      program, trigger: trigger.id, computed: [], handled_by_agent: handled, observed_fields: observed,
      // Safe default: an email whose sender could not be authenticated (look-alike domains, spoofed invoices) asks first.
      rules: observed.includes('sender_verified') ? [{ field: 'sender_verified', op: '=', value: 'no', then: 'approve' }] : [],
      mcp_scopes: agent.workflow_plan.params.mcp_scopes, source_cli: agent.source_cli, baseline: this.baseline(agent),
    };
    const id = randomUUID();
    const at = now();
    this.db.prepare(`INSERT INTO agent_recipes (id,user_id,inbox_id,source_agent_id,name,goal_prompt,status,version,spec_json,stats_json,interval_seconds,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'draft',1,?,?,?,?,?)`).run(id, userId, agent.inbox_id, agent.id, (name?.trim() || agent.name).slice(0, 80), agent.goal_prompt,
      JSON.stringify(spec), JSON.stringify(emptyStats()), Math.max(60, agent.interval_seconds ?? 300), at, at);
    // Emails the agent already handled stay handled; the recipe takes over from the next new one.
    for (const messageId of handled) this.setItem(id, messageId, { status: 'done', reason: 'Handled by the agent this recipe was learned from', summary: '' });
    const asks = analyzeBindings(program, trigger.id, observed, []).filter((binding) => binding.kind === 'ask').length;
    this.platform.log({ userId, agentId: agent.id, runId: null, service: 'system', action: 'recipe_learned', input: agent.name,
      output: `Recipe "${name?.trim() || agent.name}": ${program.length - 1} steps traced to ${observed.length} email fields` +
        (asks ? `; ${asks} open question(s) for you` : '; every argument proven'), verdict: 'ALLOW_TIER_0', ruleId: 'RECIPE_COMPILED', verified: true });
    const recipe = this.recipe(id)!;
    this.publish(recipe);
    return this.view(recipe);
  }

  /** Updates the name, rules, formulas, or schedule. Rule or formula changes need a fresh backtest before running. */
  update(userId: string, id: string, input: { name?: string; rules?: RecipeRule[]; computed?: RecipeComputed[]; interval_seconds?: number }) {
    const recipe = this.owned(userId, id);
    const computed = input.computed ?? recipe.spec.computed;
    const seen = new Set<string>();
    for (const entry of computed) {
      const name = key(entry.name);
      if (seen.has(name)) throw new Error('RECIPE_FORMULA_DUPLICATE');
      seen.add(name);
      const tree = parseFormula(entry.expr);
      const known = new Set([...recipe.spec.observed_fields, ...seen]);
      for (const field of formulaFields(tree)) if (!fieldFor(known, field)) throw new Error('RECIPE_FORMULA_UNKNOWN_FIELD');
    }
    const logic = input.rules !== undefined || input.computed !== undefined;
    const changed = logic && canonicalJson({ rules: input.rules ?? recipe.spec.rules, computed }) !== canonicalJson({ rules: recipe.spec.rules, computed: recipe.spec.computed });
    const updated = this.save(id, {
      ...(input.name?.trim() ? { name: input.name.trim().slice(0, 80) } : {}),
      ...(input.interval_seconds ? { interval_seconds: input.interval_seconds } : {}),
      ...(changed ? {
        spec: { ...recipe.spec, rules: input.rules ?? recipe.spec.rules, computed }, version: recipe.version + 1,
        status: recipe.status === 'enabled' ? 'draft' : recipe.status, next_run_at: null,
      } : {}),
    });
    return this.view(updated);
  }

  /** Replays the recipe over mail already in the inbox without changing anything, and compares it with the agent. */
  async backtest(userId: string, id: string) {
    const recipe = this.owned(userId, id);
    const source = this.platform.ownedAgent(userId, recipe.source_agent_id);
    const trigger = { ...recipe.spec.program.find((step) => step.id === recipe.spec.trigger) as Extract<GenericStep, { op: 'mail.search' }>, limit: 50 };
    const { result, run } = await this.readOnly('recipe:backtest:' + recipe.id, source, async (executor, context) => {
      const rows = await executor.searchRows(trigger);
      const started = performance.now();
      const results: BacktestRow[] = rows.map((row) => {
        const outcome = decide(recipe.spec, row);
        const preview = previewActions(recipe.spec.program, recipe.spec.trigger, row);
        const decision = outcome.decision === 'run' && preview.filtered ? 'filtered' as const : outcome.decision;
        return { message_id: String(row.fields.message_id), date: String(row.fields.date ?? ''), from: String(row.fields.from ?? ''),
          subject: String(row.fields.subject ?? '').slice(0, 120), decision, reason: decision === 'filtered' ? preview.filtered! : outcome.reason,
          actions: ['run', 'approve'].includes(decision) ? preview.actions : [], agent_handled: recipe.spec.handled_by_agent.includes(String(row.fields.message_id)) };
      });
      const elapsed = performance.now() - started;
      context.record('CHECK', { action: 'recipe_backtest', recipe_id: recipe.id, version: recipe.version, emails: results.length, outcome: 'VERIFIED' });
      return { results, elapsed };
    });
    const counts = { run: 0, approve: 0, skip: 0, agent: 0, filtered: 0 };
    for (const row of result.results) counts[row.decision]++;
    const handled = result.results.filter((row) => row.agent_handled);
    const agree = handled.filter((row) => row.decision === 'run' || row.decision === 'approve').length;
    const backtest: Backtest = {
      version: recipe.version, at: now(), run_id: run.id, tokens: run.tokens ?? 0,
      duration_ms: Math.round(Date.parse(run.completedAt!) - Date.parse(run.startedAt)),
      per_email_ms: result.results.length ? Math.round(result.elapsed / result.results.length * 100) / 100 : 0,
      counts, agreement: { agent_handled: recipe.spec.handled_by_agent.length, agree, rate: recipe.spec.handled_by_agent.length ? agree / recipe.spec.handled_by_agent.length : null },
      rows: result.results,
    };
    this.platform.log({ userId, agentId: source.id, runId: run.id, service: 'system', action: 'recipe_backtest', input: recipe.name,
      output: `${result.results.length} emails: ${counts.run} run, ${counts.approve} ask first, ${counts.agent} to agent, ${counts.skip} skipped` +
        (backtest.agreement.rate !== null ? ` · agrees with the agent on ${agree}/${recipe.spec.handled_by_agent.length}` : '') + ` · ${backtest.tokens} tokens`,
      verdict: 'ALLOW_TIER_0', ruleId: 'RECIPE_BACKTEST', verified: true });
    return this.view(this.save(id, { backtest }));
  }

  setEnabled(userId: string, id: string, enabled: boolean) {
    const recipe = this.owned(userId, id);
    if (enabled) {
      this.engine.guard();
      const view = this.view(recipe);
      if (!view.ready) throw new Error('RECIPE_NOT_READY');
      return this.view(this.save(id, { status: 'enabled', next_run_at: now() }));
    }
    return this.view(this.save(id, { status: 'paused', next_run_at: null }));
  }

  archive(userId: string, id: string) {
    this.owned(userId, id);
    this.save(id, { status: 'archived', next_run_at: null });
    return { archived: true };
  }

  /** Runs a ready recipe now (button, MCP tool, or schedule). */
  async runNow(userId: string, id: string, trigger = 'manual') {
    const recipe = this.owned(userId, id);
    if (!this.view(recipe).ready) throw new Error('RECIPE_NOT_READY');
    return this.missions.exclusive(() => this.run(id, trigger));
  }

  async runDue() {
    const due = this.db.prepare("SELECT id FROM agent_recipes WHERE status='enabled' AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at LIMIT 1")
      .get(now()) as { id: string } | undefined;
    if (!due) return;
    await this.missions.exclusive(() => this.run(due.id, 'schedule')).catch(() => {
      // A run that could not even start (lease busy, source agent gone) backs off instead of retrying every tick.
      this.db.prepare("UPDATE agent_recipes SET next_run_at=? WHERE id=? AND status='enabled' AND next_run_at<=?")
        .run(new Date(Date.now() + 30_000).toISOString(), due.id, now());
    });
  }

  /** When the operator decides on a held email, the recipe runs again soon to act on that decision. */
  checkApprovals() {
    const rows = this.db.prepare(`SELECT i.recipe_id, i.approval_id FROM recipe_items i JOIN agent_recipes r ON r.id=i.recipe_id
      WHERE i.status='awaiting_approval' AND r.status='enabled' AND (r.next_run_at IS NULL OR r.next_run_at>?)`).all(now()) as { recipe_id: string; approval_id: string | null }[];
    for (const row of rows) {
      const approval = row.approval_id ? this.engine.store.approval(row.approval_id) : null;
      if (!approval || approval.status !== 'PENDING' || Date.parse(approval.expires_at) <= Date.now()) {
        this.db.prepare('UPDATE agent_recipes SET next_run_at=? WHERE id=?').run(now(), row.recipe_id);
      }
    }
  }

  /** Approves or declines a held email from the recipe page (the same engine call as the Approval Inbox button). */
  async decideItem(userId: string, id: string, messageId: string, approve: boolean) {
    const recipe = this.owned(userId, id);
    const item = this.item(id, messageId);
    if (!item || item.status !== 'awaiting_approval' || !item.approval_id) throw new Error('RECIPE_ITEM_NOT_WAITING');
    this.engine.resolveApproval(item.approval_id, approve);
    if (recipe.status === 'enabled') this.save(id, { next_run_at: now() });
    else if (this.view(recipe).ready) await this.missions.exclusive(() => this.run(id, 'approval'));
    return this.detail(userId, id);
  }

  /** Hands one email the recipe could not decide to a new one-shot LLM agent, limited to the recipe's own permissions. */
  async escalate(userId: string, id: string, messageId: string) {
    const recipe = this.owned(userId, id);
    const item = this.item(id, messageId);
    if (!item || item.status !== 'escalated') throw new Error('RECIPE_ITEM_NOT_ESCALATED');
    if (item.agent_id || this.escalating.has(id + messageId)) return this.detail(userId, id);
    this.escalating.add(id + messageId);
    try {
      const [subjectPart, fromPart] = item.summary.split(' · from ');
      const subject = (subjectPart ?? '').replace(/["\r\n]/g, ' ').trim().slice(0, 80);
      const sender = address(fromPart ?? '');
      const instruction = `${recipe.goal_prompt}\n\nOnly handle the one email from ${sender} with subject "${subject}". ` +
        `A saved recipe stopped on it because: ${item.reason.replace(/["\r\n]/g, ' ')}. Do not guess missing values; if something is unknown, draft a reply asking for it.`;
      const result = await this.missions.provision({
        userId, inboxId: recipe.inbox_id, instruction, agentName: `${recipe.name} · follow-up`.slice(0, 80), scheduleMode: 'one_shot',
        autoSwitch: false, sourceCli: recipe.spec.source_cli, switchedBy: 'web_ui',
        authorize: (compiled) => {
          if (recipe.spec.source_cli === 'web') return;
          const program = compiled.plan.params.program;
          if (!program || program.flatMap(genericStepScopes).some((scope) => !recipe.spec.mcp_scopes?.includes(scope))) throw new Error('MCP_SCOPE_REQUIRED');
          compiled.plan.params.mcp_scopes = recipe.spec.mcp_scopes;
        },
      });
      this.setItem(id, messageId, { status: 'escalated', reason: item.reason, agent_id: result.agent_id });
      this.publish(recipe);
    } finally {
      this.escalating.delete(id + messageId);
    }
    return this.detail(userId, id);
  }

  /** Executes the recipe once as an engine mission: no model calls, every action policy-checked and verified. */
  private async run(id: string, trigger: string) {
    const recipe = this.recipe(id);
    if (!recipe || recipe.status === 'archived') throw new Error('RECIPE_NOT_AVAILABLE');
    const source = this.platform.agent(recipe.source_agent_id);
    if (!source) throw new Error('AGENT_NOT_AVAILABLE');
    const mode = recipe.inbox_id === 'sandbox' ? 'sandbox' as const : `live:${recipe.inbox_id}` as const;
    const runner: AgentRecord = {
      ...source, name: `Recipe · ${recipe.name}`, goal_prompt: recipe.goal_prompt, schedule_mode: 'continuous',
      workflow_plan: { ...source.workflow_plan, params: { ...source.workflow_plan.params, program: recipe.spec.program, mcp_scopes: recipe.spec.mcp_scopes } },
    };
    const allowed: Row[] = [];
    const counts = { held: 0, escalated: 0, skipped: 0 };
    const escalations: string[] = [];
    let pending: string[] = [];
    const summary = (row: Row) => `${String(row.fields.subject ?? '').slice(0, 120)} · from ${row.fields.from ?? ''}`;
    const handle = this.engine.mission('recipe:' + recipe.id, mode, async (context) => {
      context.record('PLAN', { recipe_id: recipe.id, recipe_version: recipe.version, source_agent_id: source.id, planner: 'recipe', model_calls: 0,
        steps: recipe.spec.program.map((step) => step.id) });
      const gate = async (rows: Row[]) => {
        for (const row of rows) {
          context.checkout();
          const messageId = String(row.fields.message_id);
          const item = this.item(recipe.id, messageId);
          if (item && item.status !== 'awaiting_approval') continue;
          const outcome = decide(recipe.spec, row);
          if (item?.status === 'awaiting_approval') {
            const approval = item.approval_id ? this.engine.store.approval(item.approval_id) : null;
            const expired = approval?.status === 'EXPIRED' || (approval?.status === 'PENDING' && Date.parse(approval.expires_at) <= Date.now());
            if (approval?.status === 'APPROVED') { allowed.push(row); continue; }
            if (approval?.status === 'PENDING' && !expired) { counts.held++; continue; }
            this.setItem(recipe.id, messageId, { status: 'declined', reason: expired ? 'Approval expired; nothing was done' : 'You declined; nothing was done', run_id: context.runId });
            continue;
          }
          if (outcome.decision === 'skip') {
            counts.skipped++;
            this.setItem(recipe.id, messageId, { status: 'skipped', reason: outcome.reason, summary: summary(row), run_id: context.runId });
          } else if (outcome.decision === 'agent') {
            counts.escalated++;
            escalations.push(messageId);
            this.setItem(recipe.id, messageId, { status: 'escalated', reason: outcome.reason, summary: summary(row), run_id: context.runId });
          } else if (outcome.decision === 'approve') {
            const values = Object.fromEntries(Object.entries(row.fields).filter(([name]) => !['message_id', 'thread_id', 'attachments'].includes(name)).slice(0, 8)
              .map(([name, value]) => [name, typeof value === 'number' ? value : String(sanitizeCell(value).value).slice(0, 80)]));
            const action: SafeAction = {
              kind: 'review', playbook: 'recipe_rule', target: `recipe-${recipe.id.slice(0, 8)}-${sha256(messageId).slice(0, 16)}`, sourceId: messageId,
              threadId: row.message?.threadId, version: sha256(canonicalJson({ recipe: recipe.id, version: recipe.version, messageId, rule: outcome.rule })),
              after: { recipe: recipe.name, rule: outcome.reason, email: summary(row), ...values }, requestedTier: 2, reason: 'RECIPE_RULE_APPROVAL', confidence: 1,
            };
            const gated = await context.execute(action);
            if (gated.approvalId) {
              counts.held++;
              pending.push(gated.approvalId);
              this.setItem(recipe.id, messageId, { status: 'awaiting_approval', reason: outcome.reason, summary: summary(row), approval_id: gated.approvalId, run_id: context.runId });
            } else {
              counts.skipped++;
              this.setItem(recipe.id, messageId, { status: 'skipped', reason: `Blocked by ${gated.ruleId}`, summary: summary(row), run_id: context.runId });
            }
          } else allowed.push(row);
        }
        return allowed;
      };
      // Like agent runs, an action that is blocked or fails read-back fails the run, so its emails are retried next time.
      const failures = new Set<string>();
      const track = async (work: Promise<MissionOutcome>) => {
        const outcome = await work;
        if (!outcome.verified && outcome.decision !== 'APPROVAL_REQUIRED') failures.add(outcome.decision === 'BLOCKED' ? outcome.ruleId : outcome.outcome || 'ACTION_UNVERIFIED');
        return outcome;
      };
      const tracked: MissionContext = { ...context, execute: (action) => track(context.execute(action)),
        queueBatch: (actions, reason) => track(context.queueBatch(actions, reason)) };
      const ops = new WorkspaceOps(tracked, this.engine.workspace(mode), this.platform,
        { userId: recipe.user_id, agentId: source.id, inboxId: recipe.inbox_id }, this.engine.stagingRoot());
      const result = await new ProgramExecutor(this.engine, this.platform, runner, tracked, ops, { review: false, triggerId: recipe.spec.trigger, gate }).run();
      if (failures.size) {
        context.record('CHECK', { outcome: 'REQUESTED_ACTION_UNVERIFIED', errors: [...failures] });
        throw new Error(failures.values().next().value);
      }
      pending = [...pending, ...result.pending];
      for (const row of allowed) {
        const messageId = String(row.fields.message_id);
        const approved = this.item(recipe.id, messageId)?.status === 'awaiting_approval';
        this.setItem(recipe.id, messageId, { status: 'done', summary: summary(row), run_id: context.runId,
          reason: (approved ? 'Approved by you, then handled' : 'Handled by the recipe') + (result.pending.length ? '; drafts wait in Approval Inbox' : '') });
      }
    });
    const run = await handle.done;
    const duration = Math.max(0, Date.parse(run.completedAt ?? now()) - Date.parse(run.startedAt));
    const tokens = run.tokens ?? 0;
    this.db.prepare('INSERT INTO recipe_runs VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(run.id, recipe.id, trigger, run.status,
      run.status === 'COMPLETED' ? allowed.length : 0, counts.held, counts.escalated, counts.skipped, duration, tokens, now());
    const totals = this.db.prepare(`SELECT count(*) AS runs, coalesce(sum(handled),0) AS handled, coalesce(sum(escalated),0) AS escalated,
      coalesce(sum(skipped),0) AS skipped, coalesce(sum(duration_ms),0) AS total_ms, coalesce(sum(tokens),0) AS tokens FROM recipe_runs WHERE recipe_id=?`)
      .get(recipe.id) as Record<string, number>;
    const held = (this.db.prepare("SELECT count(*) AS n FROM recipe_items WHERE recipe_id=? AND status='awaiting_approval'").get(recipe.id) as { n: number }).n;
    const latest = this.recipe(id)!;
    const stats: RecipeStats = { runs: Number(totals.runs), handled: Number(totals.handled), held: Number(held), escalated: Number(totals.escalated),
      skipped: Number(totals.skipped), total_ms: Number(totals.total_ms), last_ms: duration, tokens: Number(totals.tokens) };
    this.save(id, { stats, last_run_at: now(),
      next_run_at: latest.status === 'enabled' ? new Date(Date.now() + latest.interval_seconds * 1000).toISOString() : latest.next_run_at });
    const output = run.status === 'COMPLETED'
      ? `${allowed.length} handled, ${counts.held} waiting for you, ${counts.escalated} to an agent, ${counts.skipped} skipped · ${duration} ms · ${tokens} tokens`
      : `Stopped: ${run.error ?? 'failed'}`;
    this.platform.log({ userId: recipe.user_id, agentId: source.id, runId: run.id, service: 'system', action: 'recipe_run', input: recipe.name, output,
      verdict: run.status === 'COMPLETED' ? (counts.held ? 'GATE_TIER_2' : 'ALLOW_TIER_0') : 'BLOCKED', ruleId: run.status === 'COMPLETED' ? 'RECIPE_REPLAY' : run.error ?? 'RECIPE_FAILED',
      verified: run.status === 'COMPLETED' });
    // Anything the recipe could not prove goes to an LLM agent automatically when one is configured.
    if (this.engine.agent.mode === 'llm') {
      for (const messageId of escalations) void this.escalate(recipe.user_id, recipe.id, messageId).catch(() => undefined);
    }
    if (run.status !== 'COMPLETED') throw new Error(run.error ?? 'RECIPE_RUN_FAILED');
    return { run_id: run.id, handled: allowed.length, waiting_for_approval: counts.held, escalated: counts.escalated, skipped: counts.skipped,
      pending_approvals: [...new Set(pending)], duration_ms: duration, tokens, model_calls: 0 };
  }
}
