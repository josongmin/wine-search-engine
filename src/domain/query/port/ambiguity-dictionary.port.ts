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
   * @returns `true` if the term is registered as ambiguous.
   */
  isKnownAmbiguous(surfaceForm: string): Promise<boolean>;

  /**
   * Retrieves detailed ambiguity information for a surface form.
   * @param surfaceForm - The normalized surface form to look up.
   * @returns Ambiguity types and severity, or `null` if not known ambiguous.
   */
  getAmbiguityInfo(
    surfaceForm: string,
  ): Promise<{
    types: string[];
    severity: 'low' | 'medium' | 'high';
  } | null>;
}
