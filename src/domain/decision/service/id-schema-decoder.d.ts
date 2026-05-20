import { AUTHORITY_TRACE_SCHEMA_VERSION, BATCH_ID_SCHEMA_VERSION, SNAPSHOT_ID_SCHEMA_VERSION, SNAPSHOT_ID_SCHEMA_VERSION_V2 } from '../model/id-schema-version.js';
interface DecodedAuthorityTraceRefV1 {
    readonly family: 'decision' | 'admission';
    readonly schemaVersion: typeof AUTHORITY_TRACE_SCHEMA_VERSION;
    readonly queryClass: string;
    readonly digest: string;
}
type DecodedAuthorityTraceRef = DecodedAuthorityTraceRefV1;
interface DecodedBatchIdV1 {
    readonly schemaVersion: typeof BATCH_ID_SCHEMA_VERSION;
    readonly digest: string;
}
type DecodedBatchId = DecodedBatchIdV1;
interface DecodedSnapshotIdV1 {
    readonly schemaVersion: typeof SNAPSHOT_ID_SCHEMA_VERSION;
    readonly thresholdProfileId: string;
    readonly plannerVersion: string;
    readonly policyRuleVersion: string;
    readonly digest: string;
}
interface DecodedSnapshotIdV2 {
    readonly schemaVersion: typeof SNAPSHOT_ID_SCHEMA_VERSION_V2;
    readonly thresholdProfileId: string;
    readonly plannerVersion: string;
    readonly policyRuleVersion: string;
    readonly executionRoute: string;
    readonly retrievalMode: string;
    readonly digest: string;
}
type DecodedSnapshotId = DecodedSnapshotIdV1 | DecodedSnapshotIdV2;
interface IdDecodeFailure {
    readonly kind: 'authority_trace_ref' | 'batch_id' | 'snapshot_id';
    readonly rawValue: string;
    readonly reason: string;
}
type IdDecodeResult<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly error: IdDecodeFailure;
};
export declare function decodeAuthorityTraceRef(ref: string): DecodedAuthorityTraceRef | null;
export declare function decodeAuthorityTraceRefDetailed(ref: string): IdDecodeResult<DecodedAuthorityTraceRef>;
export declare function decodeBatchId(batchId: string): DecodedBatchId | null;
export declare function decodeBatchIdDetailed(batchId: string): IdDecodeResult<DecodedBatchId>;
export declare function decodeSnapshotId(snapshotId: string): DecodedSnapshotId | null;
export declare function decodeSnapshotIdDetailed(snapshotId: string): IdDecodeResult<DecodedSnapshotId>;
export {};
//# sourceMappingURL=id-schema-decoder.d.ts.map