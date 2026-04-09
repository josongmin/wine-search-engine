/**
 * Deterministic A/B experiment assignment.
 *
 * Same (requestId, experimentId) pair always assigns to the same variant —
 * deterministic so a request that crosses service boundaries observes the
 * same variant on every hop. FNV-1a hash on the concatenated key, mod 1000,
 * walks variant weights to find the bucket. Outside any variant → 'control'.
 */

export interface ExperimentVariant {
  readonly name: string;
  /** Allocation as a fraction of traffic [0, 1]. Sum across variants ≤ 1. */
  readonly weight: number;
}

export interface ExperimentDefinition {
  readonly experimentId: string;
  readonly variants: readonly ExperimentVariant[];
}

export interface AssignmentResult {
  readonly experimentId: string;
  readonly variant: string;
  readonly bucket: number;
}

/** Bucket cardinality. 1000 = 0.1% allocation precision. */
const BUCKET_COUNT = 1000;
/** Default variant when no experiment-defined range catches the bucket. */
const DEFAULT_VARIANT_NAME = 'control';

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

function fnv1a(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Force unsigned 32-bit multiply.
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

export class ExperimentAssigner {
  private readonly index: ReadonlyMap<string, ExperimentDefinition>;

  constructor(definitions: readonly ExperimentDefinition[]) {
    const map = new Map<string, ExperimentDefinition>();
    for (const def of definitions) {
      map.set(def.experimentId, def);
    }
    this.index = map;
  }

  assign(requestId: string, experimentId: string): AssignmentResult {
    const def = this.index.get(experimentId);
    if (def === undefined || def.variants.length === 0) {
      return { experimentId, variant: DEFAULT_VARIANT_NAME, bucket: 0 };
    }
    const bucket = fnv1a(`${experimentId}:${requestId}`) % BUCKET_COUNT;
    let cumulative = 0;
    for (const variant of def.variants) {
      const w = Number.isFinite(variant.weight) && variant.weight > 0 ? variant.weight : 0;
      cumulative += w * BUCKET_COUNT;
      if (bucket < cumulative) {
        return { experimentId, variant: variant.name, bucket };
      }
    }
    return { experimentId, variant: DEFAULT_VARIANT_NAME, bucket };
  }
}
