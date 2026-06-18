import type { ResolverCandidate } from '../model/resolved-candidate.js';
import type { MatchSignalSet } from '../model/match-signal-set.js';

function hasCollisionFreeExactSafeCertificate(candidate: ResolverCandidate): boolean {
  return candidate.identityCertificates?.some((certificate) =>
    (certificate.kind === 'exact_safe' || certificate.kind === 'compact_exact_safe')
    && certificate.singleton === true
    && certificate.collisionFree === true,
  ) ?? false;
}

/**
 * Scoring weights for the weighted-sum scoring function, per RFC-006 §5.
 *
 * Weights reflect the relative importance of each match signal.
 * The hierarchy is: canonical > alias > producer > vintage > region > phonetic > edit_distance.
 * The ambiguity penalty is negative, reducing scores for ambiguous candidates.
 */
const SCORING_WEIGHTS = {
  canonicalExactMatch: 1.0,
  canonicalNormalizedMatch: 0.9,
  aliasExactMatch: 0.8,
  aliasFuzzyMatch: 0.5,
  producerMatch: 0.7,
  vintageMatch: 0.6,
  regionMatch: 0.5,
  grapeHintMatch: 0.3,
  phoneticMatch: 0.4,
  editDistanceScore: 0.3,
  ambiguityPenalty: -0.8,
} as const;

/**
 * Maximum contribution cap for catalog_noise_alias signals.
 * Prevents noisy aliases from dominating the score.
 */
const CATALOG_NOISE_ALIAS_CAP = 0.3;

/**
 * Maximum contribution cap for `derived_initialism` aliases (caps-initialism
 * derived deterministically from canonical labels at index time).
 *
 * Initialisms collide more often than curated aliases ("CM" matches Château
 * Margaux AND Cloudy Mountain AND any other entity whose label starts with
 * those two words). The cap keeps the resolver from emitting a confident
 * single-entity decision purely on an initialism — disambiguation needs
 * either a vintage / region / producer signal or a fuzzy-match boost.
 */
const DERIVED_INITIALISM_CAP = 0.55;

/**
 * Maximum contribution cap for `abbreviation` aliases (curated / LLM-proposed
 * wine-community shorthand, gated by a review workflow before landing in
 * `aliases`).
 *
 * Sits above {@link DERIVED_INITIALISM_CAP} because curated abbreviations
 * include explicit producer+vintage compounds ("CM 15", "DRC 19") whose
 * collision risk is dramatically lower than bare initialisms. The cap still
 * sits below the canonical signal so a bare initialism ("CM") cannot beat a
 * canonical normalized match for a different entity — disambiguation
 * remains evidence-driven.
 */
const ABBREVIATION_CAP = 0.7;

/**
 * Maximum raw-score contribution from a candidate matched ONLY via phonetic
 * provenance (every `aliasMatch` is `aliasType === 'phonetic'`, i.e. found via
 * the consonant-skeleton or Double Metaphone phonetic phase — never an exact /
 * lexical / transliterated alias hit).
 *
 * WHY A CAP (RFC-006 §5.4): phonetic similarity is structurally WEAKER evidence
 * than an exact or alias match. Double Metaphone (Philips 2000) buckets
 * dissimilar surfaces under one code (Margaux↔Margeaux, but also collision-prone
 * gibberish↔real-wine pairs). Without a ceiling a phonetic-only candidate enters
 * the scorer through the SAME `aliasExactMatch` (weight 0.8) and even
 * `canonicalExactMatch` (weight 1.0) lanes as a genuine exact hit — because
 * `phonetic_exact` is classified `exactLike` in `lookup-strategy-taxonomy.ts`
 * for RECALL. That mislabels HOW the match was found as full identity evidence,
 * inflating the calibrated confidence C of gibberish above T_resolve and tying a
 * phonetic collision with a real exact alias hit.
 *
 * WHY 0.34: in the resolve gate C is monotone in this raw total (the identity /
 * isotonic calibration path is order-preserving), and the SMALLEST per-class
 * `resolveTau` in `threshold-profile.ts` is 0.35 (`pure_constraint`). Capping the
 * phonetic-only contribution at 0.34 keeps it STRICTLY below every `resolveTau`,
 * so a phonetic-only match can never ALONE clear the resolve threshold. It still
 * leaves full headroom for corroboration: a single producer (0.7), vintage (0.6),
 * or region (0.5) signal lifts the total well past any threshold, so a clearly-
 * intended phonetic match with supporting evidence still resolves. The value is
 * intentionally below `DERIVED_INITIALISM_CAP` (0.55) — a phonetic collision is
 * even less identity-bearing than a derived initialism, which at least shares
 * the canonical's leading characters.
 */
const PHONETIC_ONLY_CONTRIBUTION_CEILING = 0.34;

/**
 * Scores resolution candidates using a weighted-sum function over
 * match signals, per RFC-006 §5.
 *
 * The scorer produces raw (uncalibrated) scores. These scores MUST be
 * calibrated by the {@link Calibrator} before any threshold comparison.
 */
export class CandidateScorer {
  /**
   * Computes a raw match score for a single candidate by applying the
   * weighted-sum formula to its source signals.
   *
   * @param candidate - A resolver candidate with populated source signals.
   * @returns A raw score (not calibrated). Higher is better.
   */
  score(candidate: ResolverCandidate): number {
    const signals = candidate.sourceSignals;
    const cappedSignals = this.applyAliasCaps(signals, candidate);
    const adjustedSignals = this.applyPhoneticOnlyCap(cappedSignals, candidate);

    let total = 0;
    total += SCORING_WEIGHTS.canonicalExactMatch * adjustedSignals.canonicalExactMatch;
    total += SCORING_WEIGHTS.canonicalNormalizedMatch * adjustedSignals.canonicalNormalizedMatch;
    total += SCORING_WEIGHTS.aliasExactMatch * adjustedSignals.aliasExactMatch;
    total += SCORING_WEIGHTS.aliasFuzzyMatch * adjustedSignals.aliasFuzzyMatch;
    total += SCORING_WEIGHTS.producerMatch * adjustedSignals.producerMatch;
    total += SCORING_WEIGHTS.vintageMatch * adjustedSignals.vintageMatch;
    total += SCORING_WEIGHTS.regionMatch * adjustedSignals.regionMatch;
    total += SCORING_WEIGHTS.grapeHintMatch * adjustedSignals.grapeHintMatch;
    total += SCORING_WEIGHTS.phoneticMatch * adjustedSignals.phoneticMatch;
    total += SCORING_WEIGHTS.editDistanceScore * adjustedSignals.editDistanceScore;
    total += SCORING_WEIGHTS.ambiguityPenalty * adjustedSignals.ambiguityPenalty;

    return total;
  }

  /**
   * Applies alias-type-specific caps to prevent noisy alias sources from
   * inflating scores beyond their reliability level.
   *
   * - `catalog_noise_alias` contributions are capped at {@link CATALOG_NOISE_ALIAS_CAP}.
   * - `observed_query_alias` contributions are allowed but cannot override
   *   core (canonical/translation) signal matches.
   */
  private applyAliasCaps(
    signals: MatchSignalSet,
    candidate: ResolverCandidate,
  ): MatchSignalSet {
    const hasCatalogNoise = candidate.aliasMatches.some(
      (m) => m.aliasType === 'catalog_noise_alias',
    );
    const hasObservedQuery = candidate.aliasMatches.some(
      (m) => m.aliasType === 'observed_query_alias',
    );
    // The derived-initialism cap fires only when *every* alias match on the
    // candidate is a derived initialism. `.some()` would silently downgrade
    // candidates whose curated signal coexists with an initialism sibling
    // (e.g. curated 'Masi Amarone' alongside derived 'MA' both anchoring
    // to the same entity). Per RFC-006 §5.4 the cap exists to handle the
    // *collision-prone* pure-initialism case ("CM" → many producers); when
    // any non-derived evidence is present the resolver already has full
    // canonical signal and the cap must not engage.
    const hasDerivedInitialism =
      candidate.aliasMatches.length > 0 &&
      candidate.aliasMatches.every((m) => m.aliasType === 'derived_initialism');
    const hasAbbreviation = candidate.aliasMatches.some(
      (m) => m.aliasType === 'abbreviation',
    );

    let aliasExactMatch = signals.aliasExactMatch;
    let aliasFuzzyMatch = signals.aliasFuzzyMatch;

    // Cap catalog_noise_alias contribution
    if (hasCatalogNoise && !this.hasCoreAliasMatch(candidate)) {
      aliasExactMatch = Math.min(aliasExactMatch, CATALOG_NOISE_ALIAS_CAP);
      aliasFuzzyMatch = Math.min(aliasFuzzyMatch, CATALOG_NOISE_ALIAS_CAP);
    }

    // observed_query_alias: allow contribution but ensure it does not
    // override canonical or translation matches by capping at the
    // canonical normalized match level when no core match is present.
    if (
      hasObservedQuery
      && !this.hasCoreAliasMatch(candidate)
      && !hasCollisionFreeExactSafeCertificate(candidate)
    ) {
      aliasExactMatch = Math.min(aliasExactMatch, signals.canonicalNormalizedMatch);
      aliasFuzzyMatch = Math.min(aliasFuzzyMatch, signals.canonicalNormalizedMatch);
    }

    // derived_initialism: structural recall lever, but high collision rate.
    // Cap below catalog_noise's neighbour band so the resolver still
    // requires corroborating signal (vintage, region, producer) before
    // resolving on an initialism alone.
    if (hasDerivedInitialism && !this.hasCoreAliasMatch(candidate)) {
      aliasExactMatch = Math.min(aliasExactMatch, DERIVED_INITIALISM_CAP);
      aliasFuzzyMatch = Math.min(aliasFuzzyMatch, DERIVED_INITIALISM_CAP);
    }

    // abbreviation: curated/LLM-proposed shorthand. Cap above derived
    // initialisms (curated compounds carry vintage anchors) but still
    // below the canonical band so a wrong-entity abbreviation cannot
    // outscore a canonical normalized match for a different entity.
    if (hasAbbreviation && !this.hasCoreAliasMatch(candidate)) {
      aliasExactMatch = Math.min(aliasExactMatch, ABBREVIATION_CAP);
      aliasFuzzyMatch = Math.min(aliasFuzzyMatch, ABBREVIATION_CAP);
    }

    return {
      ...signals,
      aliasExactMatch,
      aliasFuzzyMatch,
    };
  }

  /**
   * Caps the contribution of a candidate matched ONLY via phonetic provenance.
   *
   * Provenance-driven (NOT query-pattern-driven): the cap engages iff EVERY
   * alias match on the candidate is `aliasType === 'phonetic'`. The moment a
   * single non-phonetic match coexists (exact / lexical / transliterated alias,
   * curated abbreviation, …) the candidate has identity-bearing evidence and the
   * cap must NOT engage — mirroring the `every(...)` gate used by
   * {@link DERIVED_INITIALISM_CAP} so a phonetic sibling never downgrades a
   * candidate that ALSO has a real alias hit. This is what lets an EXACT alias
   * hit dominate a competing phonetic-only collision (e.g. "romanee conti" exact
   * vs a phonetic near-tie): only the phonetic-only side is ceilinged.
   *
   * The phonetic phase reuses the `phonetic_exact` strategy which
   * `lookup-strategy-taxonomy.ts` classifies `exactLike` for RECALL. As a side
   * effect `buildSignals` populates SEVERAL lanes from the SAME phonetic hit:
   * `phoneticMatch`, `aliasExactMatch`, and (when the normalized surfaces happen
   * to coincide) `canonicalExactMatch` / `canonicalNormalizedMatch`. These are
   * the same recall artifact double-counted across lanes — not independent
   * evidence. The weighted sum of those lanes is what inflated C.
   *
   * Fix: collapse the phonetic-only evidence to a SINGLE bounded lane.
   *   1. Zero the identity lanes that misrepresent a phonetic hit as an exact /
   *      canonical / alias match (`canonicalExactMatch`, `canonicalNormalizedMatch`,
   *      `aliasExactMatch`, `aliasFuzzyMatch`, `editDistanceScore`).
   *   2. Route the surviving evidence through the single `phoneticMatch` lane
   *      (weight {@link SCORING_WEIGHTS.phoneticMatch}) and clamp that lane so its
   *      WEIGHTED contribution cannot exceed {@link PHONETIC_ONLY_CONTRIBUTION_CEILING}.
   *
   * The phonetic-only total is therefore exactly one bounded term, strictly
   * below every resolveTau. Corroborating signals (producer / vintage / region /
   * grape) are NOT touched, so a clearly-intended phonetic match with supporting
   * evidence still resolves.
   */
  private applyPhoneticOnlyCap(
    signals: MatchSignalSet,
    candidate: ResolverCandidate,
  ): MatchSignalSet {
    // Provenance gate: phonetic-only candidates are detected by EITHER source
    //   (a) the alias-match metadata says every match is `aliasType: 'phonetic'`
    //       — true for curated phonetic aliases (`alias_type='phonetic'` rows);
    //   (b) the upstream `buildSignals` zeroed every identity-bearing lane
    //       except `phoneticMatch` — true for any anchor whose lookup-strategy
    //       set is purely phonetic (Double Metaphone / consonant skeleton)
    //       regardless of the matched alias's stored type. This is the SSoT
    //       provenance tag carried in the signal vector itself: a non-zero
    //       phoneticMatch with zero exact/canonical/alias lanes is, by
    //       construction, a phonetic-only hit (see buildSignals'
    //       isPhoneticOnlyStrategySet branch).
    //
    // Either gate alone is sufficient to engage the cap — the moment a
    // non-phonetic identity signal coexists the cap stands down (no
    // over-correction).
    const isPhoneticOnlyByAliasType =
      candidate.aliasMatches.length > 0 &&
      candidate.aliasMatches.every((m) => m.aliasType === 'phonetic');
    const isPhoneticOnlyBySignals =
      signals.phoneticMatch > 0 &&
      signals.canonicalExactMatch === 0 &&
      signals.canonicalNormalizedMatch === 0 &&
      signals.aliasExactMatch === 0 &&
      signals.aliasFuzzyMatch === 0 &&
      signals.editDistanceScore === 0;
    if (!isPhoneticOnlyByAliasType && !isPhoneticOnlyBySignals) {
      return signals;
    }

    // Strongest phonetic-evidence value across the lanes the recall phase
    // populated from the single phonetic hit (they all carry the same anchor
    // confidence; take the max to be robust to which lane was set).
    const phoneticEvidence = Math.max(
      signals.phoneticMatch,
      signals.aliasExactMatch,
      signals.aliasFuzzyMatch,
      signals.canonicalExactMatch,
      signals.canonicalNormalizedMatch,
    );

    // Clamp so weight * phoneticMatch <= ceiling. weight is a positive constant,
    // so the lane bound is ceiling / weight.
    const phoneticLaneBound = PHONETIC_ONLY_CONTRIBUTION_CEILING / SCORING_WEIGHTS.phoneticMatch;
    const phoneticMatch = Math.min(phoneticEvidence, phoneticLaneBound);

    return {
      ...signals,
      canonicalExactMatch: 0,
      canonicalNormalizedMatch: 0,
      aliasExactMatch: 0,
      aliasFuzzyMatch: 0,
      editDistanceScore: 0,
      phoneticMatch,
    };
  }

  /**
   * Checks whether the candidate has at least one match from a core
   * (high-trust) alias type: canonical or translation.
   *
   * `phonetic` is intentionally EXCLUDED. Phonetic provenance is weaker
   * evidence than an exact / alias / translation match (RFC-006 §5.4); treating
   * it as "core" would bypass the alias caps (catalog-noise / initialism /
   * abbreviation) and let a phonetic-only collision inflate confidence. Phonetic
   * candidates are bounded separately by {@link applyPhoneticOnlyCap}.
   */
  private hasCoreAliasMatch(candidate: ResolverCandidate): boolean {
    return candidate.aliasMatches.some(
      (m) =>
        m.aliasType === 'canonical' ||
        m.aliasType === 'translation',
    );
  }
}
