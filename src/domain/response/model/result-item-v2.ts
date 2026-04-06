/**
 * V2 response model types — inferred from Zod schemas in
 * `src/interface/http/schemas/search-response-v2.schema.ts`.
 *
 * These are the canonical TypeScript types for V2 API responses.
 * Domain and application code should import from here; HTTP schema
 * code imports from the schema file directly.
 */

export type {
  ResultItemV2Human,
  SearchResponseV2Human,
  ResultItemV2Machine,
  SearchResponseV2Machine,
  InterpretResponseV2,
} from '../../../interface/http/schemas/search-response-v2.schema.js';

/**
 * Alias kept for symmetry with V1 naming conventions.
 * `InterpretResponseV2` is the canonical name; `InterpretResultV2` is an alias
 * so domain code can reference it without importing from the HTTP layer when
 * needed.
 */
export type { InterpretResponseV2 as InterpretResultV2 } from '../../../interface/http/schemas/search-response-v2.schema.js';
