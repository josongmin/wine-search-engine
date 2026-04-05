import type { WineAttributeEncoderPort } from '../port/wine-attribute-encoder.port.js';
import {
  COUNTRY_VOCABULARY,
  GRAPE_VOCABULARY,
  REGION_VOCABULARY,
  WINE_ATTRIBUTE_OOV_CODE,
} from '../model/wine-attribute-vocabulary.js';

/**
 * Label encoder for categorical wine attributes.
 * Moved into the ranking domain because ranking consumes the encoding directly.
 */
export class LabelEncoder {
  private readonly mapping: Map<string, number>;
  private readonly oovCode: number = WINE_ATTRIBUTE_OOV_CODE;

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

const grapeEnc = new LabelEncoder(GRAPE_VOCABULARY);

const regionEnc = new LabelEncoder(REGION_VOCABULARY);

const countryEnc = new LabelEncoder(COUNTRY_VOCABULARY);

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
        if (code !== WINE_ATTRIBUTE_OOV_CODE) {
          return code;
        }
      }
    }
    return WINE_ATTRIBUTE_OOV_CODE;
  },

  encodeCountry(country: string | null | undefined): number {
    return countryEnc.encode(country);
  },
};
