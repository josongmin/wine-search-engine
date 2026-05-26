import type { QueryClass as DomainQueryClass } from '../../shared/types/query-class.js';
import {
  getLiveFusionConfig,
  LIVE_FUSION_CONFIGS,
  mapDomainQueryClassToLiveFusionQueryClass,
  type LiveFusionQueryClass,
} from './live-retrieval-policy-registry.js';

interface FusionConfig {
  readonly rrfK: number;
  readonly sparseWeight: number;
  readonly denseWeight: number;
  readonly anchorWeight: number;
  readonly learnedSparseWeight: number;
}

export type QueryClass = LiveFusionQueryClass;

export const DEFAULT_FUSION_CONFIG: FusionConfig = LIVE_FUSION_CONFIGS.fallback;

export const PER_CLASS_FUSION: ReadonlyMap<QueryClass, FusionConfig> = new Map(
  Object.entries(LIVE_FUSION_CONFIGS) as readonly (readonly [QueryClass, FusionConfig])[],
);

export function getFusionConfig(queryClass: string): FusionConfig {
  return getLiveFusionConfig(queryClass);
}

export function mapDomainQueryClassToFusionQueryClass(
  qc: DomainQueryClass,
  runtimeMode?: string,
): QueryClass {
  return mapDomainQueryClassToLiveFusionQueryClass(qc, runtimeMode);
}
