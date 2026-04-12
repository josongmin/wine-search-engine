import type { AmbiguityDictionary } from '../domain/query/port/ambiguity-dictionary.port.js';
import type { BlockingPort } from '../domain/resolver/port/blocking.port.js';
import type {
  CalibrationParams,
  CalibrationStore,
} from '../domain/resolver/port/calibration-store.port.js';
import type { EmbeddingServicePort } from '../domain/retrieval/port/embedding-service.port.js';
import type { ThresholdStore } from '../domain/query/port/threshold-store.port.js';
import {
  DEFAULT_THRESHOLD_PROFILE,
  type ThresholdProfileV1,
} from '../domain/query/model/threshold-profile.js';
import type {
  CanonicalEntityId,
  QueryClass,
} from '../domain/shared/types/index.js';
import type {
  AliasMatchResult,
  AliasMatcher,
} from '../domain/query/service/anchor-extractor.js';

/** Bit shift for djb2-style rolling hash in deterministic stub vectors. */
const STUB_EMBED_HASH_SHIFT = 5;
/** 16-bit mask normalizing hash to [0, 1] before scaling to [-1, 1]. */
const STUB_EMBED_UINT16_MAX = 0xffff;

export class StubBlockingPort implements BlockingPort {
  block(
    _query: string,
    _normalizedQuery: string,
    _limit?: number,
  ): Promise<readonly CanonicalEntityId[]> {
    return Promise.resolve([]);
  }
}

export class StubCalibrationStore implements CalibrationStore {
  getCalibrationParams(_queryClass: QueryClass): Promise<CalibrationParams | null> {
    return Promise.resolve(null);
  }

  save(_queryClass: QueryClass, _params: CalibrationParams): Promise<void> {
    return Promise.resolve();
  }
}

export class StubEmbeddingService implements EmbeddingServicePort {
  private readonly dimension: number;

  constructor(dimension = 1024) {
    this.dimension = dimension;
  }

  private hashToVector(text: string): readonly number[] {
    const vec = new Array<number>(this.dimension);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << STUB_EMBED_HASH_SHIFT) - hash + text.charCodeAt(i)) | 0;
    }
    for (let i = 0; i < this.dimension; i++) {
      hash = ((hash << STUB_EMBED_HASH_SHIFT) - hash + i) | 0;
      vec[i] = ((hash & STUB_EMBED_UINT16_MAX) / STUB_EMBED_UINT16_MAX) * 2 - 1;
    }
    return vec;
  }

  embed(text: string): Promise<readonly number[]> {
    return Promise.resolve(this.hashToVector(text));
  }

  embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return Promise.resolve(texts.map((t) => this.hashToVector(t)));
  }
}

export class StubAmbiguityDictionary implements AmbiguityDictionary {
  isKnownAmbiguous(_term: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  getAmbiguityInfo(
    _term: string,
  ): Promise<{ types: string[]; severity: 'low' | 'medium' | 'high' } | null> {
    return Promise.resolve(null);
  }
}

export class StubAliasMatcher implements AliasMatcher {
  findMatches(_normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    return Promise.resolve([]);
  }
}

export class StubThresholdStore implements ThresholdStore {
  getProfile(_id: string): Promise<ThresholdProfileV1 | null> {
    return Promise.resolve(DEFAULT_THRESHOLD_PROFILE);
  }

  getDefault(): Promise<ThresholdProfileV1> {
    return Promise.resolve(DEFAULT_THRESHOLD_PROFILE);
  }

  save(_profile: ThresholdProfileV1): Promise<void> {
    return Promise.resolve();
  }
}
