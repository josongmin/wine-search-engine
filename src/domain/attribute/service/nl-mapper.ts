import type { NormalizedConstraint } from '../../shared/types/index.js';
import type { NLMapping } from '../model/nl-mapping.js';
import type { MappingTablePort } from '../port/mapping-table.port.js';

/**
 * Current version of the default mapping table.
 */
const DEFAULT_MAPPING_VERSION = 'v1.0';

/**
 * Default source identifier for built-in mappings.
 */
const DEFAULT_SOURCE = 'builtin_curated';

/**
 * Hardcoded default NL-to-attribute mappings for common Korean wine phrases.
 * These are deterministic: same phrase + same version = same output.
 * LLM-generated hard constraints are forbidden per RFC-004.
 */
const DEFAULT_MAPPINGS: ReadonlyMap<string, NLMapping> = new Map<string, NLMapping>([
  [
    '묵직한',
    {
      phrase: '묵직한',
      mappedAttribute: 'body',
      operator: '>=',
      value: 0.7,
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '풀바디',
    {
      phrase: '풀바디',
      mappedAttribute: 'body',
      operator: '>=',
      value: 0.7,
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '가벼운',
    {
      phrase: '가벼운',
      mappedAttribute: 'body',
      operator: '<=',
      value: 0.3,
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '라이트바디',
    {
      phrase: '라이트바디',
      mappedAttribute: 'body',
      operator: '<=',
      value: 0.3,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '달지 않은',
    {
      phrase: '달지 않은',
      mappedAttribute: 'sweetness',
      operator: '<=',
      value: 0.2,
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '드라이',
    {
      phrase: '드라이',
      mappedAttribute: 'sweetness',
      operator: '<=',
      value: 0.2,
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '달달한',
    {
      phrase: '달달한',
      mappedAttribute: 'sweetness',
      operator: '>=',
      value: 0.5,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '스위트',
    {
      phrase: '스위트',
      mappedAttribute: 'sweetness',
      operator: '>=',
      value: 0.5,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '적당히 달달한',
    {
      phrase: '적당히 달달한',
      mappedAttribute: 'sweetness',
      operator: 'range',
      value: [0.3, 0.6] as readonly [number, number],
      mappingConfidence: 0.85,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '선물용',
    {
      phrase: '선물용',
      mappedAttribute: 'occasion',
      operator: 'in',
      value: 'gift',
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '입문용',
    {
      phrase: '입문용',
      mappedAttribute: 'price_band',
      operator: '=',
      value: 'low',
      mappingConfidence: 0.85,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '데일리 와인',
    {
      phrase: '데일리 와인',
      mappedAttribute: 'price_band',
      operator: '=',
      value: 'low',
      mappingConfidence: 0.8,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '산도 높은',
    {
      phrase: '산도 높은',
      mappedAttribute: 'acidity',
      operator: '>=',
      value: 0.7,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '타닌감',
    {
      phrase: '타닌감',
      mappedAttribute: 'tannin',
      operator: '>=',
      value: 0.6,
      mappingConfidence: 0.85,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '부드러운',
    {
      phrase: '부드러운',
      mappedAttribute: 'tannin',
      operator: '<=',
      value: 0.3,
      mappingConfidence: 0.8,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '파티용',
    {
      phrase: '파티용',
      mappedAttribute: 'occasion',
      operator: 'in',
      value: 'party',
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    'drinking window',
    {
      phrase: 'drinking window',
      mappedAttribute: 'drinking_window',
      operator: '>=',
      value: 0,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    'when to drink',
    {
      phrase: 'when to drink',
      mappedAttribute: 'drinking_window',
      operator: '>=',
      value: 0,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '마실 시기',
    {
      phrase: '마실 시기',
      mappedAttribute: 'drinking_window',
      operator: '>=',
      value: 0,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '음용 시기',
    {
      phrase: '음용 시기',
      mappedAttribute: 'drinking_window',
      operator: '>=',
      value: 0,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
]);

/**
 * Converts an {@link NLMapping} to a {@link NormalizedConstraint}.
 */
export function toNormalizedConstraint(mapping: NLMapping): NormalizedConstraint {
  let constraintValue: NormalizedConstraint['value'];

  if (mapping.operator === 'range' && Array.isArray(mapping.value)) {
    const [min, max] = mapping.value as readonly [number, number];
    constraintValue = { min, max };
  } else if (mapping.operator === 'in' && typeof mapping.value === 'string') {
    constraintValue = [mapping.value];
  } else {
    constraintValue = mapping.value as string | number;
  }

  return {
    attribute: mapping.mappedAttribute,
    operator: mapping.operator,
    value: constraintValue,
    source_phrase: mapping.phrase,
    confidence: mapping.mappingConfidence,
    mapping_version: mapping.mappingVersion,
  };
}

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

    // 1. Check the repository
    const repoMapping = await this.mappingTable.findMapping(trimmed);
    if (repoMapping !== null) {
      return repoMapping;
    }

    // 2. Fall back to built-in defaults
    const builtIn = DEFAULT_MAPPINGS.get(trimmed);
    return builtIn ?? null;
  }

  /**
   * Maps multiple natural-language phrases to normalized constraints.
   * Phrases that do not match any mapping are silently skipped.
   *
   * @param phrases - Array of natural-language phrases.
   * @returns Array of normalized constraints (one per matched phrase).
   */
  async mapConstraints(
    phrases: readonly string[],
  ): Promise<NormalizedConstraint[]> {
    const results: NormalizedConstraint[] = [];

    for (const phrase of phrases) {
      const mapping = await this.mapPhrase(phrase);
      if (mapping !== null) {
        results.push(toNormalizedConstraint(mapping));
      }
    }

    return results;
  }
}
