import type { Pool } from 'pg';
import type { Config } from './env.js';
import type { RuntimeHandles } from './runtime-handles.js';
import { bindLiveSearchSnapshotRuntimeHandles } from './runtime-handles.js';
import type { EntityLookupV2UseCasePort } from '../application/search/port/search-route-usecases.port.js';
import {
  createLookupAuthorityServices,
  type LookupAuthorityBootstrapProfile,
  type LookupAuthorityRuntimeProbe,
} from './lookup-authority.js';

export interface LookupDirectContainer {
  readonly entityLookupV2UseCase: EntityLookupV2UseCasePort;
  readonly runtimeProbe: LookupAuthorityRuntimeProbe;
  readonly bootstrapProfile?: (LookupAuthorityBootstrapProfile & {
    readonly runtimeHandlesMs: number;
  });
}

export function normalizeRuntimeHandles(
  runtime: Pool | RuntimeHandles | undefined,
): RuntimeHandles {
  if (runtime === undefined) {
    return {};
  }
  if ('totalCount' in runtime) {
    return { pool: runtime };
  }
  return runtime;
}

export async function createLookupDirectContainer(
  config: Config,
  runtime: Pool | RuntimeHandles = {},
): Promise<LookupDirectContainer> {
  const runtimeHandlesStartedAt = performance.now();
  const runtimeHandles = await bindLiveSearchSnapshotRuntimeHandles(
    normalizeRuntimeHandles(runtime),
  );
  const runtimeHandlesMs = Number((performance.now() - runtimeHandlesStartedAt).toFixed(3));
  const authority = await createLookupAuthorityServices(config, runtimeHandles);

  return {
    entityLookupV2UseCase: authority.entityLookupV2UseCase,
    runtimeProbe: authority.runtimeProbe,
    bootstrapProfile: {
      runtimeHandlesMs,
      ...authority.bootstrapProfile,
    },
  };
}
