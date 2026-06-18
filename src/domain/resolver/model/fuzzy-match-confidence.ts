/**
 * Down-weights fuzzy edit-distance matches relative to exact alias confidence.
 * Rationale: edit-distance matches have higher false-positive rate (e.g. "Barolo"
 * vs "Barossa"), so the discount reflects additional ambiguity in fuzzy matching.
 *
 * SSoT — import from here. Do NOT redefine in projection or resolver-candidate
 * builders (Rule 30).
 */
export const FUZZY_EDIT_DISTANCE_CONFIDENCE_FACTOR = 0.8;
