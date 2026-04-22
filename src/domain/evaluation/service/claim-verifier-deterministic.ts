/**
 * Deterministic claim verifier (RFC-020).
 *
 * Verifies identity_claim and core_structured_claim categories using
 * exact/normalized/hierarchy/range matching. Zero LLM calls.
 *
 * Verification strategy per field:
 *   - canonical_label, producer: NFKC normalized string match
 *   - vintage_year: exact numeric match
 *   - region, country, appellation: hierarchy match via wine ontology
 *   - grape_primary, grapes: alias-resolved normalized match
 *   - wine_type: normalized match (rosé/rose/로제 → rosé)
 *   - price_usd, price_band: range match with tolerance
 *   - body, tannin, acidity, sweetness: range match ±0.15
 *   - critic_score_normalized: range match ±0.02
 */

import { Transliterator } from '../../alias/service/transliterator.js';
import type {
  ExtractedClaim,
  ClaimVerification,
  ClaimVerdict,
  FieldAnchor,
  MatchResult,
  WineField,
  WineStructuredField,
  RangeTolerance,
} from '../model/claim.js';
import { RANGE_TOLERANCES } from '../model/claim.js';

/** Score at/above which a match is considered full entailment. */
const ENTAILED_THRESHOLD = 0.9;
/** Region hierarchy score: direct parent match (depth 1). Lower than reverse because evidence ⊃ claim. */
const HIERARCHY_DEPTH1_SCORE = 0.7;
/** Region hierarchy score: grandparent or further (depth 2+). */
const HIERARCHY_DEPTH2_SCORE = 0.5;
/** Region hierarchy score: evidence entails claim, direct parent (depth 1). Stronger signal. */
const HIERARCHY_REVERSE_DEPTH1_SCORE = 0.95;
/** Region hierarchy score: evidence entails claim, grandparent or further. */
const HIERARCHY_REVERSE_DEPTH2_SCORE = 0.85;
/** Range match: score floor when within tolerance (prevents 0 for near-boundary hits). */
const RANGE_MATCH_SCORE_FLOOR = 0.5;
/** Range match: contribution of diff/maxDiff to score degradation (100% → only 50% penalty). */
const RANGE_MATCH_DEGRADATION = 0.5;
/** Label containment: minimum ratio of claimLen/evidenceLen for a forward containment match. */
const LABEL_CONTAINMENT_RATIO_MIN = 0.3;
/** Label containment: score floor for claim-in-evidence match. */
const LABEL_CONTAINMENT_FORWARD_FLOOR = 0.7;
/** Label containment: full entailment when only catalog decorations differ. */
const LABEL_CONTAINMENT_FULL_ENTAILMENT_RATIO = 0.85;
/** Label containment: score floor for evidence-in-claim match (weaker signal). */
const LABEL_CONTAINMENT_REVERSE_FLOOR = 0.6;
const LABEL_TOKEN_SUBSEQUENCE_FLOOR = 0.72;
const LABEL_TOKEN_SET_FLOOR = 0.65;
const LABEL_SINGLETON_TOKEN_FLOOR = 0.58;
const LABEL_SINGLETON_TOKEN_MIN_LEN = 4;
/** Score at/above which a match is considered partial entailment. */
const PARTIAL_THRESHOLD = 0.5;
const CROSS_SCRIPT_DICTIONARY_SCORE = 0.95;
import {
  regionHierarchyDepth,
  grapesEquivalent,
  resolveGrapeAlias,
  normalizeWineType,
} from './wine-ontology.js';

/**
 * Evidence record — flattened view of a single wine entity from tool observations.
 * Keys are WineStructuredField names, values are the evidence values (string or number).
 */
export type EvidenceRecord = Readonly<Record<string, string | number | readonly string[] | null | undefined>>;

function buildEvidenceAnchorSource(evidence: EvidenceRecord): FieldAnchor['source'] {
  const toolName = evidence['__source_tool_name'];
  const stepIndex = evidence['__source_step_index'];
  if (typeof toolName === 'string' && toolName.trim().length > 0) {
    return {
      type: 'tool_observation',
      stepIndex: typeof stepIndex === 'number' && Number.isInteger(stepIndex) && stepIndex >= 0
        ? stepIndex
        : 0,
      toolName,
    };
  }
  return { type: 'tool_observation', stepIndex: 0, toolName: 'search_wines' };
}

/**
 * Verify a single claim against evidence deterministically.
 *
 * Returns a ClaimVerification with the best match found across all evidence records.
 * If no evidence covers this claim's field, returns 'not_entailed'.
 */
/** For identity_claim with canonical_label field, also check these alt fields. */
const IDENTITY_FALLBACK_FIELDS = ['producer', 'canonical_label'] as const;
const IDENTITY_STRUCTURED_MISMATCH_FIELDS = [
  'region',
  'country',
  'appellation',
  'grape_primary',
  'grapes',
  'wine_type',
] as const satisfies readonly WineStructuredField[];
const GEO_CLAIM_FIELDS: ReadonlySet<string> = new Set(['region', 'country', 'appellation']);
const GEO_COMPARISON_CONCEPT_FIELDS: ReadonlySet<string> = new Set(['country', 'region', 'appellation']);
const GRAPE_CLAIM_FIELDS: ReadonlySet<string> = new Set(['grape_primary', 'grapes']);
const LABEL_SINGLETON_STOPWORDS: ReadonlySet<string> = new Set([
  'red',
  'white',
  'rose',
  'rosé',
  'wine',
  'wines',
  'blend',
  'brut',
  'reserve',
  'cuvee',
  'cuvée',
  'classic',
  'estate',
  'grand',
  'cru',
  'nv',
]);

function anchorFieldForEvidenceCheck(
  claimField: WineField,
  evidenceField: string,
): WineField {
  return evidenceField === 'price_range' ? claimField : evidenceField as WineField;
}

export function verifyDeterministic(
  claim: ExtractedClaim,
  evidenceRecords: readonly EvidenceRecord[],
): ClaimVerification {
  let bestMatch: MatchResult = { type: 'no_match', score: 0, details: 'no evidence found for field' };
  let bestAnchor: FieldAnchor | undefined;
  let sawFieldEvidence = false;
  let bestIsContradiction = false;

  for (const evidence of evidenceRecords) {
    const fieldsToCheck = fieldsToCheckForEvidence(claim, evidence);
    for (const fld of fieldsToCheck) {
      const evidenceValue = evidence[fld];
      if (evidenceValue === undefined || evidenceValue === null) continue;
      if (typeof evidenceValue === 'string' && evidenceValue.trim() === '') continue;
      if (Array.isArray(evidenceValue) && evidenceValue.length === 0) continue;

      sawFieldEvidence = true;
      const matchField = fld === 'comparison_concept' ? claim.field : fld;
      const match = matchFieldValue(matchField, claim.normalizedValue, evidenceValue);

      if (match.score > bestMatch.score) {
        bestMatch = match;
        bestIsContradiction = false;
        bestAnchor = {
          wineId: String(evidence['entity_id'] ?? evidence['canonical_label'] ?? 'unknown'),
          field: anchorFieldForEvidenceCheck(claim.field, fld),
          value: String(evidenceValue),
          source: buildEvidenceAnchorSource(evidence),
        };
      } else if (bestMatch.score === 0 && match.type === 'no_match') {
        // No positive match found yet — record this as a contradiction signal.
        // Always update both bestMatch AND bestAnchor so the explanation and
        // anchor stay aligned (mismatch in the same evidence record).
        bestIsContradiction = true;
        bestMatch = match;
        bestAnchor = {
          wineId: String(evidence['entity_id'] ?? evidence['canonical_label'] ?? 'unknown'),
          field: anchorFieldForEvidenceCheck(claim.field, fld),
          value: String(evidenceValue),
          source: buildEvidenceAnchorSource(evidence),
        };
      }
    }
  }

  const verdict: ClaimVerdict = (() => {
    if (bestMatch.score >= ENTAILED_THRESHOLD) return 'entailed';
    if (bestMatch.score >= PARTIAL_THRESHOLD) return 'partially_entailed';
    if (sawFieldEvidence && bestIsContradiction) return 'contradicted';
    return 'not_entailed';
  })();

  if (
    verdict === 'contradicted'
    && claim.category === 'identity_claim'
    && (claim.field === 'canonical_label' || claim.field === 'producer')
  ) {
    const structuredMismatch = detectStructuredIdentityMismatch(claim, evidenceRecords);
    if (structuredMismatch !== undefined) {
      return {
        claimId: claim.id,
        verdict: 'not_entailed',
        matchType: 'no_match',
        verifierUsed: 'deterministic',
        status: 'ok',
        evidenceAnchor: structuredMismatch.anchor,
        confidence: 0,
        explanation: structuredMismatch.explanation,
      };
    }
  }

  return {
    claimId: claim.id,
    verdict,
    matchType: bestMatch.type,
    verifierUsed: 'deterministic',
    status: 'ok',
    ...(bestAnchor !== undefined ? { evidenceAnchor: bestAnchor } : {}),
    confidence: bestMatch.score,
    explanation: bestMatch.details,
  };
}

function detectStructuredIdentityMismatch(
  claim: ExtractedClaim,
  evidenceRecords: readonly EvidenceRecord[],
): { readonly anchor: FieldAnchor; readonly explanation: string } | undefined {
  let best:
    | {
        readonly field: WineStructuredField;
        readonly evidenceValue: string | number | readonly string[];
        readonly evidence: EvidenceRecord;
        readonly wineId: string;
        readonly score: number;
      }
    | undefined;

  for (const evidence of evidenceRecords) {
    for (const field of IDENTITY_STRUCTURED_MISMATCH_FIELDS) {
      const evidenceValue = evidence[field];
      if (evidenceValue === undefined || evidenceValue === null) continue;
      if (typeof evidenceValue === 'string' && evidenceValue.trim() === '') continue;
      if (Array.isArray(evidenceValue) && evidenceValue.length === 0) continue;

      const match = matchFieldValue(field, claim.normalizedValue, evidenceValue);
      if (match.score < PARTIAL_THRESHOLD) continue;
      if (best === undefined || match.score > best.score) {
        best = {
          field,
          evidenceValue,
          evidence,
          wineId: String(evidence['entity_id'] ?? evidence['canonical_label'] ?? 'unknown'),
          score: match.score,
        };
      }
    }
  }

  if (best === undefined) {
    return undefined;
  }

  return {
    anchor: {
      wineId: best.wineId,
      field: best.field,
      value: String(best.evidenceValue),
      source: buildEvidenceAnchorSource(best.evidence as EvidenceRecord),
    },
    explanation:
      `identity claim "${claim.value}" matched structured field ${best.field}=` +
      `"${String(best.evidenceValue)}" rather than a wine identity`,
  };
}

function fieldsToCheckForEvidence(
  claim: ExtractedClaim,
  evidence: EvidenceRecord,
): readonly string[] {
  // For identity claims on canonical_label, search both canonical_label AND producer.
  // The agent may emit a producer name as identity claim, which should match
  // the producer field even if it's not in canonical_label.
  const fields: string[] =
    claim.category === 'identity_claim' &&
    (claim.field === 'canonical_label' || claim.field === 'producer')
      ? [...IDENTITY_FALLBACK_FIELDS]
      : [claim.field];

  if (GRAPE_CLAIM_FIELDS.has(claim.field)) {
    fields.push('grape_primary', 'grapes');
  }

  if (claim.field === 'price_usd') {
    fields.push('price_range');
  }

  const comparisonConcept = evidence['comparison_concept'];
  const comparisonConceptField = evidence['comparison_concept_field'];
  if (
    typeof comparisonConcept === 'string'
    && comparisonConcept.trim().length > 0
    && typeof comparisonConceptField === 'string'
    && !hasPrimaryComparisonConceptFieldEvidence(comparisonConceptField, evidence)
    && comparisonConceptSupportsClaimField(comparisonConceptField, claim.field)
  ) {
    fields.push('comparison_concept');
  }

  return [...new Set(fields)];
}

function hasPrimaryComparisonConceptFieldEvidence(
  comparisonConceptField: string,
  evidence: EvidenceRecord,
): boolean {
  const value = evidence[comparisonConceptField];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function comparisonConceptSupportsClaimField(
  comparisonConceptField: string,
  claimField: string,
): boolean {
  if (GEO_CLAIM_FIELDS.has(claimField)) {
    return GEO_COMPARISON_CONCEPT_FIELDS.has(comparisonConceptField);
  }
  if (GRAPE_CLAIM_FIELDS.has(claimField)) {
    return comparisonConceptField === 'grape_primary';
  }
  if (claimField === 'wine_type') {
    return comparisonConceptField === 'wine_type';
  }
  return false;
}

/**
 * Match a claim value against an evidence value for a specific field.
 */
function matchFieldValue(
  field: string,
  claimValue: string,
  evidenceValue: string | number | readonly string[],
): MatchResult {
  const claimNorm = claimValue.toLowerCase().normalize('NFKC').trim();
  if (field === 'price_range') {
    const claimNum = Number(claimNorm);
    if (!Number.isFinite(claimNum) || typeof evidenceValue !== 'string') {
      return { type: 'no_match', score: 0, details: `no match: claim="${claimNorm}", field=${field}` };
    }
    const rangeMatch = matchClaimAgainstPriceRange(claimNum, evidenceValue);
    if (rangeMatch !== undefined) {
      return rangeMatch;
    }
  }
  const evidenceNorm = Array.isArray(evidenceValue)
    ? evidenceValue.map(v => String(v).toLowerCase().normalize('NFKC').trim())
    : String(evidenceValue).toLowerCase().normalize('NFKC').trim();

  // ── Exact match ──────────────────────────────────────────────────────
  if (typeof evidenceNorm === 'string' && claimNorm === evidenceNorm) {
    return { type: 'exact_match', score: 1.0, details: `exact: "${claimNorm}"` };
  }
  if (Array.isArray(evidenceNorm) && evidenceNorm.includes(claimNorm)) {
    return { type: 'exact_match', score: 1.0, details: `exact: "${claimNorm}" found in array` };
  }

  // ── Field-specific matching ──────────────────────────────────────────
  switch (field as WineStructuredField) {
    case 'region':
    case 'country':
    case 'appellation': {
      const evStr = typeof evidenceNorm === 'string' ? evidenceNorm : evidenceNorm[0] ?? '';
      const pathSegments = evStr
        .split('/')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
      if (pathSegments.includes(claimNorm)) {
        return { type: 'exact_match', score: 1.0, details: `path segment exact: "${claimNorm}"` };
      }
      // Forward (claim more specific than evidence): evidence does NOT entail claim
      // → weaker score (partial entailment at best). E.g. claim "Pauillac", evidence "Bordeaux".
      const depth = regionHierarchyDepth(claimNorm, evStr);
      if (depth >= 0) {
        // depth 0 = exact (1.0), depth 1 = direct parent (0.7),
        // depth 2+ = grandparent or further (0.5).
        // All graduate to partially_entailed at minimum since the regions are related.
        const score = depth === 0 ? 1.0 : depth === 1 ? HIERARCHY_DEPTH1_SCORE : HIERARCHY_DEPTH2_SCORE;
        return {
          type: 'hierarchy_match',
          score,
          details: `claim "${claimNorm}" is more specific than evidence "${evStr}" (depth ${depth})`,
        };
      }
      // Reverse (claim broader than evidence): evidence DOES entail claim
      // → stronger score. E.g. claim "Bordeaux", evidence "Pauillac".
      const reverseDepth = regionHierarchyDepth(evStr, claimNorm);
      if (reverseDepth >= 0) {
        const score = reverseDepth === 1 ? HIERARCHY_REVERSE_DEPTH1_SCORE : HIERARCHY_REVERSE_DEPTH2_SCORE;
        return {
          type: 'hierarchy_match',
          score,
          details: `evidence "${evStr}" entails broader claim "${claimNorm}" (depth ${reverseDepth})`,
        };
      }
      // Substring containment as weak signal
      if (typeof evidenceNorm === 'string' && (evidenceNorm.includes(claimNorm) || claimNorm.includes(evidenceNorm))) {
        return { type: 'normalized_match', score: 0.6, details: `substring: "${claimNorm}" ↔ "${evidenceNorm}"` };
      }
      break;
    }

    case 'grape_primary':
    case 'grapes': {
      const claimCanonical = resolveGrapeAlias(claimNorm);
      if (typeof evidenceNorm === 'string') {
        if (grapesEquivalent(claimNorm, evidenceNorm)) {
          return { type: 'normalized_match', score: 1.0, details: `grape alias: "${claimNorm}" = "${evidenceNorm}" (→ ${claimCanonical})` };
        }
      }
      if (Array.isArray(evidenceNorm)) {
        for (const ev of evidenceNorm) {
          if (grapesEquivalent(claimNorm, ev)) {
            return { type: 'normalized_match', score: 1.0, details: `grape alias: "${claimNorm}" = "${ev}" (→ ${claimCanonical})` };
          }
        }
      }
      break;
    }

    case 'wine_type': {
      const evList = typeof evidenceNorm === 'string' ? [evidenceNorm] : evidenceNorm;
      const claimCanonical = normalizeWineType(claimNorm);
      for (const evStr of evList) {
        if (normalizeWineType(evStr) === claimCanonical) {
          return { type: 'normalized_match', score: 1.0, details: `wine type normalized: "${claimNorm}" = "${evStr}"` };
        }
      }
      break;
    }

    case 'vintage_year':
    case 'price_usd':
    case 'price_band_numeric':
    case 'body':
    case 'sweetness':
    case 'acidity':
    case 'tannin':
    case 'finish_length':
    case 'alcohol_pct':
    case 'critic_score_normalized':
    case 'producer_prestige':
    case 'popularity_score':
    case 'drinking_window_start':
    case 'drinking_window_end': {
      const claimNum = parseFloat(claimNorm);
      const evNum = typeof evidenceValue === 'number' ? evidenceValue : parseFloat(String(evidenceValue));
      if (!Number.isFinite(claimNum) || !Number.isFinite(evNum)) break;

      if (claimNum === evNum) {
        return { type: 'exact_match', score: 1.0, details: `numeric exact: ${claimNum}` };
      }

      const tolerance = RANGE_TOLERANCES[field as WineStructuredField];
      if (tolerance) {
        const withinRange = isWithinTolerance(claimNum, evNum, tolerance);
        if (withinRange) {
          const diff = Math.abs(claimNum - evNum);
          const maxDiff = tolerance.mode === 'fraction' ? Math.abs(evNum * tolerance.value) : tolerance.value;
          const score = maxDiff > 0 ? Math.max(RANGE_MATCH_SCORE_FLOOR, 1.0 - diff / maxDiff * RANGE_MATCH_DEGRADATION) : 1.0;
          return { type: 'range_match', score, details: `range: ${claimNum} ≈ ${evNum} (tolerance ${tolerance.mode}:${tolerance.value})` };
        }
      }
      return { type: 'no_match', score: 0, details: `numeric mismatch: claim=${claimNum}, evidence=${evNum}` };
    }

    case 'price_band': {
      // String enum: 'value' | 'mid' | 'premium' | 'luxury'
      const evList = typeof evidenceNorm === 'string' ? [evidenceNorm] : evidenceNorm;
      for (const evStr of evList) {
        if (claimNorm === evStr) {
          return { type: 'exact_match', score: 1.0, details: `price band: "${claimNorm}"` };
        }
      }
      break;
    }

    case 'canonical_label':
    case 'producer': {
      const evStr = typeof evidenceNorm === 'string' ? evidenceNorm : '';
      // Cross-script matching (Korean claim ↔ Latin evidence).
      // The agent-tools summarizer emits Latin-script canonical labels, but Korean
      // users generate Korean-script claims ("오퍼스 원 2018"). A pure normalized-
      // string match would always fail. We look up the curated Korean→Latin
      // exception dictionary in Transliterator (zero LLM cost) and substitute the
      // romanized form before the containment check. Covers the long tail of
      // well-known wines that dominate benchmark scenarios.
      let claimForMatch = claimNorm;
      let crossScriptHit = false;
      if (Transliterator.containsHangul(claimNorm)) {
        const romanized = Transliterator.romanizeWineTerm(claimNorm);
        if (romanized !== undefined) {
          claimForMatch = romanized.toLowerCase().normalize('NFKC').trim();
          crossScriptHit = true;
        }
      }

      // Cross-script dictionary hit: if the claim was romanized via the curated
      // exception dictionary AND the romanized form is contained in the evidence
      // label (either direction), this is a high-confidence identity match. We
      // emit CROSS_SCRIPT_DICTIONARY_SCORE (0.95) so the verdict becomes
      // `entailed` without needing to clear the containment ratio threshold —
      // that threshold is calibrated for noisy Latin labels and would under-score
      // a perfect dictionary hit.
      if (crossScriptHit && (evStr.includes(claimForMatch) || claimForMatch.includes(evStr))) {
        return {
          type: 'normalized_match',
          score: CROSS_SCRIPT_DICTIONARY_SCORE,
          details: `cross-script dictionary: "${claimNorm}" → "${claimForMatch}" matches "${evStr}"`,
        };
      }

      const evidenceWithoutLeadingVintage = evStr.replace(/^(?:19|20)\d{2}\s+/u, '').trim();
      if (evidenceWithoutLeadingVintage === claimForMatch) {
        return {
          type: 'normalized_match',
          score: 1.0,
          details: `claim "${claimForMatch}" matches evidence "${evStr}" after stripping leading vintage decoration`,
        };
      }

      // Substring containment for partial label matches (Latin-to-Latin path).
      // A claim like "Opus One" (8 chars) inside evidence "opus one 2015" (13 chars)
      // is a strong signal that the wine is correctly referenced even if the
      // ratio is low — the claim text appears verbatim in the canonical label.
      if (evStr.includes(claimForMatch)) {
        const ratio = claimForMatch.length / evStr.length;
        if (ratio >= LABEL_CONTAINMENT_RATIO_MIN) {
          return {
            type: 'normalized_match',
            score: ratio >= LABEL_CONTAINMENT_FULL_ENTAILMENT_RATIO
              ? ENTAILED_THRESHOLD
              : Math.max(LABEL_CONTAINMENT_FORWARD_FLOOR, ratio),
            details: `claim "${claimForMatch}" contained in evidence "${evStr}"`,
          };
        }
      }
      if (claimForMatch.includes(evStr) && evStr.length > 0) {
        const ratio = evStr.length / claimForMatch.length;
        if (ratio >= LABEL_CONTAINMENT_RATIO_MIN) {
          return {
            type: 'normalized_match',
            score: Math.max(LABEL_CONTAINMENT_REVERSE_FLOOR, ratio),
            details: `evidence "${evStr}" contained in claim "${claimForMatch}"`,
          };
        }
      }
      const tokenCoverageMatch = matchLabelTokenCoverage(claimForMatch, evStr);
      if (tokenCoverageMatch !== undefined) {
        return tokenCoverageMatch;
      }
      break;
    }

    default:
      break;
  }

  return { type: 'no_match', score: 0, details: `no match: claim="${claimNorm}", field=${field}` };
}

function matchClaimAgainstPriceRange(
  claimUsd: number,
  priceRange: string,
): MatchResult | undefined {
  const normalized = priceRange.trim().replace(/,/gu, '');
  const usdRange = /^\$\s*([0-9]+(?:\.[0-9]+)?)\s*-\s*\$\s*([0-9]+(?:\.[0-9]+)?)$/u.exec(normalized);
  if (usdRange?.[1] !== undefined && usdRange[2] !== undefined) {
    const minUsd = Number(usdRange[1]);
    const maxUsd = Number(usdRange[2]);
    if (Number.isFinite(minUsd) && Number.isFinite(maxUsd)) {
      return claimUsd >= minUsd && claimUsd <= maxUsd
        ? { type: 'range_match', score: 1.0, details: `price ${claimUsd} within evidence range ${minUsd}-${maxUsd} USD` }
        : { type: 'no_match', score: 0, details: `price ${claimUsd} outside evidence range ${minUsd}-${maxUsd} USD` };
    }
  }

  const krwRange = /^(?:₩|)?([0-9][0-9]*)\s*원?\s*-\s*(?:₩|)?([0-9][0-9]*)\s*원?$/u.exec(normalized);
  if (krwRange?.[1] !== undefined && krwRange[2] !== undefined) {
    const minUsd = Number(krwRange[1]) / 1350;
    const maxUsd = Number(krwRange[2]) / 1350;
    if (Number.isFinite(minUsd) && Number.isFinite(maxUsd)) {
      return claimUsd >= minUsd && claimUsd <= maxUsd
        ? { type: 'range_match', score: 1.0, details: `price ${claimUsd} within evidence range ${minUsd.toFixed(2)}-${maxUsd.toFixed(2)} USD` }
        : { type: 'no_match', score: 0, details: `price ${claimUsd} outside evidence range ${minUsd.toFixed(2)}-${maxUsd.toFixed(2)} USD` };
    }
  }

  return undefined;
}

function tokenizeLabelish(value: string): readonly string[] {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !/^\d{1,4}$/u.test(token));
}

function isTokenSubsequence(
  claimTokens: readonly string[],
  evidenceTokens: readonly string[],
): boolean {
  let evidenceIndex = 0;
  for (const claimToken of claimTokens) {
    while (evidenceIndex < evidenceTokens.length && evidenceTokens[evidenceIndex] !== claimToken) {
      evidenceIndex += 1;
    }
    if (evidenceIndex >= evidenceTokens.length) {
      return false;
    }
    evidenceIndex += 1;
  }
  return true;
}

function matchLabelTokenCoverage(
  claimValue: string,
  evidenceValue: string,
): MatchResult | undefined {
  const claimTokens = tokenizeLabelish(claimValue);
  const evidenceTokens = tokenizeLabelish(evidenceValue);
  if (claimTokens.length === 0 || evidenceTokens.length === 0) {
    return undefined;
  }

  const evidenceTokenSet = new Set(evidenceTokens);
  if (!claimTokens.every((token) => evidenceTokenSet.has(token))) {
    return undefined;
  }

  if (claimTokens.length === 1) {
    const token = claimTokens[0]!;
    if (token.length < LABEL_SINGLETON_TOKEN_MIN_LEN || LABEL_SINGLETON_STOPWORDS.has(token)) {
      return undefined;
    }
    return {
      type: 'normalized_match',
      score: LABEL_SINGLETON_TOKEN_FLOOR,
      details: `identity token "${token}" matched evidence tokenization "${evidenceValue}"`,
    };
  }

  const ordered = isTokenSubsequence(claimTokens, evidenceTokens);
  return {
    type: 'normalized_match',
    score: ordered ? LABEL_TOKEN_SUBSEQUENCE_FLOOR : LABEL_TOKEN_SET_FLOOR,
    details: ordered
      ? `claim tokens "${claimTokens.join(' ')}" appear in order within evidence "${evidenceValue}"`
      : `claim tokens "${claimTokens.join(' ')}" matched evidence token set "${evidenceValue}"`,
  };
}

function isWithinTolerance(claim: number, evidence: number, tolerance: RangeTolerance): boolean {
  if (tolerance.mode === 'absolute') {
    return Math.abs(claim - evidence) <= tolerance.value;
  }
  // fraction mode
  const maxDelta = Math.abs(evidence * tolerance.value);
  return Math.abs(claim - evidence) <= maxDelta;
}
