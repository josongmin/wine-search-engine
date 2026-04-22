import { z } from 'zod';
import {
  MAX_AGENT_HTTP_QUERY_CHARS,
  MAX_AGENT_STEPS_CAP,
  MAX_SESSION_ENTITY_ID_CHARS,
  MAX_SESSION_PREVIOUS_ENTITIES,
} from '../constants.js';
import {
  ClaudeToolNameSchema,
  CompareWinesAttemptInputSchema,
  DrinkingWindowAttemptInputSchema,
  FoodPairingAttemptInputSchema,
  SearchToolAttemptInputSchema,
} from '../../claude-tools/tool-schemas.js';
import { MAX_UNKNOWN_TOOL_INPUT_KEYS } from '../../../application/agent/agent-tool-attempt-schema.js';

export const AgentRequestSchema = z.object({
  query: z.string().min(1).max(MAX_AGENT_HTTP_QUERY_CHARS),
  session_context: z.object({
    session_id: z.string().min(1).max(MAX_SESSION_ENTITY_ID_CHARS),
    previous_entities: z.array(z.string().min(1).max(MAX_SESSION_ENTITY_ID_CHARS)).max(MAX_SESSION_PREVIOUS_ENTITIES).optional(),
  }).strict().optional(),
  options: z.object({
    max_steps: z.number().int().min(1).max(MAX_AGENT_STEPS_CAP).optional(),
  }).strict().optional(),
}).strict();

const AgentKnownToolCallSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('search_wines'),
    input: SearchToolAttemptInputSchema,
  }).strict(),
  z.object({
    tool: z.literal('get_food_pairings'),
    input: FoodPairingAttemptInputSchema,
  }).strict(),
  z.object({
    tool: z.literal('check_drinking_window'),
    input: DrinkingWindowAttemptInputSchema,
  }).strict(),
  z.object({
    tool: z.literal('compare_wines'),
    input: CompareWinesAttemptInputSchema,
  }).strict(),
]);

const AgentUnknownToolCallSchema = z.object({
  tool: z.string().min(1).refine(
    (tool) => !ClaudeToolNameSchema.safeParse(tool).success,
    { message: 'Unknown tool calls must not use a registered tool name.' },
  ),
  input: z.record(z.unknown()).refine(
    (r) => Object.keys(r).length <= MAX_UNKNOWN_TOOL_INPUT_KEYS,
    { message: `Unknown tool input must have at most ${MAX_UNKNOWN_TOOL_INPUT_KEYS} keys.` },
  ),
}).strict();

const AgentToolCallSchema = z.union([
  AgentKnownToolCallSchema,
  AgentUnknownToolCallSchema,
]);

export const AgentStepSchema = z.object({
  index: z.number().int().nonnegative(),
  thought: z.string(),
  action: AgentToolCallSchema.optional(),
  observation: z.string().optional(),
  actions: z.array(AgentToolCallSchema).max(MAX_AGENT_STEPS_CAP).optional(),
  observations: z.array(z.string()).max(MAX_AGENT_STEPS_CAP).optional(),
  answer: z.string().optional(),
  duration_ms: z.number().int().nonnegative(),
  token_count: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const AgentResponseSchema = z.object({
  query_type: z.literal('agent'),
  answer: z.string(),
  steps: z.array(AgentStepSchema).max(MAX_AGENT_STEPS_CAP),
  meta: z.object({
    request_id: z.string(),
    total_duration_ms: z.number().finite().nonnegative(),
    tool_call_count: z.number().int().nonnegative(),
    termination_reason: z.enum([
      'answer',
      'max_steps',
      'timeout',
      'budget',
      'error',
      'loop_detected',
      'fallback',
      'blocked',
      'aborted',
    ]),
    fallback_applied: z.boolean(),
    fallback_trace: z.object({
      fallback_applied: z.enum(['layer2', 'layer3', 'layer4']).nullable(),
      reasoning_failure: z.boolean(),
      failed_synthesis_attempts: z.number().int().nonnegative(),
      fallback_search_used: z.boolean(),
    }).strict().optional(),
    total_tokens: z.object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
}).strict();

export type AgentRequestBody = z.infer<typeof AgentRequestSchema>;
export type AgentResponseBody = z.infer<typeof AgentResponseSchema>;
export type AgentStepBody = z.infer<typeof AgentStepSchema>;
