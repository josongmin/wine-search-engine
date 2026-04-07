import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildSearchLogEvent } from '../log-search-event.js';
import { buildInternalErrorAuthorityTraceRef } from '../../domain/decision/service/authority-trace.js';

function digest(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

describe('buildSearchLogEvent', () => {
  it('enriches valid authority and snapshot ids with schema versions', () => {
    const event = buildSearchLogEvent({
      authority_trace_ref: `decision:v1:search:${digest('authority')}`,
      snapshot_id: `snapshot:v2:default:1:1:hybrid:entity_lookup:${digest('snapshot')}`,
    });

    expect(event.authority_trace_schema_version).toBe('v1');
    expect(event.snapshot_schema_version).toBe('v2');
    expect(event.invalid_authority_trace_ref_reason).toBeUndefined();
    expect(event.invalid_snapshot_id_reason).toBeUndefined();
  });

  it('surfaces structured invalid-id reasons for audit logging', () => {
    const event = buildSearchLogEvent({
      authority_trace_ref: 'broken-authority',
      snapshot_id: 'broken-snapshot',
    });

    expect(event.invalid_authority_trace_ref_reason).toBe('invalid_authority_trace_ref');
    expect(event.invalid_snapshot_id_reason).toBe('invalid_snapshot_id');
    expect(event.authority_trace_schema_version).toBeUndefined();
    expect(event.snapshot_schema_version).toBeUndefined();
  });

  it('accepts canonical internal-error authority refs in fallback logs', () => {
    const event = buildSearchLogEvent({
      authority_trace_ref: buildInternalErrorAuthorityTraceRef({
        snapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1',
          threshold_profile_id: 'default',
          planner_version: '1',
          feature_flags: {},
        },
        requestId: 'req-err-1',
      }),
    });

    expect(event.authority_trace_schema_version).toBe('v1');
    expect(event.invalid_authority_trace_ref_reason).toBeUndefined();
  });
});
