import type { InferredAttribute } from '../model/inferred-attribute.js';

/**
 * Grape-based inference rules.
 * Maps lowercase grape name to inferred attributes.
 */
interface GrapeRule {
  readonly attributes: readonly InferredAttribute[];
  /** Optional region-specific overrides. Keys are lowercase region names. */
  readonly regionOverrides?: Readonly<Record<string, readonly InferredAttribute[]>>;
}

const GRAPE_RULES: ReadonlyMap<string, GrapeRule> = new Map([
  [
    'cabernet sauvignon',
    {
      attributes: [
        { attribute: 'body', value: 0.8, inferenceConfidence: 0.9, inferenceSource: 'grape_rule:cabernet_sauvignon' },
        { attribute: 'tannin', value: 0.8, inferenceConfidence: 0.85, inferenceSource: 'grape_rule:cabernet_sauvignon' },
        { attribute: 'acidity', value: 0.5, inferenceConfidence: 0.7, inferenceSource: 'grape_rule:cabernet_sauvignon' },
      ],
    },
  ],
  [
    'merlot',
    {
      attributes: [
        { attribute: 'body', value: 0.65, inferenceConfidence: 0.85, inferenceSource: 'grape_rule:merlot' },
        { attribute: 'tannin', value: 0.5, inferenceConfidence: 0.8, inferenceSource: 'grape_rule:merlot' },
      ],
    },
  ],
  [
    'pinot noir',
    {
      attributes: [
        { attribute: 'body', value: 0.45, inferenceConfidence: 0.8, inferenceSource: 'grape_rule:pinot_noir' },
        { attribute: 'tannin', value: 0.35, inferenceConfidence: 0.8, inferenceSource: 'grape_rule:pinot_noir' },
        { attribute: 'acidity', value: 0.65, inferenceConfidence: 0.75, inferenceSource: 'grape_rule:pinot_noir' },
      ],
      regionOverrides: {
        burgundy: [
          { attribute: 'body', value: 0.5, inferenceConfidence: 0.85, inferenceSource: 'grape_rule:pinot_noir+region:burgundy' },
          { attribute: 'acidity', value: 0.7, inferenceConfidence: 0.8, inferenceSource: 'grape_rule:pinot_noir+region:burgundy' },
        ],
        bourgogne: [
          { attribute: 'body', value: 0.5, inferenceConfidence: 0.85, inferenceSource: 'grape_rule:pinot_noir+region:burgundy' },
          { attribute: 'acidity', value: 0.7, inferenceConfidence: 0.8, inferenceSource: 'grape_rule:pinot_noir+region:burgundy' },
        ],
      },
    },
  ],
  [
    'chardonnay',
    {
      attributes: [
        { attribute: 'body', value: 0.55, inferenceConfidence: 0.75, inferenceSource: 'grape_rule:chardonnay' },
        { attribute: 'acidity', value: 0.55, inferenceConfidence: 0.7, inferenceSource: 'grape_rule:chardonnay' },
      ],
    },
  ],
  [
    'sauvignon blanc',
    {
      attributes: [
        { attribute: 'body', value: 0.3, inferenceConfidence: 0.85, inferenceSource: 'grape_rule:sauvignon_blanc' },
        { attribute: 'acidity', value: 0.75, inferenceConfidence: 0.85, inferenceSource: 'grape_rule:sauvignon_blanc' },
        { attribute: 'sweetness', value: 0.1, inferenceConfidence: 0.8, inferenceSource: 'grape_rule:sauvignon_blanc' },
      ],
    },
  ],
  [
    'riesling',
    {
      attributes: [
        { attribute: 'acidity', value: 0.7, inferenceConfidence: 0.9, inferenceSource: 'grape_rule:riesling' },
        { attribute: 'body', value: 0.3, inferenceConfidence: 0.7, inferenceSource: 'grape_rule:riesling' },
      ],
      regionOverrides: {
        alsace: [
          { attribute: 'sweetness', value: 0.2, inferenceConfidence: 0.7, inferenceSource: 'grape_rule:riesling+region:alsace' },
        ],
        mosel: [
          { attribute: 'sweetness', value: 0.5, inferenceConfidence: 0.65, inferenceSource: 'grape_rule:riesling+region:mosel' },
        ],
        germany: [
          { attribute: 'sweetness', value: 0.4, inferenceConfidence: 0.6, inferenceSource: 'grape_rule:riesling+region:germany' },
        ],
      },
    },
  ],
  [
    'syrah',
    {
      attributes: [
        { attribute: 'body', value: 0.75, inferenceConfidence: 0.85, inferenceSource: 'grape_rule:syrah' },
        { attribute: 'tannin', value: 0.7, inferenceConfidence: 0.8, inferenceSource: 'grape_rule:syrah' },
      ],
    },
  ],
  [
    'shiraz',
    {
      attributes: [
        { attribute: 'body', value: 0.8, inferenceConfidence: 0.85, inferenceSource: 'grape_rule:shiraz' },
        { attribute: 'tannin', value: 0.65, inferenceConfidence: 0.8, inferenceSource: 'grape_rule:shiraz' },
      ],
    },
  ],
  [
    'nebbiolo',
    {
      attributes: [
        { attribute: 'body', value: 0.7, inferenceConfidence: 0.85, inferenceSource: 'grape_rule:nebbiolo' },
        { attribute: 'tannin', value: 0.85, inferenceConfidence: 0.9, inferenceSource: 'grape_rule:nebbiolo' },
        { attribute: 'acidity', value: 0.7, inferenceConfidence: 0.8, inferenceSource: 'grape_rule:nebbiolo' },
      ],
    },
  ],
  [
    'sangiovese',
    {
      attributes: [
        { attribute: 'body', value: 0.6, inferenceConfidence: 0.8, inferenceSource: 'grape_rule:sangiovese' },
        { attribute: 'tannin', value: 0.6, inferenceConfidence: 0.8, inferenceSource: 'grape_rule:sangiovese' },
        { attribute: 'acidity', value: 0.7, inferenceConfidence: 0.85, inferenceSource: 'grape_rule:sangiovese' },
      ],
    },
  ],
  [
    'tempranillo',
    {
      attributes: [
        { attribute: 'body', value: 0.65, inferenceConfidence: 0.8, inferenceSource: 'grape_rule:tempranillo' },
        { attribute: 'tannin', value: 0.6, inferenceConfidence: 0.75, inferenceSource: 'grape_rule:tempranillo' },
      ],
    },
  ],
  [
    'grenache',
    {
      attributes: [
        { attribute: 'body', value: 0.6, inferenceConfidence: 0.75, inferenceSource: 'grape_rule:grenache' },
        { attribute: 'sweetness', value: 0.15, inferenceConfidence: 0.65, inferenceSource: 'grape_rule:grenache' },
      ],
    },
  ],
  [
    'moscato',
    {
      attributes: [
        { attribute: 'sweetness', value: 0.7, inferenceConfidence: 0.9, inferenceSource: 'grape_rule:moscato' },
        { attribute: 'body', value: 0.2, inferenceConfidence: 0.85, inferenceSource: 'grape_rule:moscato' },
        { attribute: 'acidity', value: 0.4, inferenceConfidence: 0.7, inferenceSource: 'grape_rule:moscato' },
      ],
    },
  ],
  [
    'gewurztraminer',
    {
      attributes: [
        { attribute: 'sweetness', value: 0.5, inferenceConfidence: 0.75, inferenceSource: 'grape_rule:gewurztraminer' },
        { attribute: 'body', value: 0.5, inferenceConfidence: 0.7, inferenceSource: 'grape_rule:gewurztraminer' },
        { attribute: 'acidity', value: 0.45, inferenceConfidence: 0.7, inferenceSource: 'grape_rule:gewurztraminer' },
      ],
    },
  ],
]);

/**
 * Region-based inference rules (applied when no grape data is available).
 */
const REGION_RULES: ReadonlyMap<string, readonly InferredAttribute[]> = new Map([
  [
    'sauternes',
    [
      { attribute: 'sweetness', value: 0.9, inferenceConfidence: 0.95, inferenceSource: 'region_rule:sauternes' },
      { attribute: 'body', value: 0.6, inferenceConfidence: 0.7, inferenceSource: 'region_rule:sauternes' },
    ],
  ],
  [
    'champagne',
    [
      { attribute: 'acidity', value: 0.7, inferenceConfidence: 0.85, inferenceSource: 'region_rule:champagne' },
      { attribute: 'body', value: 0.3, inferenceConfidence: 0.75, inferenceSource: 'region_rule:champagne' },
    ],
  ],
  [
    'barolo',
    [
      { attribute: 'body', value: 0.7, inferenceConfidence: 0.85, inferenceSource: 'region_rule:barolo' },
      { attribute: 'tannin', value: 0.85, inferenceConfidence: 0.9, inferenceSource: 'region_rule:barolo' },
      { attribute: 'acidity', value: 0.7, inferenceConfidence: 0.8, inferenceSource: 'region_rule:barolo' },
    ],
  ],
  [
    'bordeaux',
    [
      { attribute: 'body', value: 0.7, inferenceConfidence: 0.7, inferenceSource: 'region_rule:bordeaux' },
      { attribute: 'tannin', value: 0.65, inferenceConfidence: 0.7, inferenceSource: 'region_rule:bordeaux' },
    ],
  ],
  [
    'rioja',
    [
      { attribute: 'body', value: 0.6, inferenceConfidence: 0.75, inferenceSource: 'region_rule:rioja' },
      { attribute: 'tannin', value: 0.55, inferenceConfidence: 0.7, inferenceSource: 'region_rule:rioja' },
    ],
  ],
  [
    'beaujolais',
    [
      { attribute: 'body', value: 0.3, inferenceConfidence: 0.8, inferenceSource: 'region_rule:beaujolais' },
      { attribute: 'tannin', value: 0.2, inferenceConfidence: 0.8, inferenceSource: 'region_rule:beaujolais' },
    ],
  ],
  [
    'mosel',
    [
      { attribute: 'acidity', value: 0.75, inferenceConfidence: 0.85, inferenceSource: 'region_rule:mosel' },
      { attribute: 'sweetness', value: 0.5, inferenceConfidence: 0.6, inferenceSource: 'region_rule:mosel' },
    ],
  ],
  [
    'napa valley',
    [
      { attribute: 'body', value: 0.75, inferenceConfidence: 0.75, inferenceSource: 'region_rule:napa_valley' },
    ],
  ],
  [
    'marlborough',
    [
      { attribute: 'acidity', value: 0.75, inferenceConfidence: 0.8, inferenceSource: 'region_rule:marlborough' },
      { attribute: 'body', value: 0.25, inferenceConfidence: 0.75, inferenceSource: 'region_rule:marlborough' },
    ],
  ],
]);

/**
 * Style-based inference rules.
 */
const STYLE_RULES: ReadonlyMap<string, readonly InferredAttribute[]> = new Map([
  [
    'sparkling',
    [
      { attribute: 'acidity', value: 0.7, inferenceConfidence: 0.85, inferenceSource: 'style_rule:sparkling' },
      { attribute: 'body', value: 0.25, inferenceConfidence: 0.75, inferenceSource: 'style_rule:sparkling' },
    ],
  ],
  [
    'dessert',
    [
      { attribute: 'sweetness', value: 0.8, inferenceConfidence: 0.9, inferenceSource: 'style_rule:dessert' },
    ],
  ],
  [
    'rose',
    [
      { attribute: 'body', value: 0.3, inferenceConfidence: 0.75, inferenceSource: 'style_rule:rose' },
      { attribute: 'sweetness', value: 0.2, inferenceConfidence: 0.6, inferenceSource: 'style_rule:rose' },
    ],
  ],
]);

/**
 * Infers wine attributes from grape variety, region, and style information.
 * Implements RFC-004 §6.
 *
 * Inference priority:
 * 1. Grape rules with region-specific overrides (highest confidence).
 * 2. Grape rules without overrides.
 * 3. Region-based rules.
 * 4. Style-based rules (lowest priority, used to fill gaps).
 *
 * When multiple sources infer the same attribute, the inference with the
 * highest confidence wins.
 */
export class AttributeInferrer {
  /**
   * Infers attribute values from available context.
   *
   * @param grapes - Grape varieties (e.g. ["Cabernet Sauvignon", "Merlot"]).
   * @param region - Wine region (e.g. "Bordeaux", "Champagne").
   * @param style - Wine style (e.g. "red", "sparkling").
   * @returns Inferred attributes, deduplicated by attribute name (highest confidence wins).
   */
  infer(
    grapes?: readonly string[],
    region?: string,
    style?: string,
  ): readonly InferredAttribute[] {
    const inferenceMap = new Map<string, InferredAttribute>();

    // Helper: only insert if higher confidence than existing
    const mergeInference = (attr: InferredAttribute): void => {
      const existing = inferenceMap.get(attr.attribute);
      if (existing === undefined || attr.inferenceConfidence > existing.inferenceConfidence) {
        inferenceMap.set(attr.attribute, attr);
      }
    };

    const regionLower = region?.toLowerCase();

    // 1. Grape-based rules (highest priority)
    if (grapes !== undefined && grapes.length > 0) {
      for (const grape of grapes) {
        const grapeLower = grape.toLowerCase();
        const rule = GRAPE_RULES.get(grapeLower);
        if (rule === undefined) {
          continue;
        }

        // Check for region-specific overrides first
        if (regionLower !== undefined && rule.regionOverrides !== undefined) {
          const overrides = rule.regionOverrides[regionLower];
          if (overrides !== undefined) {
            for (const attr of overrides) {
              mergeInference(attr);
            }
          }
        }

        // Apply base grape rules (won't override region-specific if higher confidence)
        for (const attr of rule.attributes) {
          mergeInference(attr);
        }
      }
    }

    // 2. Region-based rules (fills gaps not covered by grape rules)
    if (regionLower !== undefined) {
      const regionAttrs = REGION_RULES.get(regionLower);
      if (regionAttrs !== undefined) {
        for (const attr of regionAttrs) {
          mergeInference(attr);
        }
      }
    }

    // 3. Style-based rules (lowest priority, fills remaining gaps)
    if (style !== undefined) {
      const styleLower = style.toLowerCase();
      const styleAttrs = STYLE_RULES.get(styleLower);
      if (styleAttrs !== undefined) {
        for (const attr of styleAttrs) {
          mergeInference(attr);
        }
      }
    }

    return [...inferenceMap.values()];
  }
}
