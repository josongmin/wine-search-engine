import { OntologyNormalizer } from './ontology-normalizer.js';

const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;

const ONTOLOGY_AXES_BY_ATTRIBUTE = {
  occasion: 'occasion',
  pairing: 'pairing',
} as const;

type OntologyComparableAttribute = keyof typeof ONTOLOGY_AXES_BY_ATTRIBUTE;

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

function normalizeOntologyComparableValue(value: string) {
  // Keep this path free of worker-local module state. The normalizer is
  // stateless, so constructing it on demand is deterministic and avoids
  // cross-suite bleed through a shared singleton instance.
  return new OntologyNormalizer().normalize(value);
}

export function normalizeConstraintComparableString(
  attribute: string,
  value: string,
): string {
  if (isOntologyComparableAttribute(attribute)) {
    const normalized = normalizeOntologyComparableValue(value);
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
