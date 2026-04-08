import {
  AUTHORITY_TRACE_SCHEMA_VERSION,
  BATCH_ID_SCHEMA_VERSION,
  SNAPSHOT_ID_SCHEMA_VERSION,
  SNAPSHOT_ID_SCHEMA_VERSION_V2,
} from '../model/id-schema-version.js';

const HEX_64_PATTERN = /^[a-f0-9]{64}$/;

/** Colon-separated segments in `decision|admission:ver:class:digest`. */
const AUTHORITY_TRACE_REF_SEGMENT_COUNT = 4;
/** Colon-separated segments in `batch:ver:digest`. */
const BATCH_ID_SEGMENT_COUNT = 3;
/** Colon-separated segments in snapshot id v1. */
const SNAPSHOT_ID_V1_SEGMENT_COUNT = 6;
/** Colon-separated segments in snapshot id v2 (adds execution + retrieval). */
const SNAPSHOT_ID_V2_SEGMENT_COUNT = 8;

export interface DecodedAuthorityTraceRefV1 {
  readonly family: 'decision' | 'admission';
  readonly schemaVersion: typeof AUTHORITY_TRACE_SCHEMA_VERSION;
  readonly queryClass: string;
  readonly digest: string;
}

export type DecodedAuthorityTraceRef = DecodedAuthorityTraceRefV1;

export interface DecodedBatchIdV1 {
  readonly schemaVersion: typeof BATCH_ID_SCHEMA_VERSION;
  readonly digest: string;
}

export type DecodedBatchId = DecodedBatchIdV1;

export interface DecodedSnapshotIdV1 {
  readonly schemaVersion: typeof SNAPSHOT_ID_SCHEMA_VERSION;
  readonly thresholdProfileId: string;
  readonly plannerVersion: string;
  readonly policyRuleVersion: string;
  readonly digest: string;
}

export interface DecodedSnapshotIdV2 {
  readonly schemaVersion: typeof SNAPSHOT_ID_SCHEMA_VERSION_V2;
  readonly thresholdProfileId: string;
  readonly plannerVersion: string;
  readonly policyRuleVersion: string;
  readonly executionRoute: string;
  readonly retrievalMode: string;
  readonly digest: string;
}

export type DecodedSnapshotId = DecodedSnapshotIdV1 | DecodedSnapshotIdV2;

export interface IdDecodeFailure {
  readonly kind: 'authority_trace_ref' | 'batch_id' | 'snapshot_id';
  readonly rawValue: string;
  readonly reason: string;
}

export type IdDecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: IdDecodeFailure };

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isHexDigest(value: string | undefined): value is string {
  return isNonEmpty(value) && HEX_64_PATTERN.test(value);
}

export function decodeAuthorityTraceRef(ref: string): DecodedAuthorityTraceRef | null {
  const parts = ref.split(':');
  const family = parts[0];
  const schemaVersion = parts[1];
  const queryClass = parts[2];
  const digest = parts[3];

  if (
    (family !== 'decision' && family !== 'admission')
    || schemaVersion !== AUTHORITY_TRACE_SCHEMA_VERSION
    || !isNonEmpty(queryClass)
    || !isHexDigest(digest)
    || parts.length !== AUTHORITY_TRACE_REF_SEGMENT_COUNT
  ) {
    return null;
  }

  return {
    family,
    schemaVersion,
    queryClass,
    digest,
  };
}

export function decodeAuthorityTraceRefDetailed(ref: string): IdDecodeResult<DecodedAuthorityTraceRef> {
  const decoded = decodeAuthorityTraceRef(ref);
  if (decoded !== null) {
    return { ok: true, value: decoded };
  }
  return {
    ok: false,
    error: {
      kind: 'authority_trace_ref',
      rawValue: ref,
      reason: 'invalid_authority_trace_ref',
    },
  };
}

export function decodeBatchId(batchId: string): DecodedBatchId | null {
  const parts = batchId.split(':');
  const family = parts[0];
  const schemaVersion = parts[1];
  const digest = parts[2];

  if (
    family !== 'batch'
    || schemaVersion !== BATCH_ID_SCHEMA_VERSION
    || !isHexDigest(digest)
    || parts.length !== BATCH_ID_SEGMENT_COUNT
  ) {
    return null;
  }

  return {
    schemaVersion,
    digest,
  };
}

export function decodeBatchIdDetailed(batchId: string): IdDecodeResult<DecodedBatchId> {
  const decoded = decodeBatchId(batchId);
  if (decoded !== null) {
    return { ok: true, value: decoded };
  }
  return {
    ok: false,
    error: {
      kind: 'batch_id',
      rawValue: batchId,
      reason: 'invalid_batch_id',
    },
  };
}

export function decodeSnapshotId(snapshotId: string): DecodedSnapshotId | null {
  const parts = snapshotId.split(':');
  if (parts[0] !== 'snapshot') {
    return null;
  }

  const schemaVersion = parts[1];
  if (schemaVersion === SNAPSHOT_ID_SCHEMA_VERSION) {
    const thresholdProfileId = parts[2];
    const plannerVersion = parts[3];
    const policyRuleVersion = parts[4];
    const digest = parts[5];

    if (
      !isNonEmpty(thresholdProfileId)
      || !isNonEmpty(plannerVersion)
      || !isNonEmpty(policyRuleVersion)
      || !isHexDigest(digest)
      || parts.length !== SNAPSHOT_ID_V1_SEGMENT_COUNT
    ) {
      return null;
    }

    return {
      schemaVersion,
      thresholdProfileId,
      plannerVersion,
      policyRuleVersion,
      digest,
    };
  }

  if (schemaVersion === SNAPSHOT_ID_SCHEMA_VERSION_V2) {
    const thresholdProfileId = parts[2];
    const plannerVersion = parts[3];
    const policyRuleVersion = parts[4];
    const executionRoute = parts[5];
    const retrievalMode = parts[6];
    const digest = parts[7];

    if (
      !isNonEmpty(thresholdProfileId)
      || !isNonEmpty(plannerVersion)
      || !isNonEmpty(policyRuleVersion)
      || !isNonEmpty(executionRoute)
      || !isNonEmpty(retrievalMode)
      || !isHexDigest(digest)
      || parts.length !== SNAPSHOT_ID_V2_SEGMENT_COUNT
    ) {
      return null;
    }

    return {
      schemaVersion,
      thresholdProfileId,
      plannerVersion,
      policyRuleVersion,
      executionRoute,
      retrievalMode,
      digest,
    };
  }

  return null;
}

export function decodeSnapshotIdDetailed(snapshotId: string): IdDecodeResult<DecodedSnapshotId> {
  const decoded = decodeSnapshotId(snapshotId);
  if (decoded !== null) {
    return { ok: true, value: decoded };
  }
  return {
    ok: false,
    error: {
      kind: 'snapshot_id',
      rawValue: snapshotId,
      reason: 'invalid_snapshot_id',
    },
  };
}
