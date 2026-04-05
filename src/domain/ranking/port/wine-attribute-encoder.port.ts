export interface WineAttributeEncoderPort {
  encodeGrape(grape: string | null | undefined): number;
  encodeRegion(region: string | null | undefined): number;
  encodeCountry(country: string | null | undefined): number;
}
