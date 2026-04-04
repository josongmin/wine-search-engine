/**
 * Freeform attribute bag attached to an Entity.
 * Not every attribute applies to every entity type;
 * the domain services validate required attributes per type.
 */
export interface EntityAttributes {
  /** Grape varieties (e.g. ["Pinot Noir", "Chardonnay"]) */
  readonly grapes?: readonly string[];
  /** Wine style (e.g. "red", "white", "rosé", "sparkling") */
  readonly style?: string;
  /** Body score, 0.0 (light) to 1.0 (full) */
  readonly body?: number;
  /** Sweetness score, 0.0 (dry) to 1.0 (sweet) */
  readonly sweetness?: number;
  /** Acidity score, 0.0 to 1.0 */
  readonly acidity?: number;
  /** Tannin score, 0.0 to 1.0 */
  readonly tannin?: number;
  /** Region name as free text */
  readonly region?: string;
  /** Price band label (e.g. "budget", "mid", "premium", "luxury") */
  readonly priceBand?: string;
  /** Vintage year (required for 'vintage' entities) */
  readonly vintage?: number;
  /** Food pairing suggestions */
  readonly pairing?: readonly string[];
  /** Occasion suggestions */
  readonly occasion?: readonly string[];
}
