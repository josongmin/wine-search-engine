/**
 * Label encoder for categorical wine attributes.
 * Moved into the ranking domain because ranking consumes the encoding directly.
 */
export class LabelEncoder {
  private readonly mapping: Map<string, number>;
  private readonly oovCode: number = 999;

  constructor(labels: readonly string[]) {
    this.mapping = new Map();
    labels.forEach((label, idx) => {
      this.mapping.set(label, idx);
    });
  }

  encode(label: string | null | undefined): number {
    if (label === null || label === undefined) {
      return this.oovCode;
    }
    return this.mapping.get(label) ?? this.oovCode;
  }

  get vocabularySize(): number {
    return this.mapping.size;
  }
}

// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- static encoder registry
export class WineAttributeEncoders {
  private static readonly grapeEnc = new LabelEncoder([
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
  ]);

  private static readonly regionEnc = new LabelEncoder([
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
  ]);

  private static readonly countryEnc = new LabelEncoder([
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
  ]);

  static encodeGrape(grape: string | null | undefined): number {
    return this.grapeEnc.encode(grape);
  }

  static encodeRegion(region: string | null | undefined): number {
    if (!region) return this.regionEnc.encode(null);
    const parts = region.split('/').map((part) => part.trim());
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

  static encodeCountry(country: string | null | undefined): number {
    return this.countryEnc.encode(country);
  }
}
