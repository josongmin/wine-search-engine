import type { SearchLogSchema } from './search-log-schema.js';
import { bootstrapLogger } from '../shared/bootstrap-logger.js';
import {
  decodeAuthorityTraceRefDetailed,
  decodeSnapshotIdDetailed,
} from '../decision/service/id-schema-decoder.js';

const log = bootstrapLogger.child({ component: 'search_observability' });

export function buildSearchLogEvent(event: SearchLogSchema): SearchLogSchema {
  const authorityTraceRef = event.authority_trace_ref;
  const snapshotId = event.snapshot_id;
  const authorityDecoded =
    authorityTraceRef !== undefined ? decodeAuthorityTraceRefDetailed(authorityTraceRef) : undefined;
  const snapshotDecoded =
    snapshotId !== undefined ? decodeSnapshotIdDetailed(snapshotId) : undefined;

  return {
    ...event,
    ...(authorityDecoded?.ok === true
      ? { authority_trace_schema_version: authorityDecoded.value.schemaVersion }
      : authorityDecoded?.ok === false
        ? { invalid_authority_trace_ref_reason: authorityDecoded.error.reason }
        : {}),
    ...(snapshotDecoded?.ok === true
      ? { snapshot_schema_version: snapshotDecoded.value.schemaVersion }
      : snapshotDecoded?.ok === false
        ? { invalid_snapshot_id_reason: snapshotDecoded.error.reason }
        : {}),
  };
}

export function logSearchEvent(event: SearchLogSchema): void {
  log.info({
    event_type: 'search_execution',
    ...buildSearchLogEvent(event),
  });
}
