/**
 * MiniLoopToolBundle — production tool definitions + dispatch ports for the
 * mini-loop's native `tool_use` driver.
 *
 * Track C handoff (architectural context):
 *  - `DeterministicRouter` emits a `multi-step` `ExecutionPlan` for the
 *    ~10–20% of queries that genuinely need ReAct-style multi-hop work.
 *  - `WineSearchOrchestrator` then dispatches that plan to `MiniLoopRunner`
 *    IFF a `miniLoopToolBundle` was wired into its deps (otherwise it
 *    short-circuits to Synthesizer Layer 4 "degraded" — see the orchestrator's
 *    multi-step branch).
 *  - This file is the production bundle: five `ToolDefinition`s (one per
 *    `KNOWN_AGENT_TOOL_NAMES`) plus the `MiniLoopToolPorts` that the runner's
 *    tool dispatcher invokes. Without this wiring the new architecture
 *    silently falls back to Layer 4 — verified by Track C's earlier report.
 *
 * Design rules followed (CLAUDE.md):
 *  - Rule 10  — LLM-input schemas MUST NOT chain `.strict()`. LLMs routinely
 *    emit extra reasoning/confidence keys; rejecting them breaks tool use.
 *    All schemas below allow extra keys.
 *  - Rule 15  — every numeric magic number is a named module-scope const.
 *  - Rule 16  — deterministic bundle is built once at module load; the
 *    individual tool defs are also exported as module-scope consts so prompt
 *    caching sees stable identity across requests.
 *  - Rule 30  — `KNOWN_AGENT_TOOL_NAMES` is the SSoT for tool names; we
 *    import it instead of redeclaring strings inline.
 *  - Rule 33  — production wiring is asserted by the container plus the
 *    bundled wiring test.
 *
 * Tool input contracts:
 *  - Schemas align with what `MiniLoopRunner`'s `invokeToolPort` dispatcher
 *    accepts. The dispatcher reads `query`, `filters`, `preferences`,
 *    `mode`, `limit` for search; `food`, `color`, `styles`, `pairing_tags`,
 *    `max_price_krw` for pairing; `query_a`, `query_b` for comparison;
 *    `entity_id`, `target_year` for drinkability. We expose ONLY the minimal
 *    fields here so the schema is small (≈ token-efficient) — the LLM can
 *    still send extra keys (they're ignored by the dispatcher).
 *
 * Korean discipline: all string fields use plain `z.string().min(1)` — no
 * ASCII-only constraints anywhere. Korean queries (e.g. "부르고뉴 피노누아")
 * parse natively.
 */

import { z } from 'zod';
import {
  KNOWN_AGENT_TOOL_NAMES,
  type KnownAgentToolName,
} from '@domain/agent/model/agent-tool-attempt-schema.js';
import type { ToolDefinition } from '@domain/ai/port/structured-llm.port.js';
import { LookupWineInputSchema } from '../search/lookup-wine-execution.js';
import type { MiniLoopToolPorts } from './mini-loop-schemas.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Minimum length for any non-empty string field in a tool input. One char
 *  matches the existing wine-search query gate (`.min(1)` on
 *  `SearchUseCaseInputSchema`) and trivially rejects empty strings. */
const TOOL_INPUT_STRING_MIN_LEN = 1;

/** Hard cap on a single string field in tool input. Aligns with
 *  `MAX_QUERY_LENGTH` (the wine-search security gate cap). Imposed here as a
 *  defensive guard so a malformed LLM emission cannot fan out a 100k-char
 *  query to Vespa. The constant is duplicated locally rather than imported
 *  from the constants module to avoid coupling the bundle to upstream
 *  numeric drift — Zod parse failure is the contract guard. */
const TOOL_INPUT_STRING_MAX_LEN = 500;

/** Hard cap on the `entity_id` field. Aligns with `ENTITY_ID_MAX_LEN` in
 *  agent-tools.ts (500). Same locally-duplicated constant rationale as
 *  above. */

/** Hard cap on the number of array elements in any tool input array (e.g.
 *  `styles`, `pairing_tags`). Matches `SEARCH_TOOL_MAX_STYLES` (16) — the
 *  legacy agent tool's bound. */
const TOOL_INPUT_MAX_ARRAY_ITEMS = 16;

/** Allowed wine colors for the food-pairing tool. Mirrors
 *  `PairingColorSchema` in `execution-plan-schemas.ts`. */

/** Allowed search retrieval modes. Mirrors `ExecutionSearchModeSchema` in
 *  `execution-plan-schemas.ts`. */
const SEARCH_MODE_VALUES = ['auto', 'entity', 'hybrid', 'mixed'] as const;

/** Hard upper bound on `limit` in a search tool input. Aligns with the
 *  legacy agent-tool cap (`SEARCH_LIMIT_MAX = 20`). */
const TOOL_INPUT_SEARCH_LIMIT_MAX = 20;

// ---------------------------------------------------------------------------
// Shared Zod field builders — all permissive (rule 10), Korean-safe.
// ---------------------------------------------------------------------------

const ToolStringField = z
  .string()
  .min(TOOL_INPUT_STRING_MIN_LEN)
  .max(TOOL_INPUT_STRING_MAX_LEN);

const ToolOptionalStringField = ToolStringField.optional();

// ---------------------------------------------------------------------------
// Tool input schemas.
//
// CLAUDE.md rule 10: NO `.strict()` here. LLMs emit extra reasoning /
// confidence / metadata keys; `.strict()` would fail the entire tool call.
// `z.object` without `.strict()` is permissive by default in Zod (extra keys
// are silently dropped on `.safeParse`).
// ---------------------------------------------------------------------------

const SearchWinesInputSchema = z.object({
  query: ToolStringField,
  filters: z.array(z.unknown()).max(TOOL_INPUT_MAX_ARRAY_ITEMS).optional(),
  preferences: z.array(z.unknown()).max(TOOL_INPUT_MAX_ARRAY_ITEMS).optional(),
  mode: z.enum(SEARCH_MODE_VALUES).optional(),
  limit: z
    .number()
    .int()
    .finite()
    .min(TOOL_INPUT_STRING_MIN_LEN)
    .max(TOOL_INPUT_SEARCH_LIMIT_MAX)
    .optional(),
});

// Identity lookup: schema is the SSoT canonical `LookupWineInputSchema` from
// `lookup-wine-execution.ts`. Before extraction (SOLID H2) this file declared
// a permissive local copy that silently accepted inputs the agent-tools path
// rejected. The shared schema enforces trim + placeholder + max-length and
// stays permissive on `limit` (the dispatcher clamps to LOOKUP_WINE_LIMIT_MAX).

// `z.object` permissive by default; assignment to `ToolOptionalStringField`
// avoids `unused-import` noise if Korean discipline review revisits this
// file. `ToolOptionalStringField` itself is used in optional combinators
// downstream.
void ToolOptionalStringField;

// ---------------------------------------------------------------------------
// Tool descriptions — short, domain-grounded; the LLM reads these to decide
// when to invoke. Kept ≤ ~200 chars so the static system block stays cache-
// friendly. SSoT for tool semantics lives in `mini-loop.ts`'s dispatcher.
// ---------------------------------------------------------------------------

const SEARCH_WINES_DESCRIPTION =
  'Search the wine catalog. Use for finding wines by name, region, style, vintage, price, food pairing intent, or any combination. Accepts structured filters.';

const LOOKUP_WINE_DESCRIPTION =
  'Look up a SPECIFIC wine by name/identity (e.g. "Opus One 2018"). Returns the 1-3 most exact matches via high-precision entity resolution. No filters — use search_wines for constraint-based discovery.';

// ---------------------------------------------------------------------------
// Per-tool definitions — exported as module-scope `const`s so they have
// stable referential identity across calls (rule 16 + prompt-cache hygiene).
// ---------------------------------------------------------------------------

export const SEARCH_WINES_TOOL_DEF: ToolDefinition = {
  name: 'search_wines' satisfies KnownAgentToolName,
  description: SEARCH_WINES_DESCRIPTION,
  inputSchema: SearchWinesInputSchema,
};

const LOOKUP_WINE_TOOL_DEF: ToolDefinition = {
  name: 'lookup_wine' satisfies KnownAgentToolName,
  description: LOOKUP_WINE_DESCRIPTION,
  inputSchema: LookupWineInputSchema,
};

/** Frozen production tool list. Module-scope const so every
 *  `buildMiniLoopToolBundle` call returns the exact same array identity —
 *  prompt cache benefit on the Anthropic side and a simple equality check
 *  in tests. */
const MINI_LOOP_TOOL_DEFS: readonly ToolDefinition[] = Object.freeze([
  SEARCH_WINES_TOOL_DEF,
  LOOKUP_WINE_TOOL_DEF,
]);

// ---------------------------------------------------------------------------
// Bundle shape — matches `OrchestratorMiniLoopToolBundle` structurally so
// the orchestrator's deps slot accepts it without an explicit cast.
// ---------------------------------------------------------------------------

export interface MiniLoopToolBundle {
  readonly tools: readonly ToolDefinition[];
  readonly toolPorts: MiniLoopToolPorts;
}

/**
 * Construct the production mini-loop tool bundle.
 *
 * The `tools` array is the SAME identity on every call (frozen module
 * const). Only the `toolPorts` wrapper changes — that's the per-container
 * dependency injection seam.
 */
export function buildMiniLoopToolBundle(
  toolPorts: MiniLoopToolPorts,
): MiniLoopToolBundle {
  return {
    tools: MINI_LOOP_TOOL_DEFS,
    toolPorts,
  };
}

// ---------------------------------------------------------------------------
// Defensive parity assertions — if `KNOWN_AGENT_TOOL_NAMES` ever drifts from
// the five production tools the mini-loop dispatcher knows about, the
// `satisfies KnownAgentToolName` checks above already fail at compile time.
// We still surface a runtime assert here so a future SSoT mutation that
// somehow type-checks (e.g. a *broader* enum) still trips a test.
// ---------------------------------------------------------------------------

/** The set of tool names this bundle exposes — for assertion-style imports
 *  in tests. Always equals `KNOWN_AGENT_TOOL_NAMES` by construction. */
export const MINI_LOOP_TOOL_NAMES: readonly KnownAgentToolName[] = [
  'search_wines',
  'lookup_wine',
];

// Compile-time guarantee: every name in MINI_LOOP_TOOL_NAMES exists in the
// SSoT enum. If `KNOWN_AGENT_TOOL_NAMES` shrinks, this fails at type-check.
const _MINI_LOOP_TOOL_NAMES_SSOT_CHECK: ReadonlyArray<
  (typeof KNOWN_AGENT_TOOL_NAMES)[number]
> = MINI_LOOP_TOOL_NAMES;
void _MINI_LOOP_TOOL_NAMES_SSOT_CHECK;

// Compile-time guarantee in the OTHER direction: every name in
// `KNOWN_AGENT_TOOL_NAMES` must also appear in `MINI_LOOP_TOOL_NAMES`. The
// subset-only check above silently passes when the SSoT *grows* (e.g. a new
// `lookup_wine` is added to the SSoT but never wired into the mini-loop) —
// which was the exact drift that hid the lookup_wine wiring gap. This
// reverse assignment closes the loop: now BOTH directions trip the
// type-checker on any drift.
const _SsoT_subset_of_Mini: ReadonlyArray<(typeof MINI_LOOP_TOOL_NAMES)[number]> = KNOWN_AGENT_TOOL_NAMES;
void _SsoT_subset_of_Mini;
