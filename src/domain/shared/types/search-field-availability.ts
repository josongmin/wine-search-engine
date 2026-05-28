export interface SearchFieldAvailabilityMetric {
  readonly populatedDocCount: number;
  readonly totalDocCount: number;
  readonly populatedDocRatio: number;
}

export const ZERO_SEARCH_FIELD_AVAILABILITY_METRIC: SearchFieldAvailabilityMetric = {
  populatedDocCount: 0,
  totalDocCount: 0,
  populatedDocRatio: 0,
};

export const SEARCH_SNAPSHOT_SENSORY_FIELD_AVAILABILITY_ATTRIBUTES = [
  'body',
  'sweetness',
  'acidity',
  'tannin',
] as const;

export type SearchSnapshotSensoryFieldAvailabilityAttribute =
  (typeof SEARCH_SNAPSHOT_SENSORY_FIELD_AVAILABILITY_ATTRIBUTES)[number];

export interface SearchSnapshotFieldAvailability {
  readonly appellation: SearchFieldAvailabilityMetric;
  readonly body: SearchFieldAvailabilityMetric;
  readonly sweetness: SearchFieldAvailabilityMetric;
  readonly acidity: SearchFieldAvailabilityMetric;
  readonly tannin: SearchFieldAvailabilityMetric;
}

export const DEFAULT_SEARCH_SNAPSHOT_FIELD_AVAILABILITY: SearchSnapshotFieldAvailability = {
  appellation: {
    ...ZERO_SEARCH_FIELD_AVAILABILITY_METRIC,
  },
  body: {
    ...ZERO_SEARCH_FIELD_AVAILABILITY_METRIC,
  },
  sweetness: {
    ...ZERO_SEARCH_FIELD_AVAILABILITY_METRIC,
  },
  acidity: {
    ...ZERO_SEARCH_FIELD_AVAILABILITY_METRIC,
  },
  tannin: {
    ...ZERO_SEARCH_FIELD_AVAILABILITY_METRIC,
  },
};

export const APPELLATION_HARD_FILTER_MIN_POPULATED_RATIO = 0.5;
export const SENSORY_SOFT_PROMOTION_MIN_POPULATED_RATIO = 0.5;

function isFieldAvailabilityMetricAvailable(
  metric: SearchFieldAvailabilityMetric,
  minPopulatedRatio: number,
): boolean {
  return metric.totalDocCount > 0 && metric.populatedDocRatio >= minPopulatedRatio;
}

export function isAppellationHardFilterAvailable(
  fieldAvailability: SearchSnapshotFieldAvailability | undefined,
): boolean {
  if (fieldAvailability === undefined) {
    return false;
  }
  return isFieldAvailabilityMetricAvailable(
    fieldAvailability.appellation,
    APPELLATION_HARD_FILTER_MIN_POPULATED_RATIO,
  );
}

export function isSensorySoftPromotionAvailable(
  fieldAvailability: SearchSnapshotFieldAvailability | undefined,
  attribute: SearchSnapshotSensoryFieldAvailabilityAttribute,
): boolean {
  if (fieldAvailability === undefined) {
    return false;
  }
  return isFieldAvailabilityMetricAvailable(
    fieldAvailability[attribute],
    SENSORY_SOFT_PROMOTION_MIN_POPULATED_RATIO,
  );
}
