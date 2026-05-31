import { KRW_PER_USD_APPROXIMATE } from '../../domain/shared/constants.js';
import type { NormalizedConstraint } from '../../domain/shared/types/index.js';
import {
  buildSearchToolStructuredFilters as buildContractSearchToolStructuredFilters,
  buildSearchToolStructuredPreferences as buildContractSearchToolStructuredPreferences,
} from './search-tool-contract.js';

type StructuredFilterInput = Parameters<typeof buildContractSearchToolStructuredFilters>[0];
type StructuredPreferenceInput = Parameters<typeof buildContractSearchToolStructuredPreferences>[0];

export interface FoodPairingToolInputLike {
  readonly food: string;
  readonly max_price?: number | undefined;
  readonly max_price_krw?: number | undefined;
  readonly color?: 'red' | 'white' | 'rosé' | 'sparkling' | 'both' | undefined;
  readonly sweetness_target?: number | undefined;
  readonly acidity_min?: number | undefined;
  readonly tannin_max?: number | undefined;
  readonly styles?: readonly string[] | undefined;
  readonly pairing_tags?: readonly string[] | undefined;
}

function buildSearchToolStructuredFilters(
  input: StructuredFilterInput,
  mappingVersion: string,
): readonly NormalizedConstraint[] {
  return buildContractSearchToolStructuredFilters(input, mappingVersion);
}

function buildSearchToolStructuredPreferences(
  input: StructuredPreferenceInput,
  mappingVersion: string,
): readonly NormalizedConstraint[] {
  return buildContractSearchToolStructuredPreferences(input, mappingVersion);
}

function resolveFoodPairingBudgetKrw(
  input: Pick<FoodPairingToolInputLike, 'max_price' | 'max_price_krw'>,
): number | undefined {
  return input.max_price_krw
    ?? (input.max_price !== undefined ? Math.round(input.max_price * KRW_PER_USD_APPROXIMATE) : undefined);
}

export function buildFoodPairingQuery(input: FoodPairingToolInputLike): string {
  const clauses = [`wine pairing for ${input.food}`];
  const budgetKrw = resolveFoodPairingBudgetKrw(input);
  if (budgetKrw !== undefined) {
    clauses.push(`${budgetKrw}원 이하`);
  }
  for (const style of input.styles ?? []) {
    clauses.push(style);
  }
  for (const tag of input.pairing_tags ?? []) {
    clauses.push(tag);
  }
  return clauses.join(', ');
}

export function buildFoodPairingFilters(
  input: FoodPairingToolInputLike,
  mappingVersion: string,
): readonly NormalizedConstraint[] {
  if (input.color === undefined || input.color === 'both') {
    return [];
  }
  return buildSearchToolStructuredFilters({
    wine_type: input.color,
  }, mappingVersion);
}

export function buildFoodPairingPreferences(
  input: FoodPairingToolInputLike,
  mappingVersion: string,
): readonly NormalizedConstraint[] {
  const maxPriceKrw = resolveFoodPairingBudgetKrw(input);
  const preferences: NormalizedConstraint[] = [
    ...buildSearchToolStructuredPreferences({
      ...(maxPriceKrw !== undefined ? { max_price_krw: maxPriceKrw } : {}),
      styles: input.styles,
    }, mappingVersion),
  ];
  if (input.sweetness_target !== undefined) {
    preferences.push({
      attribute: 'sweetness',
      operator: '=',
      value: input.sweetness_target,
      source_phrase: `sweetness_target=${input.sweetness_target}`,
      confidence: 1.0,
      soft_promotion_authority: 'allow',
      mapping_version: mappingVersion,
    });
  }
  if (input.acidity_min !== undefined) {
    preferences.push({
      attribute: 'acidity',
      operator: '>=',
      value: input.acidity_min,
      source_phrase: `acidity_min=${input.acidity_min}`,
      confidence: 1.0,
      soft_promotion_authority: 'allow',
      mapping_version: mappingVersion,
    });
  }
  if (input.tannin_max !== undefined) {
    preferences.push({
      attribute: 'tannin',
      operator: '<=',
      value: input.tannin_max,
      source_phrase: `tannin_max=${input.tannin_max}`,
      confidence: 1.0,
      soft_promotion_authority: 'allow',
      mapping_version: mappingVersion,
    });
  }
  if (input.pairing_tags !== undefined && input.pairing_tags.length > 0) {
    preferences.push({
      attribute: 'pairing',
      operator: 'in',
      value: [...input.pairing_tags],
      source_phrase: input.pairing_tags.join(', '),
      confidence: 1.0,
      soft_promotion_authority: 'allow',
      mapping_version: mappingVersion,
    });
  }
  return preferences;
}
