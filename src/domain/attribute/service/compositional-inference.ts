/**
 * RFC-019 Stage 5: Compositional Inference Engine
 *
 * Takes a constraint bundle and derives additional `inferred` constraints
 * from interactions between existing hard/soft constraints. These are
 * domain priors (not facts) that inform ranking and downstream reasoning
 * (e.g. RFC-018 drinking window) without over-filtering retrieval.
 *
 * Examples:
 *   {region: 'Bordeaux', wine_type: 'red'}
 *     → inferred {tannin: >=0.5, grape_family: in ['Cabernet', 'Merlot']}
 *
 *   {region: 'Burgundy', wine_type: 'red'}
 *     → inferred {grape_family: in ['Pinot']}
 *
 *   {appellation: 'Barolo'}
 *     → inferred {grape_family: in ['Nebbiolo'], tannin: >=0.6, acidity: >=0.6}
 *
 * Design constraints (RFC-019 §6.5):
 *   - Deterministic (no LLM)
 *   - Versioned provenance
 *   - Written to `inferred` bundle ONLY (never hard, never soft)
 *   - Rules are monotonic — adding more context never removes prior inferences
 */

import type {
  ConstraintBundle,
  NormalizedConstraint,
} from '../../shared/types/constraint-bundle.js';
import { canonicalJsonStringify } from '../../shared/utils/canonical-json.js';

const COMPOSITIONAL_VERSION = 'compositional-v1.0';
const COMPOSITIONAL_CONFIDENCE = 0.75;

const LEVEL_HIGH = 0.7;
const LEVEL_MED_PLUS = 0.65;
const LEVEL_MED = 0.6;
const LEVEL_MED_LOW = 0.55;

/**
 * Composition rule: examines the existing hard/soft constraints and emits
 * additional inferred constraints if the pattern matches.
 *
 * The rule is pure — it reads the bundle and returns new constraints without
 * side effects.
 */
interface CompositionRule {
  readonly id: string;
  readonly matches: (ctx: CompositionContext) => boolean;
  readonly emit: (ctx: CompositionContext) => readonly NormalizedConstraint[];
}

interface CompositionContext {
  readonly region: string | undefined;
  readonly appellation: string | undefined;
  readonly wineType: string | undefined;
  readonly country: string | undefined;
  readonly grapePrimary: string | undefined;
}

interface CompositionalInferenceOptions {
  /** Optional parser hint for implicit wine type (e.g. comparison query). */
  readonly impliedWineType?: 'red' | 'white' | 'sparkling' | undefined;
}

const COMPARISON_MARKER_PATTERN = /(?:^|[^\p{L}\p{N}])(?:vs|versus|비교)(?=$|[^\p{L}\p{N}])/u;

function normalizedStringValues(
  bundle: ConstraintBundle,
  attribute: string,
): readonly string[] {
  const values: string[] = [];
  for (const list of [bundle.hard, bundle.soft]) {
    for (const c of list) {
      if (c.attribute !== attribute || c.operator !== '=' || typeof c.value !== 'string') continue;
      values.push(c.value.toLowerCase());
    }
  }
  return values;
}

/**
 * Infer an implicit wine_type from comparison-style queries that provide
 * region+grape cues but omit explicit wine_type tokens.
 *
 * This is intentionally conservative: only known domain combinations map to
 * an implied wine type.
 */
export function inferComparisonImpliedWineType(
  bundle: ConstraintBundle,
  normalizedQuery: string,
): CompositionalInferenceOptions['impliedWineType'] {
  const hasExplicitWineType = normalizedStringValues(bundle, 'wine_type').length > 0;
  if (hasExplicitWineType || !COMPARISON_MARKER_PATTERN.test(normalizedQuery)) {
    return undefined;
  }

  const grapePrimary = new Set(normalizedStringValues(bundle, 'grape_primary'));
  const regions = new Set(normalizedStringValues(bundle, 'region'));
  const appellations = new Set(normalizedStringValues(bundle, 'appellation'));

  const hasCabernet = grapePrimary.has('cabernet sauvignon');
  const hasBordeauxOrNapaRegion = regions.has('bordeaux') || regions.has('napa valley') || regions.has('napa');
  if (hasCabernet && hasBordeauxOrNapaRegion) {
    return 'red';
  }

  const hasBaroloFamily =
    appellations.has('barolo')
    || appellations.has('barbaresco')
    || appellations.has('brunello di montalcino')
    || appellations.has('brunello');
  if (hasBaroloFamily) {
    return 'red';
  }

  return undefined;
}

/** Extracts a CompositionContext from a bundle (hard + soft). */
function extractContext(
  bundle: ConstraintBundle,
  options?: CompositionalInferenceOptions,
): CompositionContext {
  const findString = (attribute: string): string | undefined => {
    for (const list of [bundle.hard, bundle.soft]) {
      for (const c of list) {
        if (c.attribute === attribute && c.operator === '=' && typeof c.value === 'string') {
          return c.value;
        }
      }
    }
    return undefined;
  };
  return {
    region: findString('region')?.toLowerCase(),
    appellation: findString('appellation')?.toLowerCase(),
    wineType: findString('wine_type')?.toLowerCase() ?? options?.impliedWineType,
    country: findString('country')?.toLowerCase(),
    grapePrimary: findString('grape_primary'),
  };
}

function makeInferredConstraint(
  attribute: string,
  operator: NormalizedConstraint['operator'],
  value: NormalizedConstraint['value'],
  sourcePhrase: string,
): NormalizedConstraint {
  return {
    attribute,
    operator,
    value,
    source_phrase: sourcePhrase,
    confidence: COMPOSITIONAL_CONFIDENCE,
    mapping_version: COMPOSITIONAL_VERSION,
  };
}

/**
 * Rule set — each rule encodes a well-known wine-domain prior.
 *
 * Rules are deliberately conservative: they only fire when the match is
 * unambiguous. Over-inference creates noisy retrieval and distorts downstream
 * models (RFC-018).
 */
const RULES: readonly CompositionRule[] = [
  // Bordeaux red → Cabernet/Merlot family, medium-high tannin
  {
    id: 'bordeaux_red',
    matches: (ctx) => ctx.region === 'bordeaux' && ctx.wineType === 'red',
    emit: (ctx) => [
      makeInferredConstraint('grape_family', 'in', ['Cabernet', 'Merlot'], `composition(${ctx.region}+${ctx.wineType})`),
      makeInferredConstraint('tannin', '>=', LEVEL_MED_LOW, `composition(${ctx.region}+${ctx.wineType})`),
    ],
  },
  // Burgundy red → Pinot
  {
    id: 'burgundy_red',
    matches: (ctx) => ctx.region === 'burgundy' && ctx.wineType === 'red',
    emit: () => [
      makeInferredConstraint('grape_family', 'in', ['Pinot'], 'composition(burgundy+red)'),
    ],
  },
  // Burgundy white → Chardonnay
  {
    id: 'burgundy_white',
    matches: (ctx) => ctx.region === 'burgundy' && ctx.wineType === 'white',
    emit: () => [
      makeInferredConstraint('grape_primary', '=', 'Chardonnay', 'composition(burgundy+white)'),
    ],
  },
  // Napa red → Cabernet dominant, full body
  {
    id: 'napa_red',
    matches: (ctx) => (ctx.region === 'napa valley' || ctx.region === 'napa') && ctx.wineType === 'red',
    emit: () => [
      makeInferredConstraint('grape_family', 'in', ['Cabernet'], 'composition(napa+red)'),
      makeInferredConstraint('body', '>=', LEVEL_MED_PLUS, 'composition(napa+red)'),
    ],
  },
  // Barolo / Barbaresco → Nebbiolo, high tannin + high acidity
  {
    id: 'barolo',
    matches: (ctx) => ctx.appellation === 'barolo' || ctx.appellation === 'barbaresco',
    emit: (ctx) => [
      makeInferredConstraint('grape_primary', '=', 'Nebbiolo', `composition(${ctx.appellation})`),
      makeInferredConstraint('tannin', '>=', LEVEL_MED_PLUS, `composition(${ctx.appellation})`),
      makeInferredConstraint('acidity', '>=', LEVEL_MED, `composition(${ctx.appellation})`),
    ],
  },
  // Brunello di Montalcino → Sangiovese, high tannin
  {
    id: 'brunello',
    matches: (ctx) => ctx.appellation === 'brunello di montalcino' || ctx.appellation === 'brunello',
    emit: () => [
      makeInferredConstraint('grape_primary', '=', 'Sangiovese', 'composition(brunello)'),
      makeInferredConstraint('tannin', '>=', LEVEL_MED, 'composition(brunello)'),
    ],
  },
  // Champagne → traditional method, high acidity
  {
    id: 'champagne',
    matches: (ctx) => ctx.region === 'champagne' || ctx.appellation === 'champagne',
    emit: () => [
      makeInferredConstraint('wine_type', '=', 'sparkling', 'composition(champagne)'),
      makeInferredConstraint('acidity', '>=', LEVEL_HIGH, 'composition(champagne)'),
    ],
  },
  // Rioja → Tempranillo
  {
    id: 'rioja',
    matches: (ctx) => ctx.region === 'rioja',
    emit: () => [
      makeInferredConstraint('grape_primary', '=', 'Tempranillo', 'composition(rioja)'),
    ],
  },
  // Mosel → Riesling, low alcohol, high acidity
  {
    id: 'mosel',
    matches: (ctx) => ctx.region === 'mosel',
    emit: () => [
      makeInferredConstraint('grape_primary', '=', 'Riesling', 'composition(mosel)'),
      makeInferredConstraint('acidity', '>=', LEVEL_HIGH, 'composition(mosel)'),
    ],
  },
  // Marlborough → Sauvignon Blanc
  {
    id: 'marlborough',
    matches: (ctx) => ctx.region === 'marlborough',
    emit: () => [
      makeInferredConstraint('grape_primary', '=', 'Sauvignon Blanc', 'composition(marlborough)'),
    ],
  },
  // Mendoza → Malbec
  {
    id: 'mendoza',
    matches: (ctx) => ctx.region === 'mendoza',
    emit: () => [
      makeInferredConstraint('grape_primary', '=', 'Malbec', 'composition(mendoza)'),
    ],
  },
  // Barossa → Shiraz
  {
    id: 'barossa',
    matches: (ctx) => ctx.region === 'barossa valley' || ctx.region === 'barossa',
    emit: () => [
      makeInferredConstraint('grape_primary', '=', 'Syrah', 'composition(barossa)'),
      makeInferredConstraint('body', '>=', LEVEL_HIGH, 'composition(barossa)'),
    ],
  },
];

/**
 * Apply all composition rules to the bundle and return a new bundle with
 * additional inferred constraints. Hard/soft bundles are unchanged.
 */
export function applyCompositionalInference(
  bundle: ConstraintBundle,
  options?: CompositionalInferenceOptions,
): ConstraintBundle {
  const ctx = extractContext(bundle, options);

  const existingKeys = new Set<string>([
    ...bundle.hard.map(keyOf),
    ...bundle.soft.map(keyOf),
    ...bundle.inferred.map(keyOf),
  ]);

  const additions: NormalizedConstraint[] = [];
  for (const rule of RULES) {
    if (!rule.matches(ctx)) continue;
    for (const c of rule.emit(ctx)) {
      const key = keyOf(c);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      additions.push(c);
    }
  }

  if (additions.length === 0) {
    return bundle;
  }

  return {
    hard: bundle.hard,
    soft: bundle.soft,
    inferred: [...bundle.inferred, ...additions],
  };
}

function keyOf(c: NormalizedConstraint): string {
  // canonicalJsonStringify sorts object keys so range constraints
  // ({min,max} vs {max,min}) produce the same dedup key. Plain JSON.stringify
  // would key-order-depend on the original constructor and silently let
  // duplicates through. (Bugbash Round 18: determinism)
  return `${c.attribute}|${c.operator}|${canonicalJsonStringify(c.value)}`;
}
