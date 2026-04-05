import type { WineAttributeEncoderPort } from '../port/wine-attribute-encoder.port.js';

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

const grapeEnc = new LabelEncoder([
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

const regionEnc = new LabelEncoder([
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

const countryEnc = new LabelEncoder([
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

export const WineAttributeEncoders: WineAttributeEncoderPort = {
  encodeGrape(grape: string | null | undefined): number {
    return grapeEnc.encode(grape);
  },

  encodeRegion(region: string | null | undefined): number {
    if (!region) return regionEnc.encode(null);
    const parts = region.split('/').map((part) => part.trim());
    for (const part of parts) {
      if (part.length > 0) {
        const code = regionEnc.encode(part);
        if (code !== 999) {
          return code;
        }
      }
    }
    return 999;
  },

  encodeCountry(country: string | null | undefined): number {
    return countryEnc.encode(country);
  },
};
