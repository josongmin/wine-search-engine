import type { LearnedMatcherPort, LearnedMatcherOutput } from '../../domain/resolver/port/learned-matcher.port.js';
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
  ): Promise<readonly LearnedMatcherOutput[]> {
    if (candidates.length === 0) return [];

    const apiCandidates: MatchApiCandidate[] = candidates.map((c) => ({
      entity_id: String(c.entityId),
      canonical_label: c.canonicalLabel,
    }));

    const response = await fetch(`${this.url}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, candidates: apiCandidates }),
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
