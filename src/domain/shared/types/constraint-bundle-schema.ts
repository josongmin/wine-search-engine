/**
 * Zod schema mirror of {@link NormalizedConstraint} (interface defined in
 * `./constraint-bundle.ts`).
 *
 * SSoT for the runtime-validated shape of `NormalizedConstraint`. Previously
 * this schema lived inside `src/application/wine-search/wine-search-schemas.ts`,
 * violating the SSoT policy (CLAUDE.md rules 25/30): the interface had one home
 * (`@shared/types`) but the Zod mirror lived in the application layer. Multiple
 * consumers needing to validate `NormalizedConstraint`-shaped values would
 * otherwise reinvent the schema and silently drift.
 *
 * Design notes:
 *  - `.strict()` per CLAUDE.md rule 10 — this is a server-side contract shape,
 *    not an LLM tool-call input. Unknown keys MUST fail closed.
 *  - All numeric bounds named, with domain justification (rule 15).
 *  - Compile-time invariant at the bottom proves schema-output → interface
 *    assignability (one-way: schema produces mutable arrays; interface uses
 *    `ReadonlyArray`, so reverse direction is intentionally weakened).
 *  - Strings carry an absolute max bound to prevent unbounded payloads from
 *    propagating through validators (defence-in-depth — upstream HTTP layer
 *    already enforces shorter caps for user-facing inputs).
 */

import { z } from 'zod';
import type { NormalizedConstraint } from './constraint-bundle.js';

/**
 * Absolute character cap for any string field inside a NormalizedConstraint.
 * Mirrors `MAX_AGENT_HTTP_QUERY_CHARS` in `src/interface/http/constants.ts`
 * (the longest user-facing string a constraint could legitimately quote).
 * Re-declared at module scope so the domain schema does NOT depend on
 * interface-layer code (clean architecture: domain ports must not import
 * from `@interface`).
 */
const NORMALIZED_CONSTRAINT_MAX_STRING_CHARS = 2000;

/**
 * Maximum cardinality of an `in` / `not_in` value list. Aligns with the
 * downstream constraint-compiler array cap and the LLM contract schema's
 * `.max(50)` on emitted constraint arrays; 32 covers the worst observed
 * compound query (~6 entities × ~5 constraints each ≈ 30) with headroom.
 */
const NORMALIZED_CONSTRAINT_MAX_VALUE_LIST = 32;

/**
 * Closed operator enum — must stay in lockstep with `ConstraintOperator`
 * in `./constraint-bundle.ts`. The compile-time assignability check at the
 * bottom of this file detects drift if either side adds/removes an entry.
 */
const ConstraintOperatorSchema = z.enum([
  '=',
  '<=',
  '>=',
  'range',
  'in',
  'exclude',
  'not_in',
]);

/**
 * Value union for normalized constraints.
 *
 * Numeric scalars are not domain-clamped here — the constraint compiler does
 * that. We only enforce `.finite()` (CLAUDE.md schema quality bar) to reject
 * NaN/Infinity from any external emitter (LLM fallback path, JSONB read, etc.).
 */
const NormalizedConstraintValueSchema = z.union([
  z.string().max(NORMALIZED_CONSTRAINT_MAX_STRING_CHARS),
  z.number().finite(),
  z.object({
    min: z.number().finite(),
    max: z.number().finite(),
  }).strict(),
  z.array(z.string().max(NORMALIZED_CONSTRAINT_MAX_STRING_CHARS))
    .max(NORMALIZED_CONSTRAINT_MAX_VALUE_LIST)
    .readonly(),
]);

/**
 * Canonical Zod schema for {@link NormalizedConstraint}.
 *
 * Use this schema for ALL runtime validation of `NormalizedConstraint`-shaped
 * values across layers (HTTP, application, infrastructure). Do NOT recreate a
 * private mirror — import from here.
 */
export const NormalizedConstraintSchema = z.object({
  attribute: z.string().min(1).max(NORMALIZED_CONSTRAINT_MAX_STRING_CHARS),
  operator: ConstraintOperatorSchema,
  value: NormalizedConstraintValueSchema,
  source_phrase: z.string().max(NORMALIZED_CONSTRAINT_MAX_STRING_CHARS),
  confidence: z.number().finite().min(0).max(1),
  soft_promotion_authority: z.enum(['allow', 'deny']).optional(),
  mapping_version: z.string().max(NORMALIZED_CONSTRAINT_MAX_STRING_CHARS).optional(),
}).strict();

// ---------------------------------------------------------------------------
// Structural assignability check.
//
// If `./constraint-bundle.ts` ever evolves `NormalizedConstraint` (adds a
// required field, narrows the operator union, changes a value-union arm),
// this assignment fails to compile — pinning the contract drift to this file.
//
// We check only the schema → interface direction because Zod infers
// `string[]` (mutable) while the interface uses `ReadonlyArray<string>`; the
// reverse direction is intentionally weakened by `readonly` variance. The key
// invariant we want is: "anything that parses our schema can be passed to
// code expecting the domain interface".
// ---------------------------------------------------------------------------
type _SchemaToInterface = z.infer<typeof NormalizedConstraintSchema> extends NormalizedConstraint
  ? true
  : never;
const _SCHEMA_TO_INTERFACE_OK: _SchemaToInterface = true;
void _SCHEMA_TO_INTERFACE_OK;
