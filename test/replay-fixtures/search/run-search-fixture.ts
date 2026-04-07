import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SearchRequestBody } from '../../../src/interface/http/schemas/search-request.schema.js';
import { ReplayRequestSchema, SearchRequestSchema } from '../../../src/interface/http/schemas/search-request.schema.js';
import type { ErrorResponseBody, SearchResponseBody } from '../../../src/interface/http/schemas/search-response.schema.js';
import type { ReplayRequestBody } from '../../../src/interface/http/schemas/search-request.schema.js';
import { parseErrorResponse, parseSearchResponse, postJson } from '../../e2e/helpers/http-transport.js';
import {
  decodeAuthorityTraceRefDetailed,
  decodeSnapshotIdDetailed,
} from '../../../src/domain/decision/service/id-schema-decoder.js';
import { buildDecisionSnapshotId } from '../../../src/application/search/search-usecase-decision-snapshot.js';


const SearchReplayFixtureSuccessExpectationSchema = z.object({
  execution_mode: z.string().min(1),
  degradation_reasons: z.array(z.string()),
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
  expected: z.union([
    SearchReplayFixtureSuccessExpectationSchema,
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

export async function runSearchFixture(
  fixture: SearchReplayFixtureFile,
  options: { readonly app: FastifyInstance },
): Promise<{
  readonly response?: SearchResponseBody;
  readonly error?: ErrorResponseBody;
  readonly assertionSummary: {
    readonly endpoint: '/v1/search' | '/v1/search/replay';
    readonly runtimeMode?: 'inmemory' | 'full_runtime' | undefined;
    readonly usedLiveSnapshot: boolean;
    readonly skipped: boolean;
    readonly assertedFields: readonly string[];
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
        runtimeMode: fixture.metadata?.runtime_mode,
        usedLiveSnapshot,
        skipped: false,
        assertedFields: ['error.code'],
        errorCode: fixture.expected.error_code,
        decodedIds: {},
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
  return {
    response,
    assertionSummary: {
      endpoint,
      runtimeMode: fixture.metadata?.runtime_mode,
      usedLiveSnapshot,
      skipped: false,
      assertedFields: [
        'execution_mode',
        'degradation_reasons',
        'authority_trace_ref',
        'runtime_correlation_ref',
        'decision_snapshot.snapshot_id',
      ],
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
}
