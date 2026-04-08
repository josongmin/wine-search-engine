/**
 * Shared domain constants — single source of truth for values used
 * across multiple layers (HTTP schema, sanitizer, etc.).
 *
 * Each constant must be backed by a domain fact, not a developer's guess.
 * Adding a new constant: cite the source (RFC, real-world data, regulation).
 */

/** Maximum allowed query length in characters. */
export const MAX_QUERY_LENGTH = 500;

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
