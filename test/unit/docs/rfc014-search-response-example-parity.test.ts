import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ErrorResponseSchema, SearchResponseSchema } from '../../../src/interface/http/schemas/search-response.schema.js';
import {
  decodeAuthorityTraceRefDetailed,
  decodeSnapshotIdDetailed,
} from '../../../src/domain/decision/service/id-schema-decoder.js';
import { ResolveResponseSchema } from '../../../src/interface/http/schemas/search-response.schema.js';

const workspaceRoot = process.cwd();

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

function extractJsonCodeBlock(markdown: string, anchor: string): string {
  const anchorIndex = markdown.indexOf(anchor);
  expect(anchorIndex).toBeGreaterThanOrEqual(0);
  const afterAnchor = markdown.slice(anchorIndex);
  const match = afterAnchor.match(/```json\n([\s\S]*?)\n```/);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

describe('RFC-014 search response example parity', () => {
  const rfc014 = readWorkspaceFile('docs/RFC-014.md');

  it('keeps the main /v1/search example aligned with the live response schema', () => {
    const rawJson = extractJsonCodeBlock(rfc014, '4.2 Response');
    expect((rawJson.match(/"meta":\s*\{/g) ?? []).length).toBe(1);

    const parsed = JSON.parse(rawJson) as unknown;
    const response = SearchResponseSchema.parse(parsed);

    const authorityTraceRef = response.engine_decision.authority_trace_ref;
    const snapshotId = response.engine_decision.decision_snapshot.snapshot_id;

    expect(decodeAuthorityTraceRefDetailed(authorityTraceRef)).toEqual({
      ok: true,
      value: {
        family: 'decision',
        schemaVersion: 'v1',
        queryClass: 'mixed',
        digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    expect(decodeSnapshotIdDetailed(snapshotId)).toEqual({
      ok: true,
      value: {
        schemaVersion: 'v1',
        thresholdProfileId: 'tp_prod_default',
        plannerVersion: 'planner_2026.04.1',
        policyRuleVersion: 'policy_rules_2026.04',
        digest: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
    });
    expect(response.engine_decision.decision_snapshot.response_contract_version).toBe('search_response_v1');
    expect(response.engine_decision.decision_snapshot.feature_flags).toEqual({});
  });

  it('keeps the /v1/entity/resolve example aligned with the canonical resolve contract', () => {
    const rawJson = extractJsonCodeBlock(rfc014, '5.3 Response');
    const parsed = JSON.parse(rawJson) as unknown;
    const response = ResolveResponseSchema.parse(parsed);

    expect(response.authority_trace_ref).toBe(
      'decision:v1:entity_lookup:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    );
    expect(decodeAuthorityTraceRefDetailed(response.authority_trace_ref)).toEqual({
      ok: true,
      value: {
        family: 'decision',
        schemaVersion: 'v1',
        queryClass: 'entity_lookup',
        digest: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      },
    });
  });

  it('keeps the replay SNAPSHOT_MISMATCH error example aligned with the live error contract', () => {
    const rawJson = extractJsonCodeBlock(rfc014, 'Error contract 예시');
    const parsed = JSON.parse(rawJson) as unknown;
    const errorResponse = ErrorResponseSchema.parse(parsed);

    expect(errorResponse.error.code).toBe('SNAPSHOT_MISMATCH');
    expect(errorResponse.error.failure_reason).toBe('SNAPSHOT_MISMATCH');
    expect(errorResponse.error.request_id).toBe('req_…');
  });
});
