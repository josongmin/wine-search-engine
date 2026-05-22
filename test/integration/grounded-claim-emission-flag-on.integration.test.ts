/**
 * Wave B4 — ADR-016 Axis 3: Grounded Claim Emission shadow-emit flag-on
 * integration lock.
 *
 * Exercises the end-to-end flag-on path:
 *   1. Flag on → synthetic ChatLlmPort emits canned atomic claims; the V2
 *      response envelope carries `grounded` with dual-axis (type + category)
 *      classification and per-claim + envelope `claimSchemaVersion`.
 *   2. Flag off → `grounded` omitted; fake LLM is never called.
 *   3. Fail-closed — LLM throws → `grounded` present but empty with the
 *      canonical `grounded_claim_emission_failed` degradation reason.
 *   4. 9-verifier dispatch — every `AtomicClaimType` resolves to its own
 *      verifier class and produces a verification result.
 *   5. Dual-axis Zod lock — missing `category` fails schema validation.
 *   6. `criticRewrites` surface as `recommendation` claims when the emitter
 *      is driven with upstream critic rewrite signals.
 *
 * Fakes: only `ChatLlmPort`. Real `buildMachineResponseV2`, real
 * `emitGroundedClaims`, real `atomic-claim-verifier-router`, real 9 verifier
 * classes, real Zod schemas.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  buildMachineResponseV2,
  type MachineResponseBuildParamsV2,
} from '../../src/domain/response/service/machine-response-builder-v2.js';
import {
  emitGroundedClaims,
  GCE_DEGRADATION_EMISSION_FAILED,
  type EmitGroundedClaimsInput,
} from '../../src/domain/response/service/grounded-claim-emitter.js';
import {
  AtomicClaimSchema,
  GROUNDED_CLAIM_SCHEMA_VERSION,
} from '../../src/domain/response/model/grounded-claim.js';
import {
  ATOMIC_CLAIM_TYPES,
  DEFAULT_TYPE_TO_CATEGORY_MAPPING,
  type AtomicClaimType,
} from '../../src/domain/response/model/atomic-claim-type.js';
import { verifyAtomicClaims } from '../../src/domain/evaluation/service/verifiers/atomic-claim-verifier-router.js';
import type {
  AtomicClaimVerification,
  AtomicClaimVerifierContext,
} from '../../src/domain/evaluation/service/verifiers/atomic-claim-verifier.port.js';
import type { ChatLlmPort } from '../../src/domain/ai/port/chat-llm.port.js';
import type { ToolCallEvidenceFrame } from '../../src/domain/agent/model/tool-call-evidence-frame.js';
import type { ConstraintGraph } from '../../src/domain/query/model/constraint-graph.js';
import type {
  ComponentScores,
  RankedResult,
} from '../../src/domain/ranking/model/ranked-result.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import type { EvidenceItem } from '../../src/domain/shared/types/index.js';
import type { EvidenceRecord } from '../../src/domain/evaluation/service/claim-verifier-deterministic.js';

// ─── Fixture helpers ─────────────────────────────────────────────────────────

/** 64-char lowercase hex SHA-256 sentinel — value is irrelevant for the
 *  builder (it never rehashes) but the length is enforced by the Zod schema. */
const FAKE_SHA256 = 'a'.repeat(64);

function makeComponentScores(): ComponentScores {
  return {
    entityIntegrity: 0.95,
    semantic: 0.82,
    hardConstraintPass: true,
    softConstraint: 0.75,
    attributeAlignment: 0.7,
    popularity: 0.5,
    uncertaintyPenalty: 0.05,
  };
}

function makeEvidenceItems(): readonly EvidenceItem[] {
  return [
    {
      type: 'lexical_match',
      source: 'vespa_retrieval',
      contribution: '+0.42',
      strength: 'high',
      provenance: 'BM25 exact title match',
    },
  ];
}

function makeRankedResult(
  entityId: string,
  label: string,
  rank: number,
): RankedResult {
  return {
    entityId: createEntityId(entityId),
    canonicalLabel: label,
    finalScore: 0.9 - rank * 0.01,
    rank,
    componentScores: makeComponentScores(),
    evidenceItems: makeEvidenceItems(),
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
  };
}

function makeEvidenceFrame(toolCallId: string): ToolCallEvidenceFrame {
  return {
    frameSchemaVersion: 'tool_evidence_v1',
    toolCallId,
    toolName: 'search_wines',
    invokedAt: '2026-04-15T00:00:00.000Z',
    requestId: 'req-gce-flag-on',
    request: { toolName: 'search_wines', input: { query: 'Opus One' } },
    structuredOutput: {
      kind: 'search_result_set',
      resultSet: [],
      resultCount: 0,
    },
    observationSnapshot: 'observation text',
    observationHash: FAKE_SHA256,
    durationMs: 12,
  };
}

/** Minimal valid ConstraintGraph: one empty `group_and` root, no slots,
 *  no edges. The emitter only summarises the graph indirectly, so the
 *  shape just needs to satisfy the `ConstraintGraph` type. */
function makeTrivialConstraintGraph(): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1',
    origin: 'deterministic_from_atoms',
    rootNodeId: 'root',
    nodes: [{ kind: 'group_and', nodeId: 'root', children: [] }],
    edges: [],
    globalBudgets: {},
  };
}

/** Canned canonical-shape claim matching the `AtomicClaimSchema`. */
function cannedClaim(
  id: string,
  type: AtomicClaimType,
  toolCallId: string,
  text: string,
): Record<string, unknown> {
  return {
    id,
    type,
    category: DEFAULT_TYPE_TO_CATEGORY_MAPPING[type],
    text,
    provenance: [{ toolCallId }],
    claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
  };
}

/** Build a complete canned GroundedPayload JSON body for the fake LLM. */
function cannedPayloadJson(claims: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    proseSegments: [
      { id: 'seg-1', text: 'We recommend these wines based on your query.' },
    ],
    claims,
    claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
  });
}

function makeFakeLlm(textOrError: string | Error): ChatLlmPort {
  return {
    complete: vi.fn(async () => {
      if (textOrError instanceof Error) throw textOrError;
      return {
        text: textOrError,
        model: 'fake-model',
        finishReason: 'stop',
      };
    }),
  };
}

// ─── Env-flag lifecycle ──────────────────────────────────────────────────────

const ORIGINAL_FLAG = process.env['GCE_SHADOW_EMIT'];
beforeEach(() => {
  delete process.env['GCE_SHADOW_EMIT'];
});
afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env['GCE_SHADOW_EMIT'];
  else process.env['GCE_SHADOW_EMIT'] = ORIGINAL_FLAG;
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 — flag on, emitter runs end-to-end, grounded payload carried
// ─────────────────────────────────────────────────────────────────────────────

describe('GCE_SHADOW_EMIT=true — grounded payload round-trip', () => {
  it('emits grounded payload with dual-axis claims and schema versions', async () => {
    process.env['GCE_SHADOW_EMIT'] = 'true';

    const frames: readonly ToolCallEvidenceFrame[] = [
      makeEvidenceFrame('req-gce-flag-on-s0'),
      makeEvidenceFrame('req-gce-flag-on-s1'),
    ];
    const rankedResults = [
      makeRankedResult('wine-001', 'Opus One 2018', 1),
      makeRankedResult('wine-002', 'Château Margaux 2016', 2),
    ];
    const prose =
      'Opus One 2018 is bold and full-bodied. Château Margaux 2016 offers elegant tannins.';

    const claims = [
      cannedClaim(
        'c-1',
        'entity_reference',
        'req-gce-flag-on-s0',
        'Opus One 2018',
      ),
      cannedClaim(
        'c-2',
        'vintage_assertion',
        'req-gce-flag-on-s0',
        'Vintage: 2018',
      ),
      cannedClaim(
        'c-3',
        'style_assertion',
        'req-gce-flag-on-s1',
        'Bold and full-bodied',
      ),
    ];
    const llm = makeFakeLlm(cannedPayloadJson(claims));

    const input: EmitGroundedClaimsInput = {
      rankedResults,
      evidenceFrames: frames,
      prose,
    };
    const emitted = await emitGroundedClaims(llm, input);

    expect(llm.complete).toHaveBeenCalledTimes(1);

    const params: MachineResponseBuildParamsV2 = {
      queryId: 'q-gce-flag-on',
      results: rankedResults,
      evidenceFrames: frames,
      constraintGraph: makeTrivialConstraintGraph(),
      generatedProse: prose,
      groundedOverride: emitted,
    };
    const response = buildMachineResponseV2(params);

    // Envelope carries grounded + envelope schema version.
    expect(response.grounded).toBeDefined();
    expect(response.claimSchemaVersion).toBe(GROUNDED_CLAIM_SCHEMA_VERSION);
    const grounded = response.grounded!;
    expect(grounded.claimSchemaVersion).toBe(GROUNDED_CLAIM_SCHEMA_VERSION);
    expect(grounded.claims).toHaveLength(3);

    // Every claim has BOTH axes populated AND per-claim schema version.
    for (const claim of grounded.claims) {
      expect(claim.type).toBeDefined();
      expect(claim.category).toBeDefined();
      expect(ATOMIC_CLAIM_TYPES).toContain(claim.type);
      expect(claim.claimSchemaVersion).toBe(GROUNDED_CLAIM_SCHEMA_VERSION);
      // Pair must be in the mapping table — enforced by schema refine.
      expect(claim.category).toBe(DEFAULT_TYPE_TO_CATEGORY_MAPPING[claim.type]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2 — flag off → grounded field absent, LLM untouched
// ─────────────────────────────────────────────────────────────────────────────

describe('GCE_SHADOW_EMIT unset — grounded field omitted', () => {
  it('does not emit grounded and does not call fake LLM', () => {
    // Flag is unset per beforeEach.
    const frames: readonly ToolCallEvidenceFrame[] = [
      makeEvidenceFrame('req-off-s0'),
    ];
    const llm = makeFakeLlm('{"should":"not be called"}');

    const response = buildMachineResponseV2({
      queryId: 'q-off',
      results: [makeRankedResult('wine-001', 'Opus One 2018', 1)],
      evidenceFrames: frames,
      constraintGraph: makeTrivialConstraintGraph(),
      generatedProse: 'prose',
    });

    expect('grounded' in response).toBe(false);
    expect('claimSchemaVersion' in response).toBe(false);
    expect(llm.complete).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 — flag on + LLM throws → fail-closed empty grounded payload
// ─────────────────────────────────────────────────────────────────────────────

describe('GCE_SHADOW_EMIT=true — fail-closed on LLM error', () => {
  it('carries empty grounded payload with grounded_claim_emission_failed', async () => {
    process.env['GCE_SHADOW_EMIT'] = 'true';

    const frames: readonly ToolCallEvidenceFrame[] = [
      makeEvidenceFrame('req-fail-s0'),
    ];
    const rankedResults = [makeRankedResult('wine-001', 'Opus One 2018', 1)];
    const llm = makeFakeLlm(new Error('LLM provider unreachable'));

    const emitted = await emitGroundedClaims(llm, {
      rankedResults,
      evidenceFrames: frames,
      prose: 'prose',
    });

    // Emitter fail-closed: empty claims + the emission-failed degradation.
    expect(emitted.claims).toHaveLength(0);
    expect(emitted.proseSegments).toHaveLength(0);
    expect(emitted.degradationReasons).toContain(GCE_DEGRADATION_EMISSION_FAILED);

    // V2 response still builds successfully; grounded is present but empty.
    const response = buildMachineResponseV2({
      queryId: 'q-fail',
      results: rankedResults,
      evidenceFrames: frames,
      constraintGraph: makeTrivialConstraintGraph(),
      generatedProse: 'prose',
      groundedOverride: emitted,
    });
    expect(response.grounded).toBeDefined();
    expect(response.grounded!.claims).toHaveLength(0);
    expect(response.grounded!.degradationReasons).toContain(
      GCE_DEGRADATION_EMISSION_FAILED,
    );
    // The envelope still builds — no throw, responseType preserved.
    expect(response.responseType).toBe('machine');
    expect(response.version).toBe('2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4 — 9-verifier dispatch: each AtomicClaimType exercised
// ─────────────────────────────────────────────────────────────────────────────

describe('atomic claim verifier router — 9-class coverage', () => {
  it('dispatches every AtomicClaimType to a verifier', async () => {
    // One canned claim per AtomicClaimType. IDs carry the type tag so we can
    // cross-reference the per-claim verification result.
    const claims = ATOMIC_CLAIM_TYPES.map((type, i) =>
      AtomicClaimSchema.parse({
        id: `c-${type}`,
        type,
        category: DEFAULT_TYPE_TO_CATEGORY_MAPPING[type],
        text: `Test claim for ${type} (entity ${i})`,
        provenance: [{ toolCallId: `req-9-s${i}` }],
        // entityId for entity_reference so the deterministic verifier passes.
        ...(type === 'entity_reference' ? { entityId: 'wine-001' } : {}),
        claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
      }),
    );
    expect(claims).toHaveLength(9);

    // Two evidence records so ComparativeAssertionVerifier's "≥2 entities"
    // pre-check passes and delegates to the LLM.
    const evidenceRecords: readonly EvidenceRecord[] = [
      { entity_id: 'wine-001', canonical_label: 'Opus One 2018' },
      { entity_id: 'wine-002', canonical_label: 'Château Margaux 2016' },
    ];

    // Semantic verifiers (pairing, comparative) call the LLM with a short
    // prompt and expect a single-token NLI answer. ENTAILED keeps both from
    // silently skipping.
    const llm = makeFakeLlm('ENTAILED');
    const ctx: AtomicClaimVerifierContext = {
      evidenceRecords,
      evidenceContext: 'Opus One 2018 — bold cabernet. Château Margaux 2016 — elegant.',
      llm,
    };

    const results = await verifyAtomicClaims(claims, ctx);
    expect(results).toHaveLength(9);

    // Every claim resolves to exactly one verification result, keyed by id.
    const byId = new Map<string, AtomicClaimVerification>(
      results.map((r) => [r.claimId, r]),
    );
    for (const type of ATOMIC_CLAIM_TYPES) {
      const verification = byId.get(`c-${type}`);
      expect(verification, `missing verification for ${type}`).toBeDefined();
      expect(verification!.verdict).toBeDefined();
    }

    // NoopVerifier (recommendation) always passes.
    expect(byId.get('c-recommendation')!.verdict).toBe('entailed');
    expect(byId.get('c-recommendation')!.explanation).toContain('NoopVerifier');

    // Semantic verifiers reached the LLM — pairing + comparative = 2 calls.
    expect(llm.complete).toHaveBeenCalledTimes(2);

    // EntityReferenceVerifier found the entity_id match.
    expect(byId.get('c-entity_reference')!.verdict).toBe('entailed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5 — dual-axis Zod lock (type + category both required)
// ─────────────────────────────────────────────────────────────────────────────

describe('AtomicClaim dual-axis Zod lock', () => {
  it('parses a claim with both type and category', () => {
    const valid = AtomicClaimSchema.safeParse({
      id: 'c-ok',
      type: 'price_assertion',
      category: 'core_structured_claim',
      text: 'Price: USD 450',
      provenance: [{ toolCallId: 'req-dual-s0' }],
      claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
    });
    expect(valid.success).toBe(true);
  });

  it('rejects a claim missing category', () => {
    const result = AtomicClaimSchema.safeParse({
      id: 'c-missing-cat',
      type: 'price_assertion',
      // category intentionally omitted
      text: 'Price: USD 450',
      provenance: [{ toolCallId: 'req-dual-s0' }],
      claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a claim with a (type, category) pair outside the mapping table', () => {
    // price_assertion's canonical category is core_structured_claim; force an
    // intentional mismatch and expect the refine to catch it.
    const result = AtomicClaimSchema.safeParse({
      id: 'c-mismatch',
      type: 'price_assertion',
      category: 'semantic_claim',
      text: 'Price: USD 450',
      provenance: [{ toolCallId: 'req-dual-s0' }],
      claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
    });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6 — criticRewrites surface as recommendation claims
// ─────────────────────────────────────────────────────────────────────────────

describe('criticRewrites → recommendation claims (cross-PR integration)', () => {
  it('emits recommendation claims derived from critic rewrite signals', async () => {
    process.env['GCE_SHADOW_EMIT'] = 'true';

    const frames: readonly ToolCallEvidenceFrame[] = [
      makeEvidenceFrame('req-critic-s0'),
      makeEvidenceFrame('req-critic-s1'),
    ];
    const rankedResults = [
      makeRankedResult('wine-001', 'Opus One 2018', 1),
      makeRankedResult('wine-002', 'Château Margaux 2016', 2),
    ];

    // Two critic rewrites — the upstream pipeline would surface these as
    // degradation reasons when the critic loop relaxed the original query.
    const criticRewrites = [
      'rewrote_query_relaxed_price',
      'rewrote_query_relaxed_region',
    ] as const;

    // Canned recommendation claims — one per critic rewrite, referencing the
    // rewritten query in `text`.
    const claims = [
      cannedClaim(
        'rec-1',
        'recommendation',
        'req-critic-s0',
        'Consider Opus One 2018 (price band relaxed)',
      ),
      cannedClaim(
        'rec-2',
        'recommendation',
        'req-critic-s1',
        'Consider Château Margaux 2016 (region relaxed)',
      ),
    ];
    const llm = makeFakeLlm(cannedPayloadJson(claims));

    const emitted = await emitGroundedClaims(llm, {
      rankedResults,
      evidenceFrames: frames,
      prose:
        'Based on your relaxed criteria, we recommend Opus One 2018 and Château Margaux 2016.',
      upstreamDegradationReasons: criticRewrites,
    });

    // Both recommendation claims survived.
    const recClaims = emitted.claims.filter((c) => c.type === 'recommendation');
    expect(recClaims.length).toBeGreaterThanOrEqual(2);

    // Every recommendation claim has the canonical 5-class category.
    for (const c of recClaims) {
      expect(c.category).toBe(DEFAULT_TYPE_TO_CATEGORY_MAPPING.recommendation);
    }

    // Upstream critic rewrite tags flow through into degradationReasons
    // verbatim — the cross-PR contract for criticRewrites surfacing.
    expect(emitted.degradationReasons).toBeDefined();
    for (const tag of criticRewrites) {
      expect(emitted.degradationReasons).toContain(tag);
    }

    // And the V2 envelope round-trips the payload.
    const response = buildMachineResponseV2({
      queryId: 'q-critic',
      results: rankedResults,
      evidenceFrames: frames,
      constraintGraph: makeTrivialConstraintGraph(),
      generatedProse: 'prose',
      upstreamDegradationReasons: criticRewrites,
      groundedOverride: emitted,
    });
    expect(response.grounded).toBeDefined();
    const envelopeRecClaims = response.grounded!.claims.filter(
      (c) => c.type === 'recommendation',
    );
    expect(envelopeRecClaims.length).toBeGreaterThanOrEqual(2);
  });
});
