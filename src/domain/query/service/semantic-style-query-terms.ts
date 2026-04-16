import type { WineTypeValue } from '../model/wine-type-patterns.js';

export function renderSemanticStyleQueryTerm(style: string): string {
  switch (style) {
    case 'crowd_pleasing':
      return 'crowd pleasing';
    case 'screw_cap':
      return 'screw cap';
    case 'off_dry':
      return 'off dry';
    default:
      return style;
  }
}

interface SemanticStyleProfile {
  readonly renderedTerm: string;
  readonly genericRetrievalTerms: readonly string[];
  readonly untypedArchetypeTerms: readonly string[];
  readonly wineTypeRetrievalTerms?: Partial<Record<WineTypeValue, readonly string[]>>;
  readonly evidenceWineTypes?: readonly WineTypeValue[];
  readonly evidenceGrapeTerms?: readonly string[];
  readonly evidenceStyleTerms?: readonly string[];
}

const SEMANTIC_STYLE_PROFILES: ReadonlyMap<string, SemanticStyleProfile> = new Map([
  // Deterministic retrieval/evidence ontology for recommendation semantics.
  // Typed branches must stay branch-local: white/sparkling probes should not
  // inherit red-only archetypes like Merlot or generic red blends.
  ['approachable', {
    renderedTerm: 'approachable',
    genericRetrievalTerms: ['easy drinking'],
    untypedArchetypeTerms: ['merlot'],
    wineTypeRetrievalTerms: {
      red: ['merlot', 'pinot noir', 'grenache'],
      white: ['pinot grigio', 'riesling', 'moscato'],
      sparkling: ['prosecco', 'cava', 'cremant'],
    },
    evidenceWineTypes: ['white', 'sparkling', 'rosé'],
    evidenceGrapeTerms: ['merlot', 'pinot noir', 'grenache', 'pinot grigio', 'pinot gris', 'riesling', 'moscato'],
    evidenceStyleTerms: ['easy drinking', 'light', 'medium'],
  }],
  ['crowd_pleasing', {
    renderedTerm: 'crowd pleasing',
    genericRetrievalTerms: ['easy drinking'],
    untypedArchetypeTerms: ['merlot', 'red blend'],
    wineTypeRetrievalTerms: {
      red: ['merlot', 'red blend', 'pinot noir'],
      white: ['pinot grigio', 'sauvignon blanc', 'chardonnay'],
      sparkling: ['prosecco', 'cava', 'champagne'],
    },
    evidenceWineTypes: ['sparkling'],
    evidenceGrapeTerms: ['merlot', 'pinot noir', 'pinot grigio', 'pinot gris', 'sauvignon blanc', 'chardonnay'],
    evidenceStyleTerms: ['easy drinking', 'medium', 'red blend'],
  }],
]);

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function collectStyleHints(input: {
  readonly style?: string | undefined;
  readonly styles?: readonly string[] | undefined;
}): readonly string[] {
  return input.styles !== undefined && input.styles.length > 0
    ? [...new Set(input.styles)]
    : input.style !== undefined
      ? [input.style]
      : [];
}

export function resolveSemanticStyleEvidenceProfile(style: string): {
  readonly wineTypes: readonly WineTypeValue[];
  readonly grapeTerms: readonly string[];
  readonly styleTerms: readonly string[];
} | undefined {
  const profile = SEMANTIC_STYLE_PROFILES.get(style);
  if (profile === undefined) {
    return undefined;
  }

  return {
    wineTypes: profile.evidenceWineTypes ?? [],
    grapeTerms: unique([
      ...profile.untypedArchetypeTerms,
      ...(profile.evidenceGrapeTerms ?? []),
      ...Object.values(profile.wineTypeRetrievalTerms ?? {}).flat(),
    ]),
    styleTerms: unique([
      ...profile.genericRetrievalTerms,
      ...(profile.evidenceStyleTerms ?? []),
    ]),
  };
}

export function resolveSemanticStyleQueryTerms(input: {
  readonly style?: string | undefined;
  readonly styles?: readonly string[] | undefined;
}): readonly string[] {
  return collectStyleHints(input).map(renderSemanticStyleQueryTerm);
}

export function expandSemanticStyleRetrievalTerms(input: {
  readonly style?: string | undefined;
  readonly styles?: readonly string[] | undefined;
  readonly wineType?: WineTypeValue | undefined;
}): readonly string[] {
  const terms = new Set<string>();

  const styleHints = collectStyleHints(input);

  for (const style of styleHints) {
    const profile = SEMANTIC_STYLE_PROFILES.get(style);
    const rendered = profile?.renderedTerm ?? renderSemanticStyleQueryTerm(style);
    if (rendered.length > 0) terms.add(rendered);

    for (const genericTerm of profile?.genericRetrievalTerms ?? []) {
      if (genericTerm.length > 0) {
        terms.add(genericTerm);
      }
    }

    const archetypes = input.wineType !== undefined
      ? profile?.wineTypeRetrievalTerms?.[input.wineType]
      : profile?.untypedArchetypeTerms;
    for (const archetype of archetypes ?? []) {
      if (archetype.length > 0) {
        terms.add(archetype);
      }
    }
  }

  return [...terms];
}
