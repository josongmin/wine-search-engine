/**
 * Food-pairing macro-evidence closure — single source of truth (SSoT).
 *
 * The same `collectFoodPairingMacroEvidenceAxes` / `closeFoodPairingMacroEvidence`
 * helper pair was authored independently in two places:
 *   - `src/application/agent/agent-tools.ts:1327-1437` (agent tool branch
 *     for `get_food_pairings`).
 *   - `src/application/food-pairing/food-pairing.usecase.ts:188-300`
 *     (standalone use case extracted for plan-then-execute wiring).
 *
 * Both copies are byte-identical pure functions. Drift between them would
 * silently break parity between the legacy agent loop and the new wine-search
 * orchestrator path — both routes must apply the same "lift the `pairing`
 * constraint when 2+ macro axes agree" rule on identical evidence.
 *
 * SSoT placement: the closure is application-layer logic (it consumes
 * `SearchResponseV1` and produces a structurally-equivalent response) and
 * has no domain-policy or infrastructure dependency, so it lives next to
 * `food-pairing-tool-policy.ts` under `src/application/search/`.
 *
 * Behavior parity guarantees:
 *  - pure (no IO, no shared state)
 *  - returns the input response unchanged when no pairing axes apply
 *  - lifts `pairing` from `constraints.unmet` and adds it to
 *    `constraints.matched` when {@link FOOD_PAIRING_MIN_MACRO_EVIDENCE_AXES}
 *    axes agree OR when `pairing_tags` itself agrees
 */

import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';

/**
 * Required minimum macro-evidence axes (beyond `pairing_tags` itself) for the
 * macro-evidence closure to lift the `pairing` constraint.
 *
 * Why 2: tasting-axis evidence is noisy at the individual-axis level
 * (a single matched axis can be coincidental). Requiring two independent
 * agreements significantly reduces false-positive constraint lifts.
 *
 * Domain reference: the legacy agent-tools branch carried this guard as a
 * literal `macroEvidenceAxes.length < 2`; we promote the literal to a named
 * constant (CLAUDE.md rule 15) and re-export so consumers can reason about
 * the threshold without re-reading the function body.
 */
export const FOOD_PAIRING_MIN_MACRO_EVIDENCE_AXES = 2;

/** Pairing color enum surface — re-declared here as a string union so the
 *  SSoT does not import application-layer enums and create a cycle. Mirrors
 *  `FOOD_PAIRING_COLORS` in `search-tool-contract.ts`. */
export type FoodPairingMacroColor =
  | 'red'
  | 'white'
  | 'rosé'
  | 'sparkling'
  | 'both';

/**
 * Input shape consumed by the closure. Snake-case is preserved because the
 * upstream agent tool schema and the food-pairing use case both store
 * fields in this shape — translating here would only add noise.
 */
export interface PairingEvidenceClosureInput {
  readonly color?: FoodPairingMacroColor | undefined;
  readonly styles?: readonly string[] | undefined;
  readonly pairing_tags?: readonly string[] | undefined;
  readonly sweetness_target?: number | undefined;
  readonly acidity_min?: number | undefined;
  readonly tannin_max?: number | undefined;
}

/** Style tokens that mean "sweet" or "off-dry" — both qualify a wine as a
 *  spicy-food balancer. SSoT for the spicy-heat-balance evidence axis. */
const SWEETNESS_BALANCING_STYLE_TOKENS: ReadonlySet<string> = new Set([
  'sweet',
  'off_dry',
]);

/** Pairing-tag token that signals spicy-food intent. */
const SPICY_FOOD_PAIRING_TOKEN = 'spicy_food';

export function normalizeEvidenceToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[_\s-]+/gu, '_');
}

export function hasNormalizedOverlap(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined || left.length === 0 || right.length === 0) {
    return false;
  }
  const rightSet = new Set(right.map(normalizeEvidenceToken));
  return left.some((value) => rightSet.has(normalizeEvidenceToken(value)));
}

function itemHasStyleObjectiveEvidence(
  item: SearchResponseV1['results'][number],
  styles: readonly string[] | undefined,
): boolean {
  if (styles === undefined || styles.length === 0) {
    return false;
  }
  if (item.constraints.matched.includes('style')) {
    return true;
  }
  const itemStyle = item.entity.style;
  if (itemStyle === undefined) {
    return false;
  }
  const normalizedStyle = normalizeEvidenceToken(itemStyle);
  return styles.some((style) => normalizedStyle.includes(normalizeEvidenceToken(style)));
}

export function collectFoodPairingMacroEvidenceAxes(
  item: SearchResponseV1['results'][number],
  input: PairingEvidenceClosureInput,
): readonly string[] {
  const axes: string[] = [];
  const pairingTags = input.pairing_tags?.map(normalizeEvidenceToken) ?? [];
  const hasSpicyFoodObjective = pairingTags.includes(SPICY_FOOD_PAIRING_TOKEN);
  if (hasNormalizedOverlap(item.entity.pairingTags, input.pairing_tags)) {
    axes.push('pairing_tags');
  }
  if (
    input.color !== undefined
    && input.color !== 'both'
    && item.constraints.matched.includes('wine_type')
  ) {
    axes.push('wine_type');
  }
  if (itemHasStyleObjectiveEvidence(item, input.styles)) {
    axes.push('style');
  }
  if (input.sweetness_target !== undefined && item.constraints.matched.includes('sweetness')) {
    axes.push('sweetness');
  }
  if (
    hasSpicyFoodObjective
    && input.styles?.some((style) => {
      const normalized = normalizeEvidenceToken(style);
      return SWEETNESS_BALANCING_STYLE_TOKENS.has(normalized);
    }) === true
    && item.constraints.matched.includes('sweetness')
  ) {
    axes.push('spicy_heat_balance');
  }
  if (input.acidity_min !== undefined && item.constraints.matched.includes('acidity')) {
    axes.push('acidity');
  }
  if (input.tannin_max !== undefined && item.constraints.matched.includes('tannin')) {
    axes.push('tannin');
  }
  return [...new Set(axes)];
}

export function closeFoodPairingMacroEvidence(
  response: SearchResponseV1,
  input: PairingEvidenceClosureInput,
): SearchResponseV1 {
  if (input.pairing_tags === undefined || input.pairing_tags.length === 0) {
    return response;
  }

  const results = response.results.map((item) => {
    if (
      item.constraints.matched.includes('pairing')
      || !item.constraints.unmet.includes('pairing')
    ) {
      return item;
    }
    const macroEvidenceAxes = collectFoodPairingMacroEvidenceAxes(item, input);
    if (
      macroEvidenceAxes.length < FOOD_PAIRING_MIN_MACRO_EVIDENCE_AXES
      && !macroEvidenceAxes.includes('pairing_tags')
    ) {
      return item;
    }
    return {
      ...item,
      constraints: {
        ...item.constraints,
        matched: [...new Set([...item.constraints.matched, 'pairing'])],
        unmet: item.constraints.unmet.filter((attribute) => attribute !== 'pairing'),
      },
    };
  });

  return { ...response, results };
}
