import { z } from 'zod';

/**
 * Accepts both number and numeric string from LLM output.
 * LLMs routinely emit "10" instead of 10 for integer fields.
 * CLAUDE.md schema quality bar: accept both types for LLM tool call inputs.
 *
 * Empty string "" must be rejected: Number("") === 0 which is finite,
 * so without the .min(1) guard the empty string silently maps to 0.
 */
export const coerceFiniteNumber = z
  .union([z.number(), z.string().min(1).transform(Number)])
  .pipe(z.number().finite());

export const coercePositiveInt = z
  .union([z.number().int(), z.string().transform((s) => parseInt(s, 10))])
  .pipe(z.number().int().positive());

export const coerceNonNegativeInt = z
  .union([z.number().int(), z.string().transform((s) => parseInt(s, 10))])
  .pipe(z.number().int().min(0));
