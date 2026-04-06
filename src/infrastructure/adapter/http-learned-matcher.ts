import type {
  LearnedMatcherContext,
  LearnedMatcherPort,
  LearnedMatcherOutput,
} from '../../domain/resolver/port/learned-matcher.port.js';
import type { ResolverCandidate } from '../../domain/resolver/model/resolved-candidate.js';
import { isEntityId } from '../../domain/shared/types/index.js';

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

interface MatchApiCandidate {
  readonly entity_id: string;
  readonly canonical_label: string;
}

interface MatchApiResult {
  readonly entity_id: string;
  readonly match_probability: number;
  readonly model_id: string;
  readonly model_version: string;
  /** Optional decomposed feature vector from the model (RFC-006 §5.2). */
  readonly match_signal_vector?: readonly number[] | undefined;
}

interface MatchApiResponse {
  readonly results: readonly MatchApiResult[];
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isMatchApiResult(v: unknown): v is MatchApiResult {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  const vectorOk =
    obj['match_signal_vector'] === undefined ||
    (Array.isArray(obj['match_signal_vector']) &&
      (obj['match_signal_vector'] as unknown[]).every((x) => typeof x === 'number'));
  return (
    typeof obj['entity_id'] === 'string' &&
    typeof obj['match_probability'] === 'number' &&
    typeof obj['model_id'] === 'string' &&
    typeof obj['model_version'] === 'string' &&
    vectorOk
  );
}

function isMatchApiResponse(v: unknown): v is MatchApiResponse {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    Array.isArray(obj['results']) &&
    (obj['results'] as unknown[]).every(isMatchApiResult)
  );
}

// ---------------------------------------------------------------------------
// HttpLearnedMatcherAdapter
// ---------------------------------------------------------------------------

/**
 * HTTP adapter for a learned entity-matching service (RFC-006 §5.2).
 *
 * Expected API shape:
 *   POST {url}/match
 *   Body: { query: string, candidates: [{ entity_id, canonical_label }] }
 *   Response: { results: [{ entity_id, match_probability, model_id, model_version }] }
 */
export class HttpLearnedMatcherAdapter implements LearnedMatcherPort {
  constructor(private readonly url: string) {}

  async match(
    query: string,
    candidates: readonly ResolverCandidate[],
    context?: LearnedMatcherContext,
  ): Promise<readonly LearnedMatcherOutput[]> {
    if (candidates.length === 0) return [];

    const apiCandidates: MatchApiCandidate[] = candidates.map((c) => ({
      entity_id: String(c.entityId),
      canonical_label: c.canonicalLabel,
    }));

    const response = await fetch(`${this.url}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        candidates: apiCandidates,
        ...(context !== undefined ? { context: toApiContext(context) } : {}),
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `LearnedMatcher service failed [HTTP ${response.status}]: ${text}`,
      );
    }

    const data: unknown = await response.json();
    if (!isMatchApiResponse(data)) {
      throw new Error(
        `LearnedMatcher: unexpected response shape — ${JSON.stringify(data).slice(0, 200)}`,
      );
    }

    const outputs: LearnedMatcherOutput[] = [];
    for (const result of data.results) {
      if (!isEntityId(result.entity_id)) continue;
      outputs.push({
        entityId: result.entity_id,
        matchProbability: result.match_probability,
        modelId: result.model_id,
        modelVersion: result.model_version,
        ...(result.match_signal_vector !== undefined
          ? { matchSignalVector: result.match_signal_vector }
          : {}),
      });
    }
    return outputs;
  }
}

function toApiContext(context: LearnedMatcherContext): Record<string, unknown> {
  const candidateFeatures =
    context.candidateFeatures !== undefined
      ? Object.fromEntries(
          [...context.candidateFeatures.entries()].map(([entityId, features]) => [
            entityId,
            {
              char_ngram_overlap: features.charNgramOverlap,
              token_coverage: features.tokenCoverage,
              vintage_consistency: features.vintageConsistency,
              script_compatibility: features.scriptCompatibility,
              provenance_stage: features.provenanceStage,
              query_compact_length: features.queryCompactLength,
            },
          ]),
        )
      : undefined;

  return {
    ...(context.queryClass !== undefined ? { query_class: context.queryClass } : {}),
    ...(context.normalizedQueryViews !== undefined
      ? {
          normalized_query_views: {
            raw: context.normalizedQueryViews.raw,
            strict: context.normalizedQueryViews.strict,
            accentless: context.normalizedQueryViews.accentless,
            collapsed_whitespace: context.normalizedQueryViews.collapsedWhitespace,
            punctuation_stripped: context.normalizedQueryViews.punctuationStripped,
            compact: context.normalizedQueryViews.compact,
            vintage_canonicalized: context.normalizedQueryViews.vintageCanonicalized,
            vintage_stripped: context.normalizedQueryViews.vintageStripped,
            lookup_variants: context.normalizedQueryViews.lookupVariants,
            ...(context.normalizedQueryViews.transliterated !== undefined
              ? { transliterated: context.normalizedQueryViews.transliterated }
              : {}),
            ...(context.normalizedQueryViews.phoneticCompact !== undefined
              ? { phonetic_compact: context.normalizedQueryViews.phoneticCompact }
              : {}),
          },
        }
      : {}),
    ...(context.anchorLookupVariants !== undefined
      ? { anchor_lookup_variants: context.anchorLookupVariants }
      : {}),
    ...(context.anchorLookupStrategies !== undefined
      ? { anchor_lookup_strategies: context.anchorLookupStrategies }
      : {}),
    ...(candidateFeatures !== undefined ? { candidate_features: candidateFeatures } : {}),
  };
}
