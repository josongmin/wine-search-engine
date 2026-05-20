import type { LoadedFeature } from './load.js';
import type { Category, Maturity, Status } from '../schema/feature.schema.js';

export interface CatalogStats {
  readonly total: number;
  readonly byMaturity: Readonly<Record<Maturity, number>>;
  readonly byCategory: ReadonlyMap<Category, number>;
  readonly byStatus: Readonly<Record<Status, number>>;
}

export function computeStats(
  features: readonly LoadedFeature[],
): CatalogStats {
  const byMaturity: Record<Maturity, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const byCategory = new Map<Category, number>();
  const byStatus: Record<Status, number> = {
    active: 0,
    deprecated: 0,
    experimental: 0,
    planned: 0,
  };

  for (const { feature } of features) {
    byMaturity[feature.maturity] += 1;
    byCategory.set(
      feature.category,
      (byCategory.get(feature.category) ?? 0) + 1,
    );
    byStatus[feature.status] += 1;
  }

  return {
    total: features.length,
    byMaturity,
    byCategory,
    byStatus,
  };
}
