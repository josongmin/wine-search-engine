import { z } from 'zod';

/**
 * Agentic multi-step search runtime (budgets, per-step timeouts, UI flag).
 */

const AGENT_MAX_STEPS_UPPER_BOUND = 10;
const DEFAULT_AGENT_MAX_STEPS = 5;
const DEFAULT_AGENT_TIMEOUT_MS = 30_000;
const DEFAULT_AGENT_PER_STEP_TIMEOUT_MS = 10_000;

export const AgentEnvSchema = z.object({
  /** Enable agentic multi-step search (requires OPENAI_API_KEY). */
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
   * When true, GET /v1/agent/benchmark-scenarios returns the quick-profile scenario list.
   * When false, that route responds with 404. When unset, defaults to on in non-production.
   */
  ENABLE_AGENT_BENCHMARK_UI: z.enum(['true', 'false']).optional(),
});
