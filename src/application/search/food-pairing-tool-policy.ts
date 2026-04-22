import { buildSearchToolStructuredPreferences } from './search-tool-contract.js';
import type { NormalizedConstraint } from '../../domain/shared/types/index.js';

interface FoodPairingBudgetInput {
  readonly max_price?: number | undefined;
  readonly max_price_krw?: number | undefined;
}

interface FoodPairingColorInput {
  readonly color?: 'red' | 'white' | 'rosé' | 'sparkling' | 'both' | undefined;
}

interface FoodPairingTypedObjectiveInput extends FoodPairingColorInput {
  readonly sweetness_target?: number | undefined;
  readonly acidity_min?: number | undefined;
  readonly tannin_max?: number | undefined;
  readonly styles?: readonly string[] | undefined;
  readonly pairing_tags?: readonly string[] | undefined;
}

export function resolveFoodPairingBudgetKrw(
  input: FoodPairingBudgetInput,
  options: {
    readonly krwPerUsd: number;
    readonly maxPriceKrwCap: number;
  },
): number | undefined {
  if (input.max_price_krw !== undefined) {
    return input.max_price_krw;
  }
  if (input.max_price === undefined) {
    return undefined;
  }

  const converted = input.max_price * options.krwPerUsd;
  if (!Number.isFinite(converted)) {
    return undefined;
  }
  return Math.min(Math.round(converted), options.maxPriceKrwCap);
}

export function buildFoodPairingColorClause(input: FoodPairingColorInput): string {
  if (input.color === undefined || input.color === 'both') {
    return '';
  }
  return ` ${input.color} wine`;
}

function buildFoodPairingConstraint(
  attribute: string,
  operator: NormalizedConstraint['operator'],
  value: NormalizedConstraint['value'],
  sourcePhrase: string,
  mappingVersion: string,
): NormalizedConstraint {
  return {
    attribute,
    operator,
    value,
    source_phrase: sourcePhrase,
    confidence: 1.0,
    mapping_version: mappingVersion,
  };
}

export function buildFoodPairingStructuredFilters(
  input: FoodPairingColorInput,
  mappingVersion: string,
): readonly NormalizedConstraint[] {
  if (input.color === undefined || input.color === 'both') {
    return [];
  }
  return [
    buildFoodPairingConstraint(
      'wine_type',
      '=',
      input.color,
      input.color,
      mappingVersion,
    ),
  ];
}

export function buildFoodPairingStructuredPreferences(
  input: FoodPairingTypedObjectiveInput,
  mappingVersion: string,
): readonly NormalizedConstraint[] {
  const preferences: NormalizedConstraint[] = [
    ...buildSearchToolStructuredPreferences({
      ...(input.styles !== undefined ? { styles: input.styles } : {}),
    }, mappingVersion),
  ];

  if (input.sweetness_target !== undefined) {
    preferences.push(buildFoodPairingConstraint(
      'sweetness',
      '=',
      input.sweetness_target,
      `sweetness_target=${input.sweetness_target}`,
      mappingVersion,
    ));
  }
  if (input.acidity_min !== undefined) {
    preferences.push(buildFoodPairingConstraint(
      'acidity',
      '>=',
      input.acidity_min,
      `acidity_min>=${input.acidity_min}`,
      mappingVersion,
    ));
  }
  if (input.tannin_max !== undefined) {
    preferences.push(buildFoodPairingConstraint(
      'tannin',
      '<=',
      input.tannin_max,
      `tannin_max<=${input.tannin_max}`,
      mappingVersion,
    ));
  }
  if (input.pairing_tags !== undefined && input.pairing_tags.length > 0) {
    preferences.push(buildFoodPairingConstraint(
      'pairing',
      'in',
      [...input.pairing_tags],
      input.pairing_tags.join(', '),
      mappingVersion,
    ));
  }

  return preferences;
}
