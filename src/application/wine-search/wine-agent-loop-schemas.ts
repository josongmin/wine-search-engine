/**
 * WineAgentLoopRunner — typed schemas (plans, directives, step records, output).
 *
 * The WineAgentLoopRunner is the lean ReAct loop for the ~10–20% of queries that
 * genuinely need multi-hop. It sits between `DeterministicRouter`
 * (which decides multi-step is needed) and `SynthesisRunner` (which produces
 * the final answer). The runner drives `StructuredLlmPort.execute` with
 * native `tool_use` and recomputes the next directive on every iteration
 * FUNCTIONALLY from current observations + analysis contract — there is no
 * sticky state on the runner.
 *
 * Why a dedicated schemas file?
 *  - Keeps the loop body in `wine-agent-loop.ts` lean and free of type plumbing.
 *  - Lets tests import the typed input/output shapes without pulling in
 *    Logger or LLM-port wiring.
 *  - All numeric defaults are named consts here (CLAUDE.md rule 15) with a
 *    justification trace to `DEFAULT_AGENT_CONFIG` so the two configs stay
 *    arithmetically consistent (CLAUDE.md rule 22).
 *  - All Zod schemas chain `.strict()` (CLAUDE.md rule 10). None of these
 *    are LLM-tool-call shapes — they are server-internal contract shapes.
 */

import { z } from 'zod';
import type { TokenUsage, ToolDefinition } from '@domain/ai/port/structured-llm.port.js';
import type { ChatMessage } from '@domain/ai/port/chat-llm.port.js';
import type { AgentTerminationReason } from '@domain/agent/model/agent-step.js';
import type { AgentToolName } from '@domain/agent/model/tool-outcome.js';
import type { ToolOutcome } from '@domain/agent/model/tool-outcome.js';
import { KNOWN_AGENT_TOOL_NAMES } from '@domain/agent/model/agent-tool-attempt-schema.js';
import { AGENT_DIRECTIVE_COPY } from '@domain/agent/copy/directive-copy.js';
import type { SearchUseCasePort } from './execution-runner.js';
import type { SearchUseCaseInput } from './execution-plan-schemas.js';
import type { DecomposedSearchUseCasePort } from '../search/port/search-route-usecases.port.js';
import type { DrinkingWindowUseCasePort } from '../drinking-window/port/drinking-window-usecase.port.js';
import type { EntityDocumentLookupPort } from '../search/port/search-pipeline-deps.port.js';
import type { WineSearchAnalysis } from './wine-search-schemas.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15).
//
// The WineAgentLoop budget is intentionally tighter than `DEFAULT_AGENT_CONFIG`
// (maxSteps=5, agentTimeoutMs=25_000, perStepTimeoutMs=10_000,
// maxTotalTokens=50_000). Wine-agent-loop only fires for the small slice of
// queries that truly need multi-hop, so we want them to either resolve in
// ≤3 LLM turns or terminate fast and hand back to the synthesizer.
//
// Arithmetic consistency check (CLAUDE.md rule 22):
//   maxSteps=3 × perStepTimeoutMs=12_000 = 36_000ms naive worst case.
//   agentTimeoutMs=25_000 fires well inside that envelope.
//   maxTotalTokens=30_000 / maxSteps=3 ≈ 10_000 tokens/step. System prompt
//   for native tool_use is ~600 tokens; cached tool defs ~400 tokens; leaves
//   ≈ 9_000 tokens per turn for tool_result content + thinking + answer.
// ---------------------------------------------------------------------------

/** Maximum number of LLM turns before forced termination. Three is the
 *  empirical maximum a single multi-hop query needs: (1) initial search,
 *  (2) follow-up tool call driven by directive, (3) final answer. Anything
 *  beyond that escalates back to the synthesizer rather than burning more
 *  tokens. */
export const WINE_AGENT_LOOP_DEFAULT_MAX_STEPS = 3;

/** Per-tool invocation cap for the StepBudget. Two is the minimum that
 *  still allows constraint-relaxation retries (initial + 1 relax). The
 *  adaptive cap in `step-budget.ts` raises this floor to MIN_PER_TOOL_CALL_CAP=3
 *  internally — we pass 2 as the AgentConfig hint to ensure the adaptive
 *  formula `max(MIN, ceil(maxSteps * 0.6))` evaluates to a sensible value
 *  when maxSteps=3 (yields cap=3). */
export const WINE_AGENT_LOOP_DEFAULT_PER_TOOL_CAP = 2;

/** Per-LLM-call timeout. 12s exceeds the synthesis runner's 10s default
 *  because wine-agent-loop calls also do tool-use parsing and we want enough
 *  headroom for legitimate searches over Vespa. */
export const WINE_AGENT_LOOP_DEFAULT_PER_STEP_TIMEOUT_MS = 12_000;

/** Wall-clock cap for the entire wine-agent-loop. 25_000ms leaves ≈5s for the
 *  downstream synthesizer to compose the final response within the typical
 *  30s HTTP budget. */
export const WINE_AGENT_LOOP_DEFAULT_AGENT_TIMEOUT_MS = 25_000;

/** Hard cap on aggregated tokens across the loop. Tighter than the agent
 *  default (50_000) because wine-agent-loop is the rare path, not the standard
 *  one. Reaching this cap is itself a signal to fall back. */
export const WINE_AGENT_LOOP_DEFAULT_MAX_TOTAL_TOKENS = 30_000;

/** Maximum tokens the LLM may emit in a single wine-agent-loop turn. Sized so
 *  one verbose tool_use call (~3 fields, ~50 tokens of JSON) plus a brief
 *  thinking block fits comfortably without bursting the per-step budget. */
export const WINE_AGENT_LOOP_DEFAULT_MAX_OUTPUT_TOKENS = 1_024;

/** After this many `loop_detected` rejections the loop terminates with
 *  reason 'loop_detected'. One rejection is recoverable (the model can try
 *  a different angle); two is structural thrashing. */
export const WINE_AGENT_LOOP_LOOP_DETECTED_TERMINATE_COUNT = 2;

/** After this many consecutive turns where the model emits an answer but
 *  a pending directive blocks acceptance, terminate with `max_steps`. The
 *  explicit zombie-loop kill switch: if the model refuses to honor a
 *  directive twice in a row, no further iteration will help and the
 *  synthesizer downstream can compose a degraded response. */
export const WINE_AGENT_LOOP_DIRECTIVE_IGNORED_TERMINATE_COUNT = 2;

/** Maximum number of entity ids embedded in a single
 *  `pending_drinkability_check` directive. Aligns with
 *  `WINE_SEARCH_MAX_ANCHORS` (8) without re-importing the constant — the
 *  schema below validates against this same bound. */
export const WINE_AGENT_LOOP_MAX_DRINKABILITY_ENTITY_IDS = 8;

/** Maximum characters for a constraint attribute name (e.g. 'maxPriceKrw').
 *  64 chars covers the longest observed attribute name with headroom. */
const DIRECTIVE_CONSTRAINT_ATTRIBUTE_MAX_CHARS = 64;

/** Maximum characters for a directive's instruction string. 512 chars holds
 *  the longest Korean directive copy (pending_drinkability with 8 entity
 *  ids) without truncation. */
const DIRECTIVE_INSTRUCTION_MAX_CHARS = 512;

/** Maximum characters for an entity id surfaced in a directive. Entity ids
 *  are UUIDs or canonical-label slugs; 128 covers both. */
const DIRECTIVE_ENTITY_ID_MAX_CHARS = 128;

/** Default Anthropic model id for wine-agent-loop execution. Overrideable via
 *  runner deps for tests / future routing.
 *  Format `claude-<family>-<gen>` per Anthropic Messages API spec — matches
 *  `claude-(opus|sonnet|haiku)-N-M`. `claude-4-sonnet-latest` is rejected with HTTP 400. */
import { CLAUDE_SONNET_MODEL_ID } from '@domain/shared/constants/claude-models.js';
export const WINE_AGENT_LOOP_DEFAULT_MODEL = CLAUDE_SONNET_MODEL_ID;

// ---------------------------------------------------------------------------
// AgentToolName re-export — convenience for runner consumers.
//
// SSoT: `KNOWN_AGENT_TOOL_NAMES` from `agent-tool-attempt-schema.ts`. We
// re-derive the type here rather than re-importing the alias so the schemas
// file stays self-contained for callers.
// ---------------------------------------------------------------------------

const AgentToolNameSchema = z.enum(KNOWN_AGENT_TOOL_NAMES);

// ---------------------------------------------------------------------------
// Directives — observation-driven instructions for the next LLM turn.
//
// THIS is the architectural fix for the zombie-loop problem: every
// iteration recomputes the directive from current observations + analysis
// contract. There is NO sticky `state.pendingPlannerDirective`. If the
// model emits an answer that violates the contract, the directive is
// recomputed; if the model corrects course, the directive is unset on the
// next pass.
// ---------------------------------------------------------------------------

export const WineAgentLoopDirectiveSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('relax_constraints_retry'),
    /** Constraint attributes (e.g. 'maxPriceKrw', 'vintageMin') the model
     *  is allowed to drop to widen the search. Empty array means "use your
     *  judgment about which non-must-have to relax". */
    relaxableConstraintAttributes: z.array(z.string().min(1).max(DIRECTIVE_CONSTRAINT_ATTRIBUTE_MAX_CHARS)).max(WINE_AGENT_LOOP_MAX_DRINKABILITY_ENTITY_IDS),
    instruction: z.string().min(1).max(DIRECTIVE_INSTRUCTION_MAX_CHARS),
  }).strict(),
  z.object({
    kind: z.literal('pending_drinkability_check'),
    entityIds: z.array(z.string().min(1).max(DIRECTIVE_ENTITY_ID_MAX_CHARS)).min(1).max(WINE_AGENT_LOOP_MAX_DRINKABILITY_ENTITY_IDS),
    instruction: z.string().min(1).max(DIRECTIVE_INSTRUCTION_MAX_CHARS),
  }).strict(),
  z.object({
    kind: z.literal('required_tool'),
    tool: AgentToolNameSchema,
    instruction: z.string().min(1).max(DIRECTIVE_INSTRUCTION_MAX_CHARS),
  }).strict(),
  z.object({
    kind: z.literal('grounded_search_required'),
    instruction: z.string().min(1).max(DIRECTIVE_INSTRUCTION_MAX_CHARS),
  }).strict(),
]);
export type WineAgentLoopDirective = z.infer<typeof WineAgentLoopDirectiveSchema>;

// ---------------------------------------------------------------------------
// Step record — one LLM turn (single call or tool-use batch).
// ---------------------------------------------------------------------------

export interface WineAgentLoopToolCall {
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

export type WineAgentLoopStepKind = 'answer' | 'tool_use' | 'error';

export interface WineAgentLoopStep {
  readonly index: number;
  readonly kind: WineAgentLoopStepKind;
  /** Free-form reasoning surfaced by the LLM. Empty for `error` steps. */
  readonly reasoning: string;
  /** Tool calls fired in this turn. Empty for `answer` and `error`. */
  readonly toolCalls: readonly WineAgentLoopToolCall[];
  /** Compact textual observations (one per tool call, parallel index). */
  readonly observations: readonly string[];
  /** Typed companion outcomes (one per tool call, parallel index). */
  readonly toolOutcomes: readonly ToolOutcome[];
  /** Final answer text — present only when `kind === 'answer'`. */
  readonly answer?: string | undefined;
  /** Set when `kind === 'error'`. */
  readonly errorReason?: AgentTerminationReason | undefined;
  /** Set when `kind === 'error'`. */
  readonly errorMessage?: string | undefined;
  /** Wall-clock duration of the turn (LLM call + tool dispatch). */
  readonly durationMs: number;
  /** TokenUsage from the LLM call that produced this step. */
  readonly tokenUsage: TokenUsage;
}

// ---------------------------------------------------------------------------
// Tool ports — re-uses ports from `execution-runner.ts`. We don't redefine
// `SearchUseCasePort`, etc. (SSoT — CLAUDE.md rule 30).
// ---------------------------------------------------------------------------

export interface WineAgentLoopToolPorts {
  readonly searchUseCase: SearchUseCasePort;
  readonly decomposedSearchUseCase?: DecomposedSearchUseCasePort | undefined;
  readonly drinkingWindowUseCase?: DrinkingWindowUseCasePort | undefined;
  readonly entityLookup?: EntityDocumentLookupPort | undefined;
}

// ---------------------------------------------------------------------------
// Input + outcome
// ---------------------------------------------------------------------------

export interface WineAgentLoopInput {
  readonly query: string;
  /** Prior conversation turns (server- or caller-managed), seeded into the
   *  loop's rolling chat history BEFORE the anchor `query` so the agent LLM
   *  plans against the real multi-turn context. Empty/absent for a fresh
   *  single-turn run (T-MTA-01). */
  readonly priorHistory?: readonly ChatMessage[] | undefined;
  readonly analysis: WineSearchAnalysis;
  /** Router-authored deterministic seed input for the active multi-step
   *  query. Used when a follow-up primitive can be continued structurally
   *  from prior tool results (e.g. lookup_wine → similar_to_entity) without
   *  burning another planner LLM turn. */
  readonly seedSearchInput?: SearchUseCaseInput | undefined;
  /** Directive seeded by `DeterministicRouter` when applicable. Optional —
   *  if absent the runner starts with no directive and recomputes after the
   *  first LLM turn. */
  readonly initialDirective?: WineAgentLoopDirective | undefined;
  readonly requestId: string;
  /** Tool definitions for native `tool_use`. Re-uses the structured-LLM
   *  port type so callers can build them once and share with other
   *  consumers. */
  readonly tools: readonly ToolDefinition[];
  readonly toolPorts: WineAgentLoopToolPorts;
  readonly perStepTimeoutMs: number;
  readonly agentTimeoutMs: number;
  readonly maxSteps: number;
  readonly maxTotalTokens: number;
  readonly maxOutputTokens: number;
  readonly perToolCap: number;
  readonly abortSignal?: AbortSignal | undefined;
}

export interface WineAgentLoopOutcome {
  readonly steps: readonly WineAgentLoopStep[];
  readonly toolOutcomes: readonly ToolOutcome[];
  readonly terminationReason: AgentTerminationReason;
  readonly tokenUsage: TokenUsage;
  readonly stoppedAtStep: number;
  /** Final answer string, if any. The synthesizer downstream may still
   *  rewrite this — the wine-agent-loop only collects it. */
  readonly answer?: string | undefined;
}

// ---------------------------------------------------------------------------
// Directive copy — Korean / English variants used by the runner when it
// computes a directive functionally. Centralized here so tests and the
// runner agree on the exact strings.
// ---------------------------------------------------------------------------

export interface WineAgentLoopDirectiveCopy {
  readonly relax: string;
  readonly groundedSearch: string;
  readonly requiredTool: (tool: AgentToolName) => string;
  readonly pendingDrinkability: (entityIds: readonly string[]) => string;
  readonly loopDetected: string;
}

// WINE_AGENT_LOOP_DIRECTIVE_COPY_{KOREAN,ENGLISH} are thin adapters over the SSoT
// `AGENT_DIRECTIVE_COPY` (CLAUDE.md rule 25/30). The wine-agent-loop runner needs
// the `requiredTool` callback typed as `(tool: AgentToolName) => string`
// rather than the SSoT's `(tool: string) => string`; the adapter narrows the
// type while reusing the same string content. Strings remain identical.

export const WINE_AGENT_LOOP_DIRECTIVE_COPY_KOREAN: WineAgentLoopDirectiveCopy = {
  relax: AGENT_DIRECTIVE_COPY.korean.relax,
  groundedSearch: AGENT_DIRECTIVE_COPY.korean.groundedSearch,
  requiredTool: (tool) => AGENT_DIRECTIVE_COPY.korean.requiredTool(tool),
  pendingDrinkability: (entityIds) =>
    AGENT_DIRECTIVE_COPY.korean.pendingDrinkability(entityIds),
  loopDetected: AGENT_DIRECTIVE_COPY.korean.loopDetected,
} as const;

export const WINE_AGENT_LOOP_DIRECTIVE_COPY_ENGLISH: WineAgentLoopDirectiveCopy = {
  relax: AGENT_DIRECTIVE_COPY.english.relax,
  groundedSearch: AGENT_DIRECTIVE_COPY.english.groundedSearch,
  requiredTool: (tool) => AGENT_DIRECTIVE_COPY.english.requiredTool(tool),
  pendingDrinkability: (entityIds) =>
    AGENT_DIRECTIVE_COPY.english.pendingDrinkability(entityIds),
  loopDetected: AGENT_DIRECTIVE_COPY.english.loopDetected,
} as const;

export function selectDirectiveCopy(hangulDominant: boolean): WineAgentLoopDirectiveCopy {
  return hangulDominant ? WINE_AGENT_LOOP_DIRECTIVE_COPY_KOREAN : WINE_AGENT_LOOP_DIRECTIVE_COPY_ENGLISH;
}
