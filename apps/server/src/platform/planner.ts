import { z } from 'zod';
import { mcpScopes } from '../auth/google.js';
import { describeStep, genericProgramSchema, opService, type GenericStep } from './generic.js';

const serviceEnum = z.enum(['gmail', 'calendar', 'drive', 'docs', 'sheets', 'photos', 'policy', 'system']);
/** Every agent is an AI-composed program ('generic'); 'interactive' records direct tool calls from a connected AI tool. */
export const templates = ['generic', 'interactive'] as const;

const stepSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,40}$/),
  service: serviceEnum,
  action: z.string().regex(/^[a-z_]{3,48}$/),
  label: z.string().min(1).max(160),
  depends_on: z.array(z.string()).max(8),
  tier_hint: z.union([z.literal(0), z.literal(1), z.literal(2)]),
}).strict();

export const workflowPlanSchema = z.object({
  version: z.literal(1),
  planner: z.enum(['deterministic-intent-compiler', 'llm-planner']),  // 'deterministic-intent-compiler' only labels interactive records
  template: z.enum(templates),
  matched_playbooks: z.array(z.string()).max(8),
  services: z.array(z.enum(['gmail', 'calendar', 'drive', 'docs', 'sheets', 'photos'])).max(6),
  params: z.object({
    program: genericProgramSchema.optional(),
    mcp_scopes: z.array(z.enum(mcpScopes)).max(mcpScopes.length).optional(),
    reasoning: z.string().max(1200).optional(),
  }).strict(),
  steps: z.array(stepSchema).min(1).max(20),
}).strict().superRefine((plan, context) => {
  const ids = new Set<string>();
  for (const step of plan.steps) {
    // Steps must form a DAG in declaration order: every dependency is an earlier step.
    if (step.depends_on.some((dependency) => !ids.has(dependency))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'PLAN_DEPENDENCY_INVALID: ' + step.id });
    }
    ids.add(step.id);
  }
});
export type WorkflowPlan = z.infer<typeof workflowPlanSchema>;
type Step = WorkflowPlan['steps'][number];

const step = (id: string, service: Step['service'], action: string, label: string, depends: string[] = [], tier: 0 | 1 | 2 = 0): Step =>
  ({ id, service, action, label, depends_on: depends, tier_hint: tier });

export interface CompiledIntent {
  name: string;
  plan: WorkflowPlan;
  services: WorkflowPlan['services'];
  scheduleMode: 'one_shot' | 'continuous' | 'daily' | 'weekly';
}

export const emailsIn = (text: string) => [...new Set([...text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((match) => match[0].toLowerCase()))];

/**
 * How often the user's own words say the agent should run. Only time phrases are read (no task words): small models
 * sometimes answer "one_shot" for "every time I get…", and the user's explicit recurrence wins.
 */
export function statedSchedule(instruction: string): CompiledIntent['scheduleMode'] {
  const text = instruction.toLowerCase();
  if (/\b(?:every day|daily|each day|each morning|every morning|every evening|each evening)\b/.test(text)) return 'daily';
  if (/\b(?:every week|weekly|each week)\b/.test(text)) return 'weekly';
  return /\b(?:keep watching|keep (?:a )?(?:log|track|record)|every [a-z ]{1,40}?(?:i|we) (?:get|receive)|continuous(?:ly)?|monitor|whenever|as they arrive|every time|each time|any time|anytime|when(?:ever)? (?:i|we) (?:get|receive)|when (?:a |an )?new|(?:all|any) new|24\/7)(?![a-z])/.test(text)
    ? 'continuous' : 'one_shot';
}

/**
 * Builds a plan from the AI-composed program. Recipient guard: `mail.send` may only
 * target addresses the user typed; anything else is removed before the plan is stored.
 */
export function planFromProgram(input: { program: GenericStep[]; name: string; scheduleMode: CompiledIntent['scheduleMode']; reasoning?: string },
  instruction: string, planner: WorkflowPlan['planner']): CompiledIntent {
  const typed = new Set(emailsIn(instruction));
  const program = input.program.flatMap((entry): GenericStep[] => {
    if (entry.op !== 'mail.send') return [entry];
    const to = entry.to.map((address) => address.toLowerCase()).filter((address) => typed.has(address));
    return to.length ? [{ ...entry, to }] : [];
  });
  const valid = genericProgramSchema.parse(program);
  const services = [...new Set(valid.map((entry) => opService[entry.op]).filter((service) => service !== 'system'))] as WorkflowPlan['services'];
  const plan: WorkflowPlan = {
    version: 1, planner, template: 'generic', matched_playbooks: ['generic_program'], services,
    params: { program: valid, reasoning: input.reasoning?.slice(0, 1200) },
    steps: valid.map((entry) => step(entry.id, opService[entry.op], entry.op.replace('.', '_'), describeStep(entry).slice(0, 160),
      'from' in entry && entry.from ? [entry.from] : [], entry.op === 'mail.draft_replies' || entry.op === 'mail.send' ? 2 : 0)),
  };
  return { name: input.name.slice(0, 80), plan: workflowPlanSchema.parse(plan), services, scheduleMode: input.scheduleMode };
}

export function interactivePlan(): WorkflowPlan {
  return workflowPlanSchema.parse({
    version: 1, planner: 'deterministic-intent-compiler', template: 'interactive', matched_playbooks: [], services: ['drive', 'docs', 'sheets', 'photos'],
    params: {}, steps: [step('interactive', 'system', 'direct_mcp_tools', 'Direct policy-gated MCP Workspace tool calls')],
  });
}
