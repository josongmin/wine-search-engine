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

const SearchReplayFixtureSuccessExpectationSchema = z.object({
  execution_mode: z.string().min(1),
  degradation_reasons: z.array(z.string()),
}).strict();

const SearchReplayFixtureErrorExpectationSchema = z.object({
  error_code: z.string().min(1),
}).strict();

const SearchReplayFixtureSchema = z.object({
  name: z.string().min(1),
  request: SearchRequestSchema.optional(),
  replay_request: ReplayRequestSchema.optional(),
  expected: z.union([
    SearchReplayFixtureSuccessExpectationSchema,
    SearchReplayFixtureErrorExpectationSchema,
  ]),
  snapshot_override: z.record(z.string(), z.unknown()).optional(),
  requires_runtime_capability: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((fixture, ctx) => {
  const presentCount = Number(fixture.request !== undefined) + Number(fixture.replay_request !== undefined);
  if (presentCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Exactly one of request or replay_request must be present',
      path: ['request'],
    });
  }
  if (fixture.snapshot_override !== undefined && fixture.replay_request === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'snapshot_override requires replay_request',
      path: ['snapshot_override'],
    });
  }
});

export type SearchReplayFixtureFile = {
  readonly name: string;
  readonly request?: SearchRequestBody;
  readonly replay_request?: ReplayRequestBody;
  readonly expected:
    | {
      readonly execution_mode: string;
      readonly degradation_reasons: readonly string[];
    }
    | {
      readonly error_code: string;
    };
  readonly snapshot_override?: Readonly<Record<string, unknown>>;
  readonly requires_runtime_capability?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
};

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
        fixture: SearchReplayFixtureSchema.parse(JSON.parse(raw)) as SearchReplayFixtureFile,
      };
    });
}

export function isSelfContainedSearchReplayFixture(
  fixture: SearchReplayFixtureFile,
): boolean {
  return (fixture.requires_runtime_capability?.length ?? 0) === 0;
}

export function isExecutableSearchReplayFixture(fixture: SearchReplayFixtureFile): boolean {
  return isSelfContainedSearchReplayFixture(fixture);
}

export function requiresRuntimeCapabilitySearchReplayFixture(
  fixture: SearchReplayFixtureFile,
): boolean {
  return !isSelfContainedSearchReplayFixture(fixture);
}

export function classifySearchFixtureMode(
  fixture: SearchReplayFixtureFile,
): 'search' | 'replay' {
  return fixture.request !== undefined ? 'search' : 'replay';
}

export function buildSearchFixturePayload(
  fixture: SearchReplayFixtureFile,
): SearchRequestBody | ReplayRequestBody {
  if (fixture.request !== undefined) {
    return fixture.request;
  }

  if (fixture.replay_request === undefined) {
    throw new Error('search replay fixture is missing replay_request');
  }

  if (fixture.snapshot_override === undefined) {
    return fixture.replay_request;
  }

  return ReplayRequestSchema.parse({
    ...fixture.replay_request,
    decision_snapshot: {
      ...fixture.replay_request.decision_snapshot,
      ...fixture.snapshot_override,
    },
  }) as ReplayRequestBody;
}

export async function runSearchFixture(
  fixture: SearchReplayFixtureFile,
  options: { readonly app: FastifyInstance },
): Promise<{
  readonly response?: SearchResponseBody;
  readonly error?: ErrorResponseBody;
  readonly assertionSummary: {
    readonly endpoint: '/v1/search' | '/v1/search/replay';
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
  const endpoint = mode === 'search' ? '/v1/search' : '/v1/search/replay';
  const httpResponse = await postJson(
    options.app,
    endpoint,
    buildSearchFixturePayload(fixture),
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
