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
  'critic_score',
  'producer_prestige',
  'finish_length',
  'drinking_window',
  'flavor_profile',
  'certification',
]);

export const LlmConstraintItemSchema = z.object({
  phrase: z.string().min(1),
  attribute: z.string().min(1),
  operator: z.enum(['=', '<=', '>=', 'range', 'in', 'exclude']),
  value: z.union([
    z.string(),
    z.number(),
    z.object({ min: z.number(), max: z.number() }),
    z.array(z.string()),
  ]),
  confidence: z.number().min(0).max(1),
});

export const LlmConstraintResponseSchema = z.array(LlmConstraintItemSchema);

export type LlmConstraintItem = z.infer<typeof LlmConstraintItemSchema>;
