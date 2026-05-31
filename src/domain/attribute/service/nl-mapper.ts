import type { NormalizedConstraint } from '../../shared/types/index.js';
import { throwIfAborted } from '../../shared/cooperative-abort.js';
import type { ConstraintExtractionTrace } from '../model/constraint-extraction-trace.js';
import type { NLMapping } from '../model/nl-mapping.js';
import type { MappingTablePort } from '../port/mapping-table.port.js';
import { generateKoreanPredicateVariants } from '../../query/service/korean-predicate-variants.js';
import { DEFAULT_MAPPINGS } from './nl-mapper-vocabulary.js';
import {
  toNormalizedConstraint,
  type MapConstraintsOptions,
  type MapConstraintsResult,
} from '../model/map-constraints-result.js';

// Re-export the vocabulary projection helpers and the constraint conversion
// contracts so existing import sites (`./nl-mapper.js`) keep their public API.
export {
  DEFAULT_MAPPINGS,
  listDefaultMappingEntries,
  listDefaultEntityAliasMappings,
  type DefaultEntityAliasMapping,
} from './nl-mapper-vocabulary.js';
export {
  toNormalizedConstraint,
  type MapConstraintsResult,
  type MapConstraintsOptions,
} from '../model/map-constraints-result.js';

/**
 * Maps natural-language phrases to structured attribute constraints.
 * Implements RFC-004 §4.
 *
 * All mappings are deterministic. Same input + same version = same output.
 * Falls back to built-in default mappings when the repository has no match.
 */
export class NLMapper {
  constructor(private readonly mappingTable: MappingTablePort) {}

  /**
   * Maps a single natural-language phrase to a structured NLMapping.
   *
   * Resolution order:
   * 1. Query the mapping table repository.
   * 2. Fall back to built-in default mappings.
   *
   * @param phrase - The natural-language phrase (e.g. "묵직한").
   * @returns The mapping, or `null` if no mapping exists.
   */
  async mapPhrase(phrase: string): Promise<NLMapping | null> {
    const trimmed = phrase.trim();
    const lower = trimmed.toLowerCase();

    // 1. Check the repository (with lowercase normalisation so "Bordeaux" and
    // "bordeaux" always hit the same mapping row).
    const repoMapping = await this.mappingTable.findMapping(lower);
    if (repoMapping !== null) {
      return repoMapping;
    }

    // 2. Fall back to built-in defaults (all DEFAULT_MAPPINGS keys are lowercase).
    const builtIn = DEFAULT_MAPPINGS.get(lower);
    if (builtIn != null) {
      return builtIn;
    }

    // 3. Generate Korean predicate variants (연결형→관형형) and retry lookup.
    // e.g. "산도 높고" → try "산도 높은" which exists in DEFAULT_MAPPINGS.
    const variants = generateKoreanPredicateVariants(lower);
    for (const variant of variants) {
      // Skip the original (already tried above)
      if (variant === lower) {
        continue;
      }
      const variantRepoMapping = await this.mappingTable.findMapping(variant);
      if (variantRepoMapping !== null) {
        return variantRepoMapping;
      }
      const variantBuiltIn = DEFAULT_MAPPINGS.get(variant);
      if (variantBuiltIn != null) {
        return variantBuiltIn;
      }
    }

    return null;
  }

  /**
   * Maps multiple natural-language phrases to normalized constraints.
   * Phrases that do not match any mapping are silently skipped.
   *
   * @param phrases - Array of natural-language phrases.
   * @param options - Optional cancellation — when {@link MapConstraintsOptions.abortSignal}
   *   aborts, throws an `AbortError`-named {@link Error} (checked before each phrase).
   * @returns Constraints and a rule-table extraction trace (no LLM fields).
   */
  async mapConstraints(
    phrases: readonly string[],
    options?: MapConstraintsOptions,
  ): Promise<MapConstraintsResult> {
    throwIfAborted(options?.abortSignal, 'Constraint mapping aborted');

    const results: NormalizedConstraint[] = [];
    const seenPhrases = new Set<string>();

    for (const phrase of phrases) {
      throwIfAborted(options?.abortSignal, 'Constraint mapping aborted');
      const normalizedPhrase = phrase.trim();
      // Dedup by lowercase key so "Bordeaux" and "bordeaux" don't produce
      // duplicate constraints. mapPhrase also normalises to lowercase internally.
      const dedupKey = normalizedPhrase.toLowerCase();
      if (normalizedPhrase.length === 0 || seenPhrases.has(dedupKey)) {
        continue;
      }
      seenPhrases.add(dedupKey);
      const mapping = await this.mapPhrase(normalizedPhrase);
      if (mapping !== null) {
        results.push(toNormalizedConstraint(mapping));
      }
    }

    const source: ConstraintExtractionTrace['source'] =
      results.length > 0 ? 'rule_only' : 'fallback';
    const constraintExtraction: ConstraintExtractionTrace = {
      candidatePhraseCount: phrases.length,
      ruleTableHitCount: results.length,
      llmHitCount: 0,
      llmSkippedCount: 0,
      fallbackTriggered: results.length === 0,
      source,
      llmLatencyMs: null,
      phraseCacheHits: 0,
      phraseCacheNegativeSkipped: 0,
      phraseCacheMisses: 0,
      missedPhrases: [...seenPhrases].filter(
        (p) => !results.some((r) => r.source_phrase === p),
      ),
    };

    return { constraints: results, constraintExtraction };
  }
}
