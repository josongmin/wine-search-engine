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
  EntityId,
  QueryClass,
} from '../domain/shared/types/index.js';
import type {
  AliasMatchResult,
  AliasMatcher,
} from '../domain/query/service/anchor-extractor.js';

export class StubBlockingPort implements BlockingPort {
  block(
    _query: string,
    _normalizedQuery: string,
    _limit?: number,
  ): Promise<readonly EntityId[]> {
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
  embed(_text: string): Promise<readonly number[]> {
    return Promise.resolve(new Array<number>(128).fill(0));
  }

  embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return Promise.resolve(texts.map(() => new Array<number>(128).fill(0)));
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
