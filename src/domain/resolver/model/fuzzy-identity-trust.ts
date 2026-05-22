/**
 * SSoT for the fuzzy-identity trust threshold (CLAUDE.md rule 30).
 *
 * A fuzzy alias match is only allowed to act as a TRUST SUBSTITUTE for the
 * calibration trust gate (decision-engine `applyCalibrationTrustGate`) when the
 * underlying matcher accepted the candidate at or above this string-similarity
 * floor. The matcher gate (which decides whether a fuzzy candidate is promoted
 * to an `alias_fuzzy` identity artifact at all) and the decision-layer trust
 * predicate must reference the SAME value so they cannot drift — hence this
 * single exported constant.
 *
 * Value rationale: a Damerau-OSA / Jaro-Winkler similarity of 0.8 is the
 * tightest floor at which a single edit-distance-1 typo of a real wine surface
 * ("opuss one" → "opus one") still clears, while genuinely different surfaces
 * fall below it. This matches the in-memory matcher's documented fuzzy gate.
 * Production's pg-alias-matcher uses a richer multi-signal `max` scheme whose
 * effective floor sits ABOVE this value (so it is strictly stricter, never
 * looser) — it deliberately does NOT import this constant, to avoid coupling a
 * single-signal test gate to its multi-signal production scheme. See the
 * comment block above `FUZZY_SIMILARITY_THRESHOLD` in the in-memory matcher.
 */
export const FUZZY_IDENTITY_TRUST_MIN_SIMILARITY = 0.8;
