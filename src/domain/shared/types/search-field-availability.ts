export interface SearchFieldAvailabilityMetric {
  readonly populatedDocCount: number;
  readonly totalDocCount: number;
  readonly populatedDocRatio: number;
}

export interface SearchSnapshotFieldAvailability {
  readonly appellation: SearchFieldAvailabilityMetric;
}

export const DEFAULT_SEARCH_SNAPSHOT_FIELD_AVAILABILITY: SearchSnapshotFieldAvailability = {
  appellation: {
    populatedDocCount: 0,
    totalDocCount: 0,
    populatedDocRatio: 0,
  },
};

export const APPELLATION_HARD_FILTER_MIN_POPULATED_RATIO = 0.5;

export function isAppellationHardFilterAvailable(
  fieldAvailability: SearchSnapshotFieldAvailability | undefined,
): boolean {
  if (fieldAvailability === undefined) {
    return false;
  }
  const { populatedDocRatio, totalDocCount } = fieldAvailability.appellation;
  return totalDocCount > 0 && populatedDocRatio >= APPELLATION_HARD_FILTER_MIN_POPULATED_RATIO;
}
