/**
 * Embedding recipe loader (Wave 2 SOTA++).
 *
 * Loads + Zod-validates `tools/embedding-recipe/embedding-recipe-v1.json` at
 * module import time. The recipe externalises every field that contributes to
 * the dense-embedding input string, so the ETL no longer hides this contract
 * inside `buildEmbedText`.
 *
 * Cache invalidation contract: `embedding-recipe-v1.json#version` is included
 * verbatim in the produced text (as the very first token, `recipe-vN.`).
 * The semantic-summary equality check in `preparePreparedVespaFeedDocuments`
 * will then naturally miss the cache when a recipe field/weight/order changes.
 *
 * Field-weight realisation strategy: see `field_weight_strategy` in the JSON.
 * Documented (`integer_repetition_floor`) and deterministic — never random.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Resolution of the recipe JSON path
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECIPE_RELATIVE_PATH = path.join(
  '..',
  '..',
  'tools',
  'embedding-recipe',
  'embedding-recipe-v1.json',
);
export const EMBEDDING_RECIPE_PATH = path.resolve(HERE, RECIPE_RELATIVE_PATH);

// ---------------------------------------------------------------------------
// Zod schema — strict, fail-loud on unknown fields
// ---------------------------------------------------------------------------

const FieldSpecSchema = z
  .object({
    name: z.string().min(1),
    weight: z.number().finite().min(0).max(10),
    prefix: z.string().min(1).optional(),
    rationale: z.string().min(1),
  })
  .strict();

const FIELD_WEIGHT_STRATEGY_LITERAL = 'integer_repetition_floor' as const;

export const EmbeddingRecipeSchema = z
  .object({
    version: z.number().int().positive(),
    model_id: z.string().min(1),
    rationale: z.string().min(1),
    field_weight_strategy: z.literal(FIELD_WEIGHT_STRATEGY_LITERAL),
    field_weight_strategy_note: z.string().min(1),
    field_separator: z.string().min(1),
    fields: z.array(FieldSpecSchema).min(1).max(32),
    include_korean_aliases: z.boolean(),
    korean_alias_max_count: z.number().int().min(0).max(64),
    korean_alias_prefix: z.string().min(1),
    korean_alias_separator: z.string().min(1),
  })
  .strict();

export type EmbeddingRecipe = z.infer<typeof EmbeddingRecipeSchema>;
export type EmbeddingRecipeField = z.infer<typeof FieldSpecSchema>;

// ---------------------------------------------------------------------------
// Load + validate (cached at module scope — read once per process)
// ---------------------------------------------------------------------------

function readAndValidateRecipe(): EmbeddingRecipe {
  let raw: string;
  try {
    raw = fs.readFileSync(EMBEDDING_RECIPE_PATH, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `EmbeddingRecipe: failed to read ${EMBEDDING_RECIPE_PATH}: ${msg}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `EmbeddingRecipe: ${EMBEDDING_RECIPE_PATH} is not valid JSON: ${msg}`,
    );
  }
  const result = EmbeddingRecipeSchema.safeParse(parsed);
  if (!result.success) {
    const flat = result.error.errors
      .map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`)
      .join('; ');
    throw new Error(
      `EmbeddingRecipe: validation failed at ${EMBEDDING_RECIPE_PATH}: ${flat}`,
    );
  }
  return result.data;
}

let cached: EmbeddingRecipe | undefined;

export function getEmbeddingRecipe(): EmbeddingRecipe {
  if (cached === undefined) {
    cached = readAndValidateRecipe();
  }
  return cached;
}

/**
 * Test/maintenance helper: force a fresh read on the next `getEmbeddingRecipe()`
 * call. Production code never calls this; tests use it to exercise the cached
 * path explicitly.
 */
export function resetEmbeddingRecipeCacheForTests(): void {
  cached = undefined;
}

/**
 * Pure helper: parse a recipe object from an already-loaded JSON value.
 * Used by tests to exercise the Zod validator without touching disk.
 */
export function parseEmbeddingRecipe(value: unknown): EmbeddingRecipe {
  const result = EmbeddingRecipeSchema.safeParse(value);
  if (!result.success) {
    const flat = result.error.errors
      .map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`)
      .join('; ');
    throw new Error(`EmbeddingRecipe: validation failed: ${flat}`);
  }
  return result.data;
}
