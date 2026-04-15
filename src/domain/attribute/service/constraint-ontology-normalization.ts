import { OntologyNormalizer } from './ontology-normalizer.js';

const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;

const ONTOLOGY_AXES_BY_ATTRIBUTE = {
  occasion: 'occasion',
  pairing: 'pairing',
} as const;

type OntologyComparableAttribute = keyof typeof ONTOLOGY_AXES_BY_ATTRIBUTE;

const ONTOLOGY_NORMALIZER = new OntologyNormalizer();

function normalizeFallback(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS_RE, '');
}

function isOntologyComparableAttribute(
  attribute: string,
): attribute is OntologyComparableAttribute {
  return attribute in ONTOLOGY_AXES_BY_ATTRIBUTE;
}

export function normalizeConstraintComparableString(
  attribute: string,
  value: string,
): string {
  if (isOntologyComparableAttribute(attribute)) {
    const normalized = ONTOLOGY_NORMALIZER.normalize(value);
    if (normalized !== null && normalized.axis === ONTOLOGY_AXES_BY_ATTRIBUTE[attribute]) {
      return normalized.canonicalValue;
    }
  }
  return normalizeFallback(value);
}

export function normalizeConstraintComparableArray(
  attribute: string,
  values: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const key = normalizeConstraintComparableString(attribute, value);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }

  return normalized;
}
