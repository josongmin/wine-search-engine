/**
 * Label encoder for categorical wine attributes.
 * Maps string values (grape variety, region, country) to integer codes.
 *
 * Part of Epic 15 data pipeline (drinking window prediction).
 * Version pinned to model encoding version: v1.0-enc20260405
 */

/**
 * ML pipeline label encoder (drinking-window / Epic 15). Distinct from
 * {@link ../../domain/ranking/service/wine-attribute-encoder.js#WineCatalogLabelEncoder}.
 */
export class MlPipelineLabelEncoder {
  private readonly mapping: Map<string, number>;
  private readonly oovCode: number = 999;

  /**
   * @param labels - List of unique label strings. Index becomes the encoded value.
   */
  constructor(labels: readonly string[]) {
    this.mapping = new Map();
    labels.forEach((label, idx) => {
      this.mapping.set(label, idx);
    });
  }

  /**
   * Encodes a label to its integer code.
   * Returns OOV code (999) if label not in vocabulary.
   */
  encode(label: string | null | undefined): number {
    if (label === null || label === undefined) {
      return this.oovCode;
    }
    return this.mapping.get(label) ?? this.oovCode;
  }

  /** Get vocabulary size (number of known labels, excluding OOV). */
  get vocabularySize(): number {
    return this.mapping.size;
  }
}

/**
 * Pre-built label encoders for wine catalog master data.
 * These encoders are frozen to the model encoding date: v1.0-enc20260405.
 *
 * Extracted from data/silver-final.ndjson via:
 * - Grape varieties: grapePrimary (non-null unique values)
 * - Regions: derived from region hierarchies or appellation
 * - Countries: country field (unique values)
 */
/** Namespace-style export: only static helpers (no instances). */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- static encoder registry
export class MlPipelineWineAttributeEncoders {
  private static readonly grapeEnc = new MlPipelineLabelEncoder([
    // Most common varieties (sorted by frequency in dataset)
    'Cabernet Sauvignon',
    'Pinot Noir',
    'Shiraz',
    'Merlot',
    'Chardonnay',
    'Sauvignon Blanc',
    'Riesling',
    'Cabernet Franc',
    'Syrah',
    'Grenache',
    'Nebbiolo',
    'Tempranillo',
    'Zinfandel',
    // Add more as needed; unknown = 999
  ]);

  private static readonly regionEnc = new MlPipelineLabelEncoder([
    // Major regions (top producers by frequency)
    'Napa Valley',
    'Bordeaux',
    'Burgundy',
    'Rhone Valley',
    'Tuscany',
    'Rioja',
    'Barossa Valley',
    'Willamette Valley',
    'Paso Robles',
    'Sonoma County',
    'Santa Barbara County',
    'Monterey County',
    'Central Coast',
    'Santa Lucia Highlands',
    'Happy Canyon of Santa Barbara',
    'Etna',
    'Gevrey-Chambertin',
    'Châteauneuf-du-Pape',
    'Leyda Valley',
    'Aconcagua',
    // Add more as needed; unknown = 999
  ]);

  private static readonly countryEnc = new MlPipelineLabelEncoder([
    // Wine-producing countries (sorted by frequency in dataset)
    'United States',
    'France',
    'Italy',
    'Spain',
    'Chile',
    'South Africa',
    'Australia',
    'Argentina',
    'Germany',
    'Portugal',
    'New Zealand',
    'Austria',
    'Greece',
    'Hungary',
    'United Kingdom',
    'Canada',
    // Add more as needed; unknown = 999
  ]);

  /**
   * Encodes a grape variety to its integer code (0-N or 999 for OOV).
   */
  static encodeGrape(grape: string | null | undefined): number {
    return this.grapeEnc.encode(grape);
  }

  /**
   * Encodes a region/appellation to its integer code (0-N or 999 for OOV).
   */
  static encodeRegion(region: string | null | undefined): number {
    if (!region) return this.regionEnc.encode(null);
    // Extract top-level region from hierarchical string (e.g., "France / Bordeaux / ..." → "Bordeaux")
    const parts = region.split('/').map(p => p.trim());
    // Try to find a known region in the hierarchy
    for (const part of parts) {
      if (part.length > 0) {
        const code = this.regionEnc.encode(part);
        if (code !== 999) {
          return code;
        }
      }
    }
    return 999;
  }

  /**
   * Encodes a country to its integer code (0-N or 999 for OOV).
   */
  static encodeCountry(country: string | null | undefined): number {
    return this.countryEnc.encode(country);
  }
}
