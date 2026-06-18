import type { CliFacadeRequestOptions } from './facade-request-options.port.js';
import type { PrimitiveSearchInput } from '../dto/search.dto.js';

/**
 * Dedicated lookup authority for the CLI (V2-only cutover). `lookup wine`
 * resolves a single canonical wine entity via the EntityLookupV2 contract — it
 * is NOT a discovery search and does NOT share the SearchFacadePort surface.
 *
 * The returned value is the V2-native 4-state result
 * (`status: resolved | ambiguous | failed | redirect_discovery`) in the
 * snake_case wire shape the CLI renders uniformly across transports:
 *  - local target  → calls EntityLookupV2UseCase directly, snake-cased to match
 *  - remote target → POST /v2/entity-lookup (already snake_case on the wire)
 */
export interface LookupFacadePort {
  lookupWine(
    input: PrimitiveSearchInput,
    options: CliFacadeRequestOptions,
  ): Promise<Record<string, unknown>>;
}
