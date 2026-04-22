/**
 * Zod validation schema for LLM-generated constraint suggestions.
 *
 * The LLM returns JSON; this schema validates the shape before
 * converting to {@link NormalizedConstraint}. Invalid items are
 * silently dropped (fail-open per RFC-004 §4).
 */

import { z } from 'zod';

/** Attributes the LLM is allowed to emit constraints for. */
export const LLM_ALLOWED_ATTRIBUTES = new Set([
  'body',
  'sweetness',
  'acidity',
  'tannin',
  'price_band',
  'occasion',
  'wine_type',
  'country',
  'region',
  'appellation',
  'grape_primary',
  'style',
  'closure',
  'critic_score',
  'producer_prestige',
  'finish_length',
  'drinking_window',
  'flavor_profile',
  'certification',
]);

/** Max values in an `in` / `exclude` operator array — wine attributes rarely exceed 20 distinct values. */
const MAX_CONSTRAINT_IN_VALUES = 50;

// CLAUDE.md Rule 10 exception: LLM-generated tool output MUST NOT use .strict().
// LLMs routinely emit extra fields (reasoning, confidence_explanation, metadata)
// and .strict() fails the entire item, silently dropping valid constraints.
// The nested range object also omits .strict() for the same reason.
export const LlmConstraintItemSchema = z.object({
  phrase: z.string().min(1),
  attribute: z.string().min(1),
  operator: z.enum(['=', '<=', '>=', 'range', 'in', 'exclude']),
  value: z.union([
    z.string(),
    z.number().finite(),
    z.object({ min: z.number().finite(), max: z.number().finite() }), // LLM output — no .strict()
    z.array(z.string()).max(MAX_CONSTRAINT_IN_VALUES),
  ]),
  confidence: z.number().finite().min(0).max(1),
});

/** Max constraints per LLM response — single query rarely needs more than 20 constraints. */
const MAX_LLM_CONSTRAINTS_PER_RESPONSE = 30;
export const LlmConstraintResponseSchema = z.array(LlmConstraintItemSchema).max(MAX_LLM_CONSTRAINTS_PER_RESPONSE);

export type LlmConstraintItem = z.infer<typeof LlmConstraintItemSchema>;
