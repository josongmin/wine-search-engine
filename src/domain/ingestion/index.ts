// Models
export type {
  RawSourceRecord,
  SourceType,
} from './model/raw-source-record.js';

export type {
  SourceTrustProfile,
} from './model/source-trust-profile.js';
export { validateTrustProfile } from './model/source-trust-profile.js';

export type {
  CanonicalizationCandidate,
  ExtractedFields,
  ExternalRef,
} from './model/canonicalization-candidate.js';

export type {
  EntityMatchResult,
  EntityMatchStatus,
} from './model/entity-match-result.js';

export type {
  LineageRecord,
  LineageDecision,
} from './model/lineage-record.js';

// Ports
export type { SourceReader, SourceReaderBatch } from './port/source-reader.port.js';
export type { LineageStore } from './port/lineage-store.port.js';

// Services
export {
  normalizeField,
  normalizeVolume,
  normalizeYear,
  normalizeKoreanText,
} from './service/field-normalizer.js';

export { stripNoiseTokens, isPromotionalText } from './service/noise-stripper.js';
export type { NoiseStripResult } from './service/noise-stripper.js';

export { extract } from './service/structured-extractor.js';

export { EntityMatcher } from './service/entity-matcher.js';
export type { EntityRepository, MatchableEntity } from './service/entity-matcher.js';

export { AbuseDetector } from './service/abuse-detector.js';
export type { AbuseCheckResult, AbuseSeverity } from './service/abuse-detector.js';
