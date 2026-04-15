import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SearchRequestBody } from '../../../src/interface/http/schemas/search-request.schema.js';
import { ReplayRequestSchema, SearchRequestSchema } from '../../../src/interface/http/schemas/search-request.schema.js';
import type {
  ComparisonSearchResponseBody,
  ErrorResponseBody,
  SearchResponseBody,
} from '../../../src/interface/http/schemas/search-response.schema.js';
import type { ReplayRequestBody } from '../../../src/interface/http/schemas/search-request.schema.js';
import {
  parseComparisonResponse,
  parseErrorResponse,
  parseSearchResponse,
  postJson,
} from '../../e2e/helpers/http-transport.js';
import { QUERY_ROUTES } from '../../../src/domain/query/model/query-route.js';
import { RETRIEVAL_MODES } from '../../../src/domain/query/model/retrieval-mode.js';
import {
  decodeAuthorityTraceRefDetailed,
  decodeSnapshotIdDetailed,
} from '../../../src/domain/decision/service/id-schema-decoder.js';
import { buildDecisionSnapshotId } from '../../../src/application/search/search-usecase-decision-snapshot.js';

const SearchReplayFixtureExecutionTraceExpectationSchema = z.object({
  effective_route: z.enum(QUERY_ROUTES).optional(),
  retrieval_mode_source: z.enum(['planner', 'api_override']).optional(),
  effective_retrieval_mode: z.enum(RETRIEVAL_MODES).optional(),
  retrieval_kind: z.enum([
    'entity_lookup',
    'generic_hybrid',
    'specialized_hybrid',
    'mixed_similarity',
  ]).optional(),
  sparse_executed: z.boolean().optional(),
  specialized_route_executed: z.enum([
    'producer_browse',
    'region_browse',
    'compare_candidates',
  ]).nullable().optional(),
  used_compiled_execution: z.boolean().optional(),
  compiled_budget: z.object({
    max_candidates: z.number().int().positive(),
    enable_precision_rerank: z.boolean(),
  }).strict().optional(),
  provenance_policy: z.object({
    require_identity_seal: z.boolean(),
    require_constraint_evidence: z.boolean(),
    require_anchor_evidence: z.boolean(),
  }).strict().optional(),
}).strict();

const SearchReplayFixtureResolverProvenanceExpectationSchema = z.object({
  candidate_source_breakdown: z.array(z.object({
    source: z.enum(['alias', 'planner_heuristic', 'entity_lookup', 'blocker_seed']),
    entity_ids: z.array(z.string().min(1)),
    count: z.number().int().nonnegative(),
  }).strict()).optional(),
  blocker_seed_entity_ids: z.array(z.string().min(1)).optional(),
  blocker_seed_count: z.number().int().nonnegative().optional(),
}).strict();

const SearchReplayFixtureTraceExpectationSchema = z.object({
  authority_trace_ref: z.string().min(1).optional(),
  snapshot_id: z.string().min(1).optional(),
  determinism_fingerprint: z.string().min(1).optional(),
  execution_trace: SearchReplayFixtureExecutionTraceExpectationSchema.optional(),
  resolver_provenance_trace: SearchReplayFixtureResolverProvenanceExpectationSchema.optional(),
}).strict();


const SearchReplayFixtureSuccessExpectationSchema = z.object({
  execution_mode: z.string().min(1),
  degradation_reasons: z.array(z.string()),
  golden_trace: SearchReplayFixtureTraceExpectationSchema.optional(),
}).strict();

const SearchReplayFixtureComparisonExpectationSchema = z.object({
  comparison_intent: z.enum(['compare', 'recommend_one', 'list_both']),
  overall_status: z.enum(['resolved', 'ambiguous', 'failed']),
  authority_trace_ref: z.string().min(1).optional(),
  top_result_entity_ids: z.tuple([z.string().min(1), z.string().min(1)]).optional(),
  runtime_correlation_matches_request_id: z.boolean().optional(),
}).strict();

const SearchReplayFixtureErrorExpectationSchema = z.object({
  error_code: z.string().min(1),
}).strict();

const SearchReplayFixtureMetadataSchema = z.object({
  use_live_snapshot: z.boolean().optional(),
  runtime_mode: z.enum(['inmemory', 'full_runtime']).optional(),
}).strict();

const SearchReplayFixtureCommonFieldsSchema = z.object({
  name: z.string().min(1),
  endpoint: z.enum(['/v1/search', '/v1/search/replay']),
  execution_lane: z.enum(['self_contained', 'runtime_required']),
  response_family: z.enum(['search', 'comparison']).optional(),
  expected: z.union([
    SearchReplayFixtureSuccessExpectationSchema,
    SearchReplayFixtureComparisonExpectationSchema,
    SearchReplayFixtureErrorExpectationSchema,
  ]),
  requires_runtime_capability: z.array(z.string().min(1)).optional(),
  metadata: SearchReplayFixtureMetadataSchema.optional(),
}).strict();

function addExecutionLaneInvariant(
  fixture: {
    readonly execution_lane: 'self_contained' | 'runtime_required';
    readonly requires_runtime_capability?: readonly string[] | undefined;
    readonly metadata?: {
      readonly use_live_snapshot?: boolean | undefined;
      readonly runtime_mode?: 'inmemory' | 'full_runtime' | undefined;
    } | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const capabilityCount = fixture.requires_runtime_capability?.length ?? 0;
  if (fixture.execution_lane === 'self_contained' && capabilityCount > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'self_contained fixtures must not declare runtime capabilities',
      path: ['execution_lane'],
    });
  }
  if (fixture.execution_lane === 'runtime_required' && capabilityCount === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'runtime_required fixtures must declare at least one runtime capability',
      path: ['execution_lane'],
    });
  }
  if (fixture.execution_lane === 'runtime_required' && fixture.metadata?.runtime_mode === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'runtime_required fixtures must declare metadata.runtime_mode',
      path: ['metadata', 'runtime_mode'],
    });
  }
  if (
    fixture.execution_lane === 'runtime_required'
    && fixture.metadata?.runtime_mode === 'full_runtime'
    && fixture.metadata.use_live_snapshot !== true
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'full_runtime fixtures must set metadata.use_live_snapshot=true',
      path: ['metadata', 'use_live_snapshot'],
    });
  }
}

const SearchFixtureSchema = SearchReplayFixtureCommonFieldsSchema.extend({
  endpoint: z.literal('/v1/search'),
  request: SearchRequestSchema,
}).strict();

const ReplayFixtureSchema = SearchReplayFixtureCommonFieldsSchema.extend({
  endpoint: z.literal('/v1/search/replay'),
  replay_request: ReplayRequestSchema,
  snapshot_override: z.record(z.string(), z.unknown()).optional(),
}).strict();

const SearchReplayFixtureSchema = z
  .discriminatedUnion('endpoint', [SearchFixtureSchema, ReplayFixtureSchema])
  .superRefine(addExecutionLaneInvariant);

export type SearchReplayFixtureFile = z.infer<typeof SearchReplayFixtureSchema>;
export type SearchHttpFixtureFile = z.infer<typeof SearchFixtureSchema>;
export type ReplayHttpFixtureFile = z.infer<typeof ReplayFixtureSchema>;

export function loadSearchReplayFixtures(
  dir: string = path.join(process.cwd(), 'test/replay-fixtures/search'),
): readonly { readonly file: string; readonly fixture: SearchReplayFixtureFile }[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      return {
        file,
        fixture: SearchReplayFixtureSchema.parse(JSON.parse(raw)),
      };
    });
}

export function isSelfContainedSearchReplayFixture(
  fixture: SearchReplayFixtureFile,
): boolean {
  return fixture.execution_lane === 'self_contained';
}

export function isExecutableSearchReplayFixture(fixture: SearchReplayFixtureFile): boolean {
  return isSelfContainedSearchReplayFixture(fixture);
}

export function requiresRuntimeCapabilitySearchReplayFixture(
  fixture: SearchReplayFixtureFile,
): boolean {
  return fixture.execution_lane === 'runtime_required';
}

export function isInMemoryRuntimeSearchReplayFixture(
  fixture: SearchReplayFixtureFile,
): boolean {
  return fixture.execution_lane === 'runtime_required'
    && fixture.metadata?.runtime_mode === 'inmemory';
}

export function isFullRuntimeSearchReplayFixture(
  fixture: SearchReplayFixtureFile,
): boolean {
  return fixture.execution_lane === 'runtime_required'
    && fixture.metadata?.runtime_mode === 'full_runtime';
}

export function isSearchHttpFixture(
  fixture: SearchReplayFixtureFile,
): fixture is SearchHttpFixtureFile {
  return fixture.endpoint === '/v1/search';
}

export function isReplayHttpFixture(
  fixture: SearchReplayFixtureFile,
): fixture is ReplayHttpFixtureFile {
  return fixture.endpoint === '/v1/search/replay';
}

export function classifySearchFixtureMode(
  fixture: SearchReplayFixtureFile,
): 'search' | 'replay' {
  return fixture.endpoint === '/v1/search' ? 'search' : 'replay';
}

export function buildSearchFixturePayload(
  fixture: SearchReplayFixtureFile,
): SearchRequestBody | ReplayRequestBody {
  if (fixture.endpoint === '/v1/search') {
    return fixture.request;
  }

  const replayRequest = fixture.snapshot_override === undefined
    ? fixture.replay_request
    : {
      ...fixture.replay_request,
      decision_snapshot: {
        ...fixture.replay_request.decision_snapshot,
        ...fixture.snapshot_override,
      },
    };

  if ('error_code' in fixture.expected) {
    return ReplayRequestSchema.parse(replayRequest);
  }

  const snapshot = replayRequest.decision_snapshot;
  const rebuiltSnapshot = {
    ...snapshot,
    snapshot_id: buildDecisionSnapshotId({
      threshold_profile_id: snapshot.threshold_profile_id,
      planner_version: snapshot.planner_version,
      policy_rule_version: snapshot.policy_rule_version,
      model_versions: snapshot.model_versions,
      index_versions: snapshot.index_versions,
      feature_flags: snapshot.feature_flags,
      response_contract_version: snapshot.response_contract_version,
      ...(snapshot.nondeterminism_notes !== undefined
        ? { nondeterminism_notes: snapshot.nondeterminism_notes }
        : {}),
    }),
  };

  return ReplayRequestSchema.parse({
    ...replayRequest,
    decision_snapshot: rebuiltSnapshot,
  });
}

function assertExactMatch(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${label}=${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

async function buildLiveSnapshotReplayPayload(
  fixture: ReplayHttpFixtureFile,
  app: FastifyInstance,
): Promise<ReplayRequestBody> {
  const searchPayload = SearchRequestSchema.parse({
    query: fixture.replay_request.query,
    ...(fixture.replay_request.context !== undefined
      ? { context: fixture.replay_request.context }
      : {}),
    ...(fixture.replay_request.sessionContext !== undefined
      ? { sessionContext: fixture.replay_request.sessionContext }
      : {}),
    ...(fixture.replay_request.queryBudget !== undefined
      ? { queryBudget: fixture.replay_request.queryBudget }
      : {}),
    ...(fixture.replay_request.options !== undefined
      ? { options: fixture.replay_request.options }
      : {}),
  });

  const preflightResponse = parseSearchResponse(
    await postJson(app, '/v1/search', searchPayload),
  );

  return ReplayRequestSchema.parse({
    ...fixture.replay_request,
    decision_snapshot: {
      ...preflightResponse.meta.decision_snapshot,
    },
    ...(preflightResponse.meta.determinism_fingerprint !== undefined
      ? { expected_determinism_fingerprint: preflightResponse.meta.determinism_fingerprint }
      : {}),
    preflight_honesty_contract: {
      execution_mode:
        preflightResponse.engine_decision.execution_mode
        ?? preflightResponse.meta.execution_mode
        ?? 'authoritative',
      degradation_reasons:
        preflightResponse.engine_decision.degradation_reasons
        ?? preflightResponse.meta.degradation_reasons
        ?? [],
      ...(
        (
          preflightResponse.engine_decision.blocking_eligible
          ?? preflightResponse.meta.blocking_eligible
        ) !== undefined
          ? {
              blocking_eligible:
                preflightResponse.engine_decision.blocking_eligible
                ?? preflightResponse.meta.blocking_eligible,
            }
          : {}
      ),
    },
  });
}

async function buildExecutableReplayFixturePayload(
  fixture: SearchReplayFixtureFile,
  app: FastifyInstance,
): Promise<SearchRequestBody | ReplayRequestBody> {
  if (
    !isReplayHttpFixture(fixture)
    || fixture.metadata?.['use_live_snapshot'] !== true
    || 'error_code' in fixture.expected
  ) {
    return buildSearchFixturePayload(fixture);
  }

  return buildLiveSnapshotReplayPayload(fixture, app);
}

/**
 * Drift classification for replay fixture assertions.
 *
 * Separates **result drift** (execution_mode, degradation_reasons — the user-visible
 * outcome changed) from **trace drift** (authority_trace_ref, snapshot_id,
 * determinism_fingerprint — the provenance/identity envelope changed but results
 * may still be correct). This lets CI surface "trace-only drift" as a warning
 * rather than a hard failure, keeping the fixture suite stable across snapshot
 * version bumps while still catching behavioral regressions.
 */
export interface FixtureDriftClassification {
  /** Fields that assert user-visible search result correctness. */
  readonly resultFields: readonly string[];
  /** Fields that assert execution provenance / trace identity. */
  readonly traceFields: readonly string[];
}

/** Result drift: the behaviorally-meaningful fields. */
export const RESULT_DRIFT_FIELDS = [
  'execution_mode',
  'degradation_reasons',
] as const;

/** Trace drift: provenance/identity envelope fields. */
export const TRACE_DRIFT_FIELDS = [
  'authority_trace_ref',
  'runtime_correlation_ref',
  'decision_snapshot.snapshot_id',
  'determinism_fingerprint',
] as const;

export async function runSearchFixture(
  fixture: SearchReplayFixtureFile,
  options: { readonly app: FastifyInstance },
): Promise<{
  readonly response?: SearchResponseBody | ComparisonSearchResponseBody;
  readonly error?: ErrorResponseBody;
  readonly assertionSummary: {
    readonly endpoint: '/v1/search' | '/v1/search/replay';
    readonly responseFamily: 'search' | 'comparison';
    readonly runtimeMode?: 'inmemory' | 'full_runtime' | undefined;
    readonly usedLiveSnapshot: boolean;
    readonly skipped: boolean;
    readonly assertedFields: readonly string[];
    readonly driftClassification: FixtureDriftClassification;
    readonly executionMode?: string;
    readonly degradationReasons?: readonly string[];
    readonly errorCode?: string;
    readonly decodedIds: {
      readonly authorityTraceRef?: ReturnType<typeof decodeAuthorityTraceRefDetailed>;
      readonly snapshotId?: ReturnType<typeof decodeSnapshotIdDetailed>;
    };
  };
  readonly mode: 'search' | 'replay';
}> {
  const mode = classifySearchFixtureMode(fixture);
  const endpoint = fixture.endpoint;
  const responseFamily = fixture.response_family ?? 'search';
  const usedLiveSnapshot = isReplayHttpFixture(fixture)
    && fixture.metadata?.use_live_snapshot === true
    && !('error_code' in fixture.expected);
  const httpResponse = await postJson(
    options.app,
    endpoint,
    await buildExecutableReplayFixturePayload(fixture, options.app),
  );
  if ('error_code' in fixture.expected) {
    const error = parseErrorResponse(httpResponse);
    if (error.error.code !== fixture.expected.error_code) {
      throw new Error(
        `Expected error.code=${fixture.expected.error_code}, received ${error.error.code}`,
      );
    }
    return {
      error,
      assertionSummary: {
        endpoint,
        responseFamily,
        runtimeMode: fixture.metadata?.runtime_mode,
        usedLiveSnapshot,
        skipped: false,
        assertedFields: ['error.code'],
        driftClassification: { resultFields: ['error.code'], traceFields: [] },
        errorCode: fixture.expected.error_code,
        decodedIds: {},
      },
      mode,
    };
  }

  if (responseFamily === 'comparison') {
    const response = parseComparisonResponse(httpResponse);
    assertComparisonFixtureExpectation(response, fixture);
    const authorityTraceRef = response.authority_trace_ref;
    if (authorityTraceRef === undefined) {
      throw new Error('missing authority_trace_ref on comparison replay fixture response');
    }
    const authorityDecode = decodeAuthorityTraceRefDetailed(authorityTraceRef);
    if (!authorityDecode.ok) {
      throw new Error(JSON.stringify(authorityDecode.error));
    }
    return {
      response,
      assertionSummary: {
        endpoint,
        responseFamily,
        runtimeMode: fixture.metadata?.runtime_mode,
        usedLiveSnapshot,
        skipped: false,
        assertedFields: [
          'comparison_intent',
          'overall_status',
          'authority_trace_ref',
          'runtime_correlation_ref',
          'entity_top_result_ids',
        ],
        driftClassification: {
          resultFields: ['comparison_intent', 'overall_status'],
          traceFields: ['authority_trace_ref', 'runtime_correlation_ref'],
        },
        executionMode: undefined,
        degradationReasons: undefined,
        decodedIds: {
          authorityTraceRef: authorityDecode,
        },
      },
      mode,
    };
  }

  const response = parseSearchResponse(httpResponse);
  assertSearchFixtureExpectation(response, fixture);
  const authorityTraceRef = response.engine_decision.authority_trace_ref ?? response.meta.authority_trace_ref;
  if (authorityTraceRef === undefined) {
    throw new Error('missing authority_trace_ref on replay fixture response');
  }
  const authorityDecode = decodeAuthorityTraceRefDetailed(authorityTraceRef);
  if (!authorityDecode.ok) {
    throw new Error(JSON.stringify(authorityDecode.error));
  }
  const runtimeCorrelationRef = response.engine_decision.runtime_correlation_ref
    ?? response.meta.runtime_correlation_ref;
  if (runtimeCorrelationRef === undefined) {
    throw new Error('missing runtime_correlation_ref on replay fixture response');
  }
  const snapshotId = response.engine_decision.decision_snapshot.snapshot_id;
  const snapshotDecode = decodeSnapshotIdDetailed(snapshotId);
  if (!snapshotDecode.ok) {
    throw new Error(JSON.stringify(snapshotDecode.error));
  }
  if (response.meta.determinism_fingerprint === undefined) {
    throw new Error('missing determinism_fingerprint on replay fixture response');
  }
  return {
    response,
    assertionSummary: {
      endpoint,
      responseFamily,
      runtimeMode: fixture.metadata?.runtime_mode,
      usedLiveSnapshot,
      skipped: false,
      assertedFields: fixture.expected.golden_trace !== undefined
        ? [
            ...RESULT_DRIFT_FIELDS,
            'authority_trace_ref',
            'runtime_correlation_ref',
            'decision_snapshot.snapshot_id',
            'determinism_fingerprint',
            'execution_trace',
            'resolver_provenance_trace',
          ]
        : [
            ...RESULT_DRIFT_FIELDS,
            ...TRACE_DRIFT_FIELDS,
          ],
      driftClassification: {
        resultFields: [...RESULT_DRIFT_FIELDS],
        traceFields: fixture.expected.golden_trace !== undefined
          ? [
              'authority_trace_ref',
              'runtime_correlation_ref',
              'decision_snapshot.snapshot_id',
              'determinism_fingerprint',
              'execution_trace',
              'resolver_provenance_trace',
            ]
          : [...TRACE_DRIFT_FIELDS],
      },
      executionMode: fixture.expected.execution_mode,
      degradationReasons: fixture.expected.degradation_reasons,
      decodedIds: {
        authorityTraceRef: authorityDecode,
        snapshotId: snapshotDecode,
      },
    },
    mode,
  };
}

export function assertSearchFixtureExpectation(
  body: SearchResponseBody,
  fixture: SearchReplayFixtureFile,
): void {
  if ('error_code' in fixture.expected) {
    throw new Error('error fixture cannot be asserted with success expectation helper');
  }
  const executionMode = body.engine_decision.execution_mode ?? body.meta.execution_mode;
  const degradationReasons = body.engine_decision.degradation_reasons
    ?? body.meta.degradation_reasons
    ?? [];

  if (executionMode !== fixture.expected.execution_mode) {
    throw new Error(
      `Expected execution_mode=${fixture.expected.execution_mode}, received ${executionMode ?? 'undefined'}`,
    );
  }

  const actual = [...degradationReasons];
  const expected = [...fixture.expected.degradation_reasons];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected degradation_reasons=${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }

  if (body.meta.determinism_fingerprint === undefined) {
    throw new Error('Expected meta.determinism_fingerprint to be present');
  }

  if ('golden_trace' in fixture.expected && fixture.expected.golden_trace !== undefined) {
    const goldenTrace = fixture.expected.golden_trace;
    const auditExtension = body.meta.audit_extension;
    if (auditExtension === undefined) {
      throw new Error('Expected meta.audit_extension to be present when golden_trace is declared');
    }
    if (goldenTrace.authority_trace_ref !== undefined) {
      assertExactMatch(body.meta.authority_trace_ref, goldenTrace.authority_trace_ref, 'authority_trace_ref');
    }
    if (goldenTrace.snapshot_id !== undefined) {
      assertExactMatch(
        body.meta.decision_snapshot?.snapshot_id,
        goldenTrace.snapshot_id,
        'decision_snapshot.snapshot_id',
      );
    }
    if (goldenTrace.determinism_fingerprint !== undefined) {
      assertExactMatch(
        body.meta.determinism_fingerprint,
        goldenTrace.determinism_fingerprint,
        'determinism_fingerprint',
      );
    }
    if (goldenTrace.execution_trace !== undefined) {
      assertExactMatch(
        auditExtension.execution_trace,
        goldenTrace.execution_trace,
        'audit_extension.execution_trace',
      );
    }
    if (goldenTrace.resolver_provenance_trace !== undefined) {
      assertExactMatch(
        auditExtension.resolver_provenance_trace,
        goldenTrace.resolver_provenance_trace,
        'audit_extension.resolver_provenance_trace',
      );
    }
  }
}

export function assertComparisonFixtureExpectation(
  body: ComparisonSearchResponseBody,
  fixture: SearchReplayFixtureFile,
): void {
  if ('error_code' in fixture.expected) {
    throw new Error('error fixture cannot be asserted with success expectation helper');
  }
  if (fixture.response_family !== 'comparison') {
    throw new Error('comparison expectation helper requires response_family=comparison');
  }
  if (body.query_type !== 'comparison') {
    throw new Error(`Expected query_type=comparison, received ${body.query_type}`);
  }
  const expected = fixture.expected;
  if (!('comparison_intent' in expected)) {
    throw new Error('comparison fixtures must declare comparison expectations');
  }
  if (body.comparison_intent !== expected.comparison_intent) {
    throw new Error(
      `Expected comparison_intent=${expected.comparison_intent}, received ${body.comparison_intent}`,
    );
  }
  if (body.overall_status !== expected.overall_status) {
    throw new Error(
      `Expected overall_status=${expected.overall_status}, received ${body.overall_status}`,
    );
  }
  if (expected.authority_trace_ref !== undefined) {
    assertExactMatch(body.authority_trace_ref, expected.authority_trace_ref, 'authority_trace_ref');
  }
  if (expected.top_result_entity_ids !== undefined) {
    const actualTopResultEntityIds = body.entities.map((entity) => entity.top_result?.entity.entity_id ?? '');
    assertExactMatch(actualTopResultEntityIds, expected.top_result_entity_ids, 'top_result_entity_ids');
  }
  if (expected.runtime_correlation_matches_request_id === true) {
    assertExactMatch(body.runtime_correlation_ref, body.request_id, 'runtime_correlation_ref');
  }
}
