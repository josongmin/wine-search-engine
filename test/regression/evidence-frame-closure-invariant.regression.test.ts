/**
 * ADR-009 Phase 0 follow-up invariants:
 *
 *   1. **Shape determinism (property)** — building a frame from the same
 *      inputs produces a Zod-parse-stable structure 100 times in a row.
 *   2. **Timestamp monotonicity (property)** — frames built from a
 *      monotonically non-decreasing `invokedAt` sequence preserve order.
 *   3. **toolCallId uniqueness (property)** — the canonical batch-ID
 *      builder yields distinct IDs for any (step, parallel) coordinates.
 *   4. **JSON round-trip (property)** — Zod-parse of `JSON.parse(JSON.stringify(frame))`
 *      returns a structurally equal envelope (no info loss for serializable shapes).
 *   5. **Size bound (property)** — serialized JSON length stays below a
 *      reasonable cap (validates the existing Zod observation-snapshot bound).
 *   6. **Schema strictness (property)** — frames with extra top-level keys
 *      are REJECTED (the schema chains `.strict()` — locked contract).
 *
 * Evidence-closure validator regression:
 *   - happy path (entity tokens covered by frame)
 *   - hallucination (entity token absent from all frames)
 *   - vacuous (empty answer / empty frames)
 *   - Korean entity names matched against Korean frame content
 *
 * Append-only test: never delete this file.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  TOOL_EVIDENCE_FRAME_SCHEMA_VERSION,
  TOOL_EVIDENCE_FRAME_SCHEMA_VERSION_V1_1,
  ToolCallEvidenceFrameSchema,
  type ToolCallEvidenceFrame,
  type ToolCallStructuredOutput,
} from '../../src/domain/agent/model/tool-call-evidence-frame.js';
import {
  buildToolCallEvidenceFrame,
  toolCallIdForBatchItem,
} from '../../src/domain/agent/service/build-tool-call-evidence-frame.js';
import { validateEvidenceClosure } from '../../src/domain/agent/service/evidence-closure-validator.js';

const STRUCTURED_NOOP: ToolCallStructuredOutput = { kind: 'no_op', reason: 'stub' };

/**
 * Frame size cap. observationSnapshot is bounded at 2_200 chars by Zod
 * (`OBSERVATION_SNAPSHOT_MAX_LEN`). Adding metadata overhead, the
 * serialized envelope should comfortably fit in 100_000 bytes.
 */
const FRAME_JSON_SIZE_CAP = 100_000;

describe('Property: ToolCallEvidenceFrame shape determinism', () => {
  it('same inputs → identical frame across 100 builds (Zod-stable)', () => {
    fc.assert(
      fc.property(
        fc.record({
          toolCallId: fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.length > 0),
          toolName: fc.constantFrom('search_wines', 'compare_wines', 'pair_food'),
          requestId: fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.length > 0),
          observation: fc.string({ maxLength: 200 }),
          durationMs: fc.integer({ min: 0, max: 60_000 }),
          isoTime: fc.integer({ min: 0, max: 2_000_000_000_000 }),
        }),
        (seed) => {
          const args = {
            toolCallId: seed.toolCallId,
            toolName: seed.toolName,
            requestId: seed.requestId,
            input: { q: 'opus one' } as const,
            structuredOutput: STRUCTURED_NOOP,
            observation: seed.observation,
            invokedAt: new Date(seed.isoTime),
            durationMs: seed.durationMs,
          };
          const a = buildToolCallEvidenceFrame(args);
          const b = buildToolCallEvidenceFrame(args);
          expect(a).toEqual(b);
          // Zod parse must succeed and be idempotent.
          const parsedA = ToolCallEvidenceFrameSchema.safeParse(a);
          const parsedB = ToolCallEvidenceFrameSchema.safeParse(b);
          expect(parsedA.success).toBe(true);
          expect(parsedB.success).toBe(true);
          if (parsedA.success && parsedB.success) {
            expect(parsedA.data).toEqual(parsedB.data);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property: timestamp monotonicity within a request', () => {
  it('non-decreasing invokedAt sequence yields non-decreasing frame.invokedAt', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 2_000_000_000_000 }), {
          minLength: 2,
          maxLength: 16,
        }),
        (timestamps) => {
          const sorted = [...timestamps].sort((a, b) => a - b);
          const frames = sorted.map((ts, i) =>
            buildToolCallEvidenceFrame({
              toolCallId: `req-1-s${i}`,
              toolName: 'search_wines',
              requestId: 'req-1',
              input: {},
              structuredOutput: STRUCTURED_NOOP,
              observation: 'x',
              invokedAt: new Date(ts),
              durationMs: 0,
            }),
          );
          for (let i = 1; i < frames.length; i++) {
            const prev = frames[i - 1];
            const cur = frames[i];
            // Defensive: noUncheckedIndexedAccess
            if (prev === undefined || cur === undefined) return false;
            // Lexicographic comparison on ISO-8601 strings is monotonic.
            if (prev.invokedAt > cur.invokedAt) return false;
          }
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property: toolCallId uniqueness within a step', () => {
  it('canonical batch IDs are unique for any (step, p) tuple', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.length > 0),
          fc.integer({ min: 0, max: 64 }),
          fc.integer({ min: 1, max: 64 }),
        ),
        ([requestId, stepIndex, parallelCount]) => {
          const ids = new Set<string>();
          for (let p = 0; p < parallelCount; p++) {
            ids.add(toolCallIdForBatchItem(requestId, stepIndex, p));
          }
          return ids.size === parallelCount;
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property: JSON round-trip preserves frame', () => {
  it('Zod-parse of JSON.parse(JSON.stringify(frame)) equals the original', () => {
    fc.assert(
      fc.property(
        fc.record({
          toolCallId: fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.length > 0),
          requestId: fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.length > 0),
          observation: fc.string({ maxLength: 200 }),
          durationMs: fc.integer({ min: 0, max: 60_000 }),
          isoTime: fc.integer({ min: 0, max: 2_000_000_000_000 }),
        }),
        (seed) => {
          const frame = buildToolCallEvidenceFrame({
            toolCallId: seed.toolCallId,
            toolName: 'search_wines',
            requestId: seed.requestId,
            input: { query: 'test' },
            structuredOutput: STRUCTURED_NOOP,
            observation: seed.observation,
            invokedAt: new Date(seed.isoTime),
            durationMs: seed.durationMs,
          });
          const roundTripped: unknown = JSON.parse(JSON.stringify(frame));
          const parsed = ToolCallEvidenceFrameSchema.safeParse(roundTripped);
          expect(parsed.success).toBe(true);
          if (parsed.success) {
            expect(parsed.data).toEqual(frame);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property: frame serialized size is bounded', () => {
  it(`JSON.stringify(frame).length < ${FRAME_JSON_SIZE_CAP} for in-bounds inputs`, () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 2_000 }),
        (observation) => {
          const frame = buildToolCallEvidenceFrame({
            toolCallId: 'rid-s0',
            toolName: 'search_wines',
            requestId: 'rid',
            input: { q: 'x'.repeat(100) },
            structuredOutput: STRUCTURED_NOOP,
            observation,
            invokedAt: new Date(0),
            durationMs: 0,
          });
          return JSON.stringify(frame).length < FRAME_JSON_SIZE_CAP;
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property: schema strictness rejects extra keys', () => {
  it('extra top-level keys cause Zod parse failure (.strict() contract)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 24 }).filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
        (extraKey) => {
          // Avoid colliding with real schema fields.
          const reserved = new Set([
            'frameSchemaVersion',
            'toolCallId',
            'toolName',
            'invokedAt',
            'requestId',
            'request',
            'structuredOutput',
            'observationSnapshot',
            'observationHash',
            'durationMs',
            'retryCount',
          ]);
          fc.pre(!reserved.has(extraKey));
          const frame = buildToolCallEvidenceFrame({
            toolCallId: 'rid-s0',
            toolName: 'search_wines',
            requestId: 'rid',
            input: {},
            structuredOutput: STRUCTURED_NOOP,
            observation: 'x',
            invokedAt: new Date(0),
            durationMs: 0,
          });
          const tampered = { ...frame, [extraKey]: 'unexpected' };
          const result = ToolCallEvidenceFrameSchema.safeParse(tampered);
          return !result.success;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('explicit extra key "x" is rejected (regression anchor)', () => {
    const frame = buildToolCallEvidenceFrame({
      toolCallId: 'rid-s0',
      toolName: 'search_wines',
      requestId: 'rid',
      input: {},
      structuredOutput: STRUCTURED_NOOP,
      observation: 'x',
      invokedAt: new Date(0),
      durationMs: 0,
    });
    const tampered = { ...frame, hallucinatedExtra: true };
    const parsed = ToolCallEvidenceFrameSchema.safeParse(tampered);
    expect(parsed.success).toBe(false);
  });

  it('canonical frame versions parse (v1 and v1.1)', () => {
    expect(TOOL_EVIDENCE_FRAME_SCHEMA_VERSION).toBe('tool_evidence_v1');
    expect(TOOL_EVIDENCE_FRAME_SCHEMA_VERSION_V1_1).toBe('tool_evidence_v1_1');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Evidence-closure validator
// ──────────────────────────────────────────────────────────────────────

function makeFrame(observation: string, extra?: Partial<ToolCallEvidenceFrame>): ToolCallEvidenceFrame {
  const base = buildToolCallEvidenceFrame({
    toolCallId: 'rid-s0',
    toolName: 'search_wines',
    requestId: 'rid',
    input: {},
    structuredOutput: STRUCTURED_NOOP,
    observation,
    invokedAt: new Date('2026-04-15T00:00:00Z'),
    durationMs: 0,
  });
  return { ...base, ...(extra ?? {}) };
}

describe('validateEvidenceClosure: happy path', () => {
  it('closed=true when every entity-shaped token in the answer is present in a frame', () => {
    const frame = makeFrame('Opus One 2018 was returned at $450.');
    const result = validateEvidenceClosure(
      'I recommend Opus One 2018.',
      [frame],
    );
    expect(result.closed).toBe(true);
    expect(result.hallucinations).toBeUndefined();
  });

  it('closed=true when entity name lives in structuredOutput.resultSet[].entity.canonicalLabel', () => {
    const so: ToolCallStructuredOutput = {
      kind: 'search_result_set',
      resultSet: [
        {
          entity: {
            entityId: 'wine-12345',
            canonicalLabel: 'Sassicaia',
            producer: 'Tenuta San Guido',
          },
        },
      ],
      resultCount: 1,
    };
    const frame = makeFrame('obs-text', { structuredOutput: so });
    const result = validateEvidenceClosure('Try the Sassicaia.', [frame]);
    expect(result.closed).toBe(true);
  });
});

describe('validateEvidenceClosure: hallucination detection', () => {
  it('closed=false with hallucinations listing the unsupported entity', () => {
    const frame = makeFrame('Catalog returned Opus One 2018.');
    const result = validateEvidenceClosure(
      'I recommend the Penfolds Grange.',
      [frame],
    );
    expect(result.closed).toBe(false);
    // "Penfolds" and "Grange" both absent from frame.
    expect(result.hallucinations).toBeDefined();
    expect(result.hallucinations).toEqual(
      expect.arrayContaining(['Penfolds', 'Grange']),
    );
  });

  it('closed=false when frames are empty but answer carries entity claims', () => {
    const result = validateEvidenceClosure('I recommend Opus One.', []);
    expect(result.closed).toBe(false);
    // "One" is a generic stop-word; "Opus" is the entity-shaped token.
    expect(result.hallucinations).toEqual(
      expect.arrayContaining(['Opus']),
    );
  });
});

describe('validateEvidenceClosure: vacuous cases', () => {
  it('empty answer + empty frames → closed=true', () => {
    expect(validateEvidenceClosure('', [])).toEqual({ closed: true });
  });

  it('empty answer + non-empty frames → closed=true', () => {
    const frame = makeFrame('Opus One 2018');
    expect(validateEvidenceClosure('   ', [frame])).toEqual({ closed: true });
  });

  it('answer with only punctuation / 1-char tokens → closed=true (no claims)', () => {
    const frame = makeFrame('anything');
    const result = validateEvidenceClosure('. , ! ? a b', [frame]);
    expect(result.closed).toBe(true);
  });
});

describe('validateEvidenceClosure: Korean entity names (CLAUDE.md rule 5)', () => {
  it('closed=true when Korean entity name appears in frame observation', () => {
    const frame = makeFrame('검색 결과: 오푸스 원 2018, 가격 $450');
    const result = validateEvidenceClosure('오푸스 원 2018을 추천합니다.', [frame]);
    expect(result.closed).toBe(true);
  });

  it('closed=false when Korean entity name is hallucinated', () => {
    const frame = makeFrame('검색 결과: 사시카이아 2019');
    const result = validateEvidenceClosure(
      '오푸스 원 2018을 추천합니다.',
      [frame],
    );
    expect(result.closed).toBe(false);
    expect(result.hallucinations).toBeDefined();
    // "오푸스" and "원" (≥2 chars after Hangul tokenization) should surface.
    // "2018" is also a token but is also absent from the frame here.
    expect(result.hallucinations?.length ?? 0).toBeGreaterThan(0);
  });

  it('matches Korean entity in structuredOutput.entity.canonicalLabel', () => {
    const so: ToolCallStructuredOutput = {
      kind: 'search_result_set',
      resultSet: [
        {
          entity: {
            entityId: 'wine-99',
            canonicalLabel: '사시카이아',
            producer: '테누타 산 귀도',
          },
        },
      ],
      resultCount: 1,
    };
    const frame = makeFrame('plain text obs', { structuredOutput: so });
    const result = validateEvidenceClosure('사시카이아를 추천합니다.', [frame]);
    expect(result.closed).toBe(true);
  });
});

describe('validateEvidenceClosure: adjacent regression', () => {
  it('mixed-token answer reports only the unsupported tokens', () => {
    const frame = makeFrame('Opus One 2018 from Napa Valley');
    const result = validateEvidenceClosure(
      'Opus One and Sassicaia are both great.',
      [frame],
    );
    expect(result.closed).toBe(false);
    expect(result.hallucinations).toEqual(['Sassicaia']);
  });

  it('case-insensitive matching for Latin tokens', () => {
    const frame = makeFrame('opus one returned.');
    const result = validateEvidenceClosure('OPUS ONE is great.', [frame]);
    expect(result.closed).toBe(true);
  });

  it('multi-frame answer matches if any frame supports the token', () => {
    const a = makeFrame('frame A mentions Opus');
    const b = makeFrame('frame B mentions Sassicaia');
    const result = validateEvidenceClosure(
      'Opus and Sassicaia are great.',
      [a, b],
    );
    expect(result.closed).toBe(true);
  });
});
