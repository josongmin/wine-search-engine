/**
 * Shared domain constants — single source of truth for values used
 * across multiple layers (HTTP schema, sanitizer, etc.).
 *
 * Each constant must be backed by a domain fact, not a developer's guess.
 * Adding a new constant: cite the source (RFC, real-world data, regulation).
 */

/**
 * Maximum allowed query length in characters.
 *
 * Set to 2000 — the SAME bound as the sanitizer's pre-regex ReDoS guard
 * (`MAX_QUERY_LENGTH_FOR_REDOS_GUARD` in query-sanitizer.ts). 2000 is the
 * largest input at which the injection-detection regexes are still evaluated;
 * anything above it bypasses pattern screening entirely (O(1) bail), so it is
 * the principled security ceiling for any query that must still be screened.
 *
 * Historically this was 500 ("legitimate single-shot queries never approach
 * 500"). That assumption breaks for the agent CLI / multi-turn flows, which
 * compose prior conversation context into a single stateless query. Raising to
 * the regex-screening ceiling lets context-rich queries through while keeping
 * every safety pattern in force. It MUST NOT exceed the ReDoS guard — see
 * query-sanitizer.ts.
 */
export const MAX_QUERY_LENGTH = 2_000;

/**
 * Minimum allowed vintage year for produced wine.
 * Why 1700: 18th-century Madeira and Port wines from this era are still
 * traded at auction (e.g. 1715 Madeira). Setting the bound to 1900 (as we
 * did initially) silently rejected legitimate historical wines and broke
 * response validation. See round-8 audit findings.
 */
export const MIN_PRODUCED_VINTAGE_YEAR = 1700;

/**
 * Maximum allowed vintage year — far enough in the future to permit
 * pre-release listings, but bounded enough to catch obvious bad data.
 */
export const MAX_PRODUCED_VINTAGE_YEAR = 2200;

/**
 * Lower bound for deterministic drinking-window math.
 *
 * Why narrower than `MIN_PRODUCED_VINTAGE_YEAR = 1700`: 18th-century Madeira /
 * Port records exist in raw catalogs and must be accepted at ingestion, but
 * the deterministic structural formula has no calibration anchors below the
 * 19th century (modern viticulture, market signals, sensory ordinals are all
 * 1800+). Accepting 1700–1799 vintages would silently push the formula into
 * an extrapolation regime where every term is fabricated.
 */
export const DETERMINISTIC_DRINKING_WINDOW_MIN_VINTAGE_YEAR = 1800;

/**
 * FX single source of truth.
 *
 * This module is the ONE place FX rates are defined. Both the query side
 * (`FxRatePort` → NL price extraction) and the index side (ETL
 * `vivino-to-silver` FX catalog) MUST derive from these anchors so that a
 * "€50 이하" query and a €50-priced wine resolve to the SAME USD value.
 *
 * Anchors (mid-2025 reference rates; soft filters only, no live FX API):
 *   - KRW per USD = 1350
 *   - USD per EUR = 1.08
 *   - USD per GBP = 1.27
 *
 * The cross rates (KRW per EUR/GBP) are DERIVED, never hand-written, because
 * `KRW_PER_EUR = KRW_PER_USD × USD_PER_EUR` is exactly the identity that makes
 * query-side and index-side conversions agree. Hand-writing them (the historic
 * 1470/1720) silently broke boundary-price matching. See
 * `test/regression/fx-rate-ssot-parity.regression.test.ts`.
 */
export const KRW_PER_USD_APPROXIMATE = 1350;

/** USD per 1 EUR. Anchor — `vivino-to-silver` indexes EUR prices with this. */
export const USD_PER_EUR_APPROXIMATE = 1.08;

/** USD per 1 GBP. Anchor — `vivino-to-silver` indexes GBP prices with this. */
export const USD_PER_GBP_APPROXIMATE = 1.27;

/**
 * KRW in one Korean "만원" (10,000 won) unit — used in 만원/천원 parsers.
 */
export const KRW_PER_MAN_WON = 10_000;

/**
 * KRW in one "천원" (1,000 won) unit.
 */
export const KRW_PER_CHEON_WON = 1_000;

/**
 * KRW in one "억원" (100,000,000 won) unit. Used for high-end wine
 * price queries (e.g. "1억원 이상 그랑크뤼"). 1억 = 10^8 = 100 million.
 */
export const KRW_PER_EOK_WON = 100_000_000;

/**
 * KRW per EUR — DERIVED from the anchors (KRW_PER_USD × USD_PER_EUR ≈ 1458).
 * Do not hand-write: the derivation is what guarantees that "€50 이하" (query
 * side) and a €50-priced wine (index side) collapse to the same USD value.
 */
export const KRW_PER_EUR_APPROXIMATE = KRW_PER_USD_APPROXIMATE * USD_PER_EUR_APPROXIMATE;

/**
 * KRW per GBP — DERIVED from the anchors (KRW_PER_USD × USD_PER_GBP ≈ 1714.5).
 * See {@link KRW_PER_EUR_APPROXIMATE} for why this must stay derived.
 */
export const KRW_PER_GBP_APPROXIMATE = KRW_PER_USD_APPROXIMATE * USD_PER_GBP_APPROXIMATE;
