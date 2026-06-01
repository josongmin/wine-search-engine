import { describe, it, expect } from 'vitest';
import {
  SimilarToEntityInputSchema,
  normalizeSimilarToEntityInput,
  SIMILAR_TO_ENTITY_LIMIT_MAX,
  SIMILAR_TO_ENTITY_ENTITY_ID_MAX_LEN,
  REFERENCE_SIMILARITY_TOOL_FILTER_MAPPING_VERSION,
} from '../reference-similarity-execution.js';

/**
 * RFC-021 T-PSA-01 — owner-local proof rail for the deterministic
 * reference-similarity primitive INPUT CONTRACT.
 *
 * Invariants under test:
 *  - entity_id is the ONLY anchor authority (required, trimmed, placeholder-free)
 *  - free-text anchors (query/anchor_query/anchor_name/name) and lane overrides
 *    (mode/retrieval_mode) are REJECTED by contract — not silently dropped
 *  - limit is permissive but clamped to SIMILAR_TO_ENTITY_LIMIT_MAX
 *  - structured fields compile into hard (filters) / soft (preferences) bundles
 */
describe('normalizeSimilarToEntityInput — anchor authority', () => {
  it('accepts a bare entity_id and defaults the limit to the cap', () => {
    const result = normalizeSimilarToEntityInput({ entity_id: 'opus-one-2018' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entityId).toBe('opus-one-2018');
    expect(result.clampedLimit).toBe(SIMILAR_TO_ENTITY_LIMIT_MAX);
    expect(result.filters).toEqual([]);
    expect(result.preferences).toEqual([]);
  });

  it('trims surrounding whitespace on entity_id', () => {
    const result = normalizeSimilarToEntityInput({ entity_id: '  sassicaia-2018  ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entityId).toBe('sassicaia-2018');
  });

  it('accepts a non-ASCII (Korean) canonical id slug', () => {
    const result = normalizeSimilarToEntityInput({ entity_id: '샤또-마고-2015' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entityId).toBe('샤또-마고-2015');
  });

  it('rejects a missing entity_id', () => {
    const result = normalizeSimilarToEntityInput({ limit: 5 });
    expect(result.ok).toBe(false);
  });

  it('rejects an empty / whitespace-only entity_id', () => {
    expect(normalizeSimilarToEntityInput({ entity_id: '' }).ok).toBe(false);
    expect(normalizeSimilarToEntityInput({ entity_id: '   ' }).ok).toBe(false);
  });

  it.each(['__entity__', '<entity_id>', '{{id}}', 'TBD', 'placeholder', 'unknown'])(
    'rejects placeholder entity_id %s',
    (placeholder) => {
      expect(normalizeSimilarToEntityInput({ entity_id: placeholder }).ok).toBe(false);
    },
  );

  it('rejects an entity_id longer than the max length', () => {
    const tooLong = 'x'.repeat(SIMILAR_TO_ENTITY_ENTITY_ID_MAX_LEN + 1);
    expect(normalizeSimilarToEntityInput({ entity_id: tooLong }).ok).toBe(false);
  });

  it('rejects a source-record (vivino-) id gracefully at the boundary (audit C1)', () => {
    const result = normalizeSimilarToEntityInput({ entity_id: 'vivino-51e514ec3d5684a4' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message.toLowerCase()).toContain('vivino-');
  });

  it('rejects a decorated lookup preview token (entity_id::canonical_label)', () => {
    const result = normalizeSimilarToEntityInput({
      entity_id: 'opus-one-2018::Opus One 2018',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('canonical id only');
  });

  it('accepts a canonical public id (the runtime-exposed form)', () => {
    expect(normalizeSimilarToEntityInput({ entity_id: 'opus-one-2018' }).ok).toBe(true);
    expect(normalizeSimilarToEntityInput({ entity_id: 'nx-abc123' }).ok).toBe(true);
  });
});

describe('normalizeSimilarToEntityInput — free-text anchor / lane rejection', () => {
  it.each(['query', 'anchor_query', 'anchor_name', 'name', 'mode', 'retrieval_mode'])(
    'rejects the banned anchor/lane field %s and names it in the message',
    (field) => {
      const result = normalizeSimilarToEntityInput({
        entity_id: 'opus-one-2018',
        [field]: 'opus one',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain(field);
    },
  );

  it('rejects retrieval_mode even when it carries a plausible lane value', () => {
    const result = normalizeSimilarToEntityInput({
      entity_id: 'opus-one-2018',
      retrieval_mode: 'mixed',
    });
    expect(result.ok).toBe(false);
  });

  it('tolerates extra LLM metadata keys that are NOT anchors (reasoning/confidence)', () => {
    const result = normalizeSimilarToEntityInput({
      entity_id: 'opus-one-2018',
      reasoning: 'the user asked for wines like Opus One',
      confidence: 0.9,
    });
    expect(result.ok).toBe(true);
  });
});

describe('normalizeSimilarToEntityInput — limit clamping', () => {
  it('clamps an over-cap limit down to the maximum', () => {
    const result = normalizeSimilarToEntityInput({ entity_id: 'opus-one-2018', limit: 999 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clampedLimit).toBe(SIMILAR_TO_ENTITY_LIMIT_MAX);
  });

  it('preserves a within-range limit', () => {
    const result = normalizeSimilarToEntityInput({ entity_id: 'opus-one-2018', limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clampedLimit).toBe(5);
  });

  it('accepts the exact cap value', () => {
    const result = normalizeSimilarToEntityInput({
      entity_id: 'opus-one-2018',
      limit: SIMILAR_TO_ENTITY_LIMIT_MAX,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clampedLimit).toBe(SIMILAR_TO_ENTITY_LIMIT_MAX);
  });

  it('rejects a zero / negative limit (not silently coerced)', () => {
    expect(normalizeSimilarToEntityInput({ entity_id: 'opus-one-2018', limit: 0 }).ok).toBe(false);
    expect(normalizeSimilarToEntityInput({ entity_id: 'opus-one-2018', limit: -3 }).ok).toBe(false);
  });

  it('coerces a numeric-string limit ("5") emitted by an LLM', () => {
    const result = normalizeSimilarToEntityInput({ entity_id: 'opus-one-2018', limit: '5' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clampedLimit).toBe(5);
  });
});

describe('normalizeSimilarToEntityInput — structured residual constraints', () => {
  it('compiles a price ceiling into a soft preference (anchor + price residual)', () => {
    const result = normalizeSimilarToEntityInput({
      entity_id: 'opus-one-2018',
      max_price_krw: 50_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const priceConstraint = result.preferences.find((c) => c.attribute === 'price_usd');
    expect(priceConstraint).toBeDefined();
    expect(priceConstraint?.operator).toBe('<=');
    expect(priceConstraint?.mapping_version).toBe(
      REFERENCE_SIMILARITY_TOOL_FILTER_MAPPING_VERSION,
    );
  });

  it('compiles an exact region into a hard filter', () => {
    const result = normalizeSimilarToEntityInput({
      entity_id: 'opus-one-2018',
      region: 'Bordeaux',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const regionFilter = result.filters.find((c) => c.attribute === 'region' && c.operator === '=');
    expect(regionFilter?.value).toBe('Bordeaux');
  });

  it('honours a caller-supplied mapping version override', () => {
    const result = normalizeSimilarToEntityInput(
      { entity_id: 'opus-one-2018', region: 'Napa Valley' },
      { mappingVersion: 'custom_v9' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filters.every((c) => c.mapping_version === 'custom_v9')).toBe(true);
  });

  it('rejects an inverted vintage range (vintage_min > vintage_max)', () => {
    const result = normalizeSimilarToEntityInput({
      entity_id: 'opus-one-2018',
      vintage_min: 2018,
      vintage_max: 2010,
    });
    expect(result.ok).toBe(false);
  });

  it('sanitizes null-valued optional fields instead of failing the whole call', () => {
    const result = normalizeSimilarToEntityInput({
      entity_id: 'opus-one-2018',
      limit: null,
      region: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clampedLimit).toBe(SIMILAR_TO_ENTITY_LIMIT_MAX);
  });
});

describe('SimilarToEntityInputSchema — non-object / adversarial inputs', () => {
  it('rejects a non-object input', () => {
    expect(SimilarToEntityInputSchema.safeParse('opus-one-2018').success).toBe(false);
    expect(SimilarToEntityInputSchema.safeParse(null).success).toBe(false);
    expect(SimilarToEntityInputSchema.safeParse(42).success).toBe(false);
  });

  it('rejects an array input with an actionable message (positional-array form)', () => {
    const parsed = SimilarToEntityInputSchema.safeParse(['opus-one-2018']);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((i) => i.message).join(' ')).toContain('entity_id');
  });

  it('surfaces the entity_id-required guidance for a scalar input', () => {
    const result = normalizeSimilarToEntityInput('opus-one-2018');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('entity_id');
  });
});
