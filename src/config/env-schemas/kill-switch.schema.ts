import { z } from 'zod';

/**
 * Kill switches / circuit-breakers for individual subsystems. Intentionally
 * kept flat (no nested transform) so operators can grep for KILL_SWITCH_*.
 */

export const KillSwitchEnvSchema = z.object({
  KILL_SWITCH_ALIAS_OVERLAY: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  KILL_SWITCH_LEARNING: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  KILL_SWITCH_DENSE_RETRIEVAL: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  /** Kill switch for LLM-based injection judge (Layer 2). Use only in emergencies. */
  KILL_SWITCH_INJECTION_JUDGE: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  /** Kill switch for query caching (Wave 4, Phase 3). */
  KILL_SWITCH_QUERY_CACHE: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
});
