import type { NormalizedConstraint } from '../../shared/types/index.js';
import {
  extractSearchConstraints,
  krwToUsd,
} from '../../query/service/search-constraint-extractor.js';

const PRICE_CONSTRAINT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'price',
  'price_usd',
]);

export function hasStructuredPriceConstraint(
  constraints: readonly NormalizedConstraint[],
): boolean {
  return constraints.some((constraint) =>
    PRICE_CONSTRAINT_ATTRIBUTES.has(constraint.attribute)
    && constraint.soft_promotion_authority === 'allow'
  );
}

export function buildRawQueryPriceConstraints(
  rawQuery: string,
): readonly NormalizedConstraint[] {
  if (rawQuery.length === 0) {
    return [];
  }
  const extracted = extractSearchConstraints(rawQuery);
  const constraints: NormalizedConstraint[] = [];
  if (extracted.minPriceKrw !== undefined && extracted.maxPriceKrw !== undefined) {
    constraints.push({
      attribute: 'price_usd',
      operator: 'range',
      value: {
        min: krwToUsd(extracted.minPriceKrw),
        max: krwToUsd(extracted.maxPriceKrw),
      },
      source_phrase: 'raw_query_price_extractor',
      confidence: 1,
      mapping_version: 'raw-query-price-extractor-v1',
    });
    return constraints;
  }
  if (extracted.minPriceKrw !== undefined) {
    constraints.push({
      attribute: 'price_usd',
      operator: '>=',
      value: krwToUsd(extracted.minPriceKrw),
      source_phrase: 'raw_query_price_extractor',
      confidence: 1,
      mapping_version: 'raw-query-price-extractor-v1',
    });
  }
  if (extracted.maxPriceKrw !== undefined) {
    constraints.push({
      attribute: 'price_usd',
      operator: '<=',
      value: krwToUsd(extracted.maxPriceKrw),
      source_phrase: 'raw_query_price_extractor',
      confidence: 1,
      mapping_version: 'raw-query-price-extractor-v1',
    });
  }
  return constraints;
}
