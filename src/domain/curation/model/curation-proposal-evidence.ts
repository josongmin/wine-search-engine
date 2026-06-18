/**
 * Normalized evidence shapes for ops-submitted curation proposals (T-ELV2-03).
 * LLM tool schemas stay permissive; this module validates operator evidence
 * before staging writes.
 *
 * Accepts RFC-014 snake_case wire keys and legacy ops-console `note`, then
 * stores canonical camelCase domain evidence.
 */

import { z } from 'zod';

const AMBIGUITY_SEVERITIES = ['low', 'medium', 'high'] as const;
const AMBIGUITY_TYPE_MAX_LEN = 80;
const AMBIGUITY_TYPES_MAX_COUNT = 20;

const OPERATOR_SOURCE_MAX = 200;
const OPERATOR_NOTE_MAX = 500;

/** RFC-014 wire aliases → canonical domain keys (operator-note keys handled separately). */
const CURATION_EVIDENCE_WIRE_TO_DOMAIN: Readonly<Record<string, string>> = {
  source_trust: 'sourceTrust',
  alias_scope: 'aliasScope',
  ambiguity_types: 'ambiguityTypes',
};

const OPERATOR_NOTE_INPUT_KEYS = ['operatorNote', 'operator_note', 'note'] as const;

const ALIAS_DOMAIN_KEYS = new Set<string>([
  'source',
  'sourceTrust',
  'aliasScope',
  'operatorNote',
]);

const AMBIGUITY_DOMAIN_KEYS = new Set<string>([
  'source',
  'ambiguityTypes',
  'severity',
  'operatorNote',
]);

const SUPPRESSION_DOMAIN_KEYS = new Set<string>([
  'source',
  'operatorNote',
]);

export const CurationAliasEvidenceSchema = z.object({
  source: z.string().min(1).max(OPERATOR_SOURCE_MAX).optional(),
  sourceTrust: z.number().finite().min(0).max(1).optional(),
  aliasScope: z.enum(['global', 'locale_ko']).optional(),
  operatorNote: z.string().min(1).max(OPERATOR_NOTE_MAX).optional(),
}).strict();

export const CurationAmbiguityEvidenceSchema = z.object({
  source: z.string().min(1).max(OPERATOR_SOURCE_MAX).optional(),
  ambiguityTypes: z.array(z.string().min(1).max(AMBIGUITY_TYPE_MAX_LEN)).min(1).max(AMBIGUITY_TYPES_MAX_COUNT).optional(),
  severity: z.enum(AMBIGUITY_SEVERITIES).optional(),
  operatorNote: z.string().min(1).max(OPERATOR_NOTE_MAX).optional(),
}).strict();

export const CurationSuppressionEvidenceSchema = z.object({
  source: z.string().min(1).max(OPERATOR_SOURCE_MAX).optional(),
  operatorNote: z.string().min(1).max(OPERATOR_NOTE_MAX).optional(),
}).strict();

export type CurationAliasEvidence = z.infer<typeof CurationAliasEvidenceSchema>;
export type CurationAmbiguityEvidence = z.infer<typeof CurationAmbiguityEvidenceSchema>;
export type CurationSuppressionEvidence = z.infer<typeof CurationSuppressionEvidenceSchema>;

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveOperatorNoteInput(raw: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of OPERATOR_NOTE_INPUT_KEYS) {
    const trimmed = readTrimmedString(raw[key]);
    if (trimmed !== undefined) {
      return trimmed;
    }
  }
  return undefined;
}

function pickDomainEvidenceFields(
  raw: Readonly<Record<string, unknown>>,
  allowedDomainKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const canonical: Record<string, unknown> = {};

  for (const [inputKey, value] of Object.entries(raw)) {
    if (OPERATOR_NOTE_INPUT_KEYS.includes(inputKey as (typeof OPERATOR_NOTE_INPUT_KEYS)[number])) {
      continue;
    }
    const domainKey = CURATION_EVIDENCE_WIRE_TO_DOMAIN[inputKey] ?? inputKey;
    if (!allowedDomainKeys.has(domainKey)) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(canonical, domainKey)) {
      canonical[domainKey] = value;
    }
  }

  const operatorNote = resolveOperatorNoteInput(raw);
  if (operatorNote !== undefined && allowedDomainKeys.has('operatorNote')) {
    canonical['operatorNote'] = operatorNote;
  }

  return canonical;
}

/**
 * Maps wire/legacy evidence into canonical domain keys.
 * Unknown keys are dropped; operator-note precedence is camel → snake → legacy note.
 */
export function normalizeLegacyCurationEvidence(
  raw: Readonly<Record<string, unknown>>,
  allowedDomainKeys: ReadonlySet<string> = ALIAS_DOMAIN_KEYS,
): Record<string, unknown> {
  return pickDomainEvidenceFields(raw, allowedDomainKeys);
}

export function parseCurationAliasEvidence(raw: Readonly<Record<string, unknown>>): CurationAliasEvidence {
  return CurationAliasEvidenceSchema.parse(normalizeLegacyCurationEvidence(raw, ALIAS_DOMAIN_KEYS));
}

export function parseCurationAmbiguityEvidence(
  raw: Readonly<Record<string, unknown>>,
): CurationAmbiguityEvidence {
  return CurationAmbiguityEvidenceSchema.parse(normalizeLegacyCurationEvidence(raw, AMBIGUITY_DOMAIN_KEYS));
}

export function parseCurationSuppressionEvidence(
  raw: Readonly<Record<string, unknown>>,
): CurationSuppressionEvidence {
  return CurationSuppressionEvidenceSchema.parse(normalizeLegacyCurationEvidence(raw, SUPPRESSION_DOMAIN_KEYS));
}

export type CurationEvidenceKind = 'alias' | 'ambiguity' | 'suppression';

/** Canonical domain evidence for PG read paths and ETL materialization (SSoT). */
export function readCanonicalCurationEvidence(
  kind: CurationEvidenceKind,
  raw: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  switch (kind) {
    case 'alias':
      return parseCurationAliasEvidence(raw);
    case 'ambiguity':
      return parseCurationAmbiguityEvidence(raw);
    case 'suppression':
      return parseCurationSuppressionEvidence(raw);
  }
}

const CURATION_EVIDENCE_DOMAIN_TO_WIRE: Readonly<Record<string, string>> = {
  sourceTrust: 'source_trust',
  aliasScope: 'alias_scope',
  operatorNote: 'operator_note',
  ambiguityTypes: 'ambiguity_types',
};

/** RFC-014 snake_case evidence for HTTP ops responses (explicit wire boundary). */
export function wireCurationEvidenceFromDomain(
  evidence: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evidence)) {
    wire[CURATION_EVIDENCE_DOMAIN_TO_WIRE[key] ?? key] = value;
  }
  return wire;
}
