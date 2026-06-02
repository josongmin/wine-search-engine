/** Ambiguity record returned for a single surface form. */
export interface AmbiguityInfo {
  readonly types: string[];
  readonly severity: 'low' | 'medium' | 'high';
  /**
   * Member entity ids of the ambiguity cluster (the surface form maps to ≥2
   * distinct entities). Optional — only PG-backed implementations that persist
   * `entity_ids` populate it; omitted (NOT empty) when the substrate does not
   * carry cluster membership. Consumed by the T-ELV2-06 cluster-membership
   * feature; omit-when-absent for exactOptionalPropertyTypes.
   */
  readonly entityIds?: readonly string[];
}

/**
 * Port for querying a dictionary of known ambiguous surface forms.
 *
 * Used by the planner to detect ambiguity early and adjust uncertainty
 * and policy accordingly. Infrastructure adapters may back this with a
 * static file, database table, or external service.
 */
export interface AmbiguityDictionary {
  /**
   * Checks whether the given surface form is a known ambiguous term.
   * @param surfaceForm - The normalized surface form to check.
   * @param signal - Optional {@link AbortSignal}; aborts the lookup query (WSE-01).
   * @returns `true` if the term is registered as ambiguous.
   */
  isKnownAmbiguous(surfaceForm: string, signal?: AbortSignal): Promise<boolean>;

  /**
   * Retrieves detailed ambiguity information for a surface form.
   * @param surfaceForm - The normalized surface form to look up.
   * @param signal - Optional {@link AbortSignal}; aborts the lookup query (WSE-01).
   * @returns Ambiguity types and severity, or `null` if not known ambiguous.
   */
  getAmbiguityInfo(surfaceForm: string, signal?: AbortSignal): Promise<AmbiguityInfo | null>;

  /**
   * Batch variant of {@link getAmbiguityInfo}. Returns a map keyed by the
   * original surface form (no normalisation applied by the port). Surface
   * forms that are NOT registered ambiguous are simply absent from the map.
   *
   * Performance rationale (C3): the planner calls this for every anchor when
   * computing uncertainty. A sequential per-anchor await against a remote
   * substrate (PG/RDS) caused 20+ second planner stalls on popular queries
   * with many alias-matched anchors. The batch shape collapses N round-trips
   * into a single one. Implementations MUST treat the input as a set
   * (deduplicate internally) and MAY return an empty map when the underlying
   * substrate is unavailable — same degradation contract as the singular
   * `getAmbiguityInfo`.
   */
  getAmbiguityInfoBatch(
    surfaceForms: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, AmbiguityInfo>>;
}
