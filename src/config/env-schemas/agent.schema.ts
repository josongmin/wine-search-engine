import { z } from 'zod';

/**
 * Agentic multi-step search runtime (budgets, per-step timeouts, UI flag).
 */

const AGENT_MAX_STEPS_UPPER_BOUND = 10;
const DEFAULT_AGENT_MAX_STEPS = 5;
/**
 * Total agent wall-clock budget. The orchestrator checks remaining time
 * before each step (pre-flight), so steps beyond the budget are skipped.
 *
 * Arithmetic: DEFAULT_AGENT_MAX_STEPS (5) * DEFAULT_AGENT_PER_STEP_TIMEOUT_MS
 * (10 000) = 50 000 ms > this value. That is intentional — most steps finish
 * well under the per-step ceiling, and the per-step timeout is a *worst-case*
 * guard. The total timeout prevents a chain of slow steps from blocking the
 * request indefinitely.
 */
const DEFAULT_AGENT_TIMEOUT_MS = 30_000;
const DEFAULT_AGENT_PER_STEP_TIMEOUT_MS = 10_000;

export const AgentEnvSchema = z.object({
  /** Enable agentic multi-step search (requires OPENAI_API_KEY or OPENAI_API_KEYS). */
  AGENT_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  AGENT_MAX_STEPS: z.coerce
    .number()
    .int()
    .min(1)
    .max(AGENT_MAX_STEPS_UPPER_BOUND)
    .default(DEFAULT_AGENT_MAX_STEPS),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(DEFAULT_AGENT_TIMEOUT_MS),
  AGENT_PER_STEP_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_AGENT_PER_STEP_TIMEOUT_MS),

  /**
   * L1.C structural latency lever: when true, the tool execution phase may
   * short-circuit the run loop after a single tool call whose observation
   * already satisfies every contract gate. Default OFF — the bypass predicate
   * is structurally sound but in the current synthesis prompt shape it leads
   * to Layer 2 template fallbacks (the synthesized answer mentions fields
   * beyond the GROUNDING_JSON union, deterministic grounding-verify rejects,
   * re-synth fails, scorer marks `terminationReason='fallback'` → term=0.25
   * partial credit instead of full). Reconciling the predicate with grounding-
   * verify (tighter bypass OR a bypass-aware synthesis prompt) is the
   * structural fix; opt-in only until that lands. See DEFAULT_AGENT_CONFIG
   * (agent-config.ts) for the full rationale.
   */
  AGENT_FAST_ANSWER_BYPASS_PLANNER: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),

  /**
   * When true, GET /v1/agent/benchmark-scenarios returns the quick-profile scenario list.
   * When false, that route responds with 404. When unset, defaults to on in non-production.
   */
  ENABLE_AGENT_BENCHMARK_UI: z.enum(['true', 'false']).optional(),

  /**
   * P0 termination guard: when true (default), the planner is forced to issue a
   * second-step verify/synthesize action for queries with hard reasoning
   * obligations (negation, comparison, multi-constraint, situation-based,
   * nested-condition) — even if the planner attempted to commit a final answer
   * after the first tool outcome. Disabling this flag reverts to the legacy
   * "one tool + answer" path. See AgentToolExecutionPhase.run for the guard.
   */
  AGENT_REQUIRE_VERIFICATION_STEP: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('true'),
});
