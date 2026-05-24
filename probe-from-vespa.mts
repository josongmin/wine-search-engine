import { fromVespaFields } from './src/infrastructure/vespa/mapping.js';

const fields = {
  sddocname: 'wine_entity',
  entity_id: 'wine-ce-5b4b64b3c93ec383de13d88b19ac4200f3cec36c40712d28f11710bd2c0e3661',
  entity_type: 'wine',
  canonical_label: '2017 Eleven Eleven Cabernet Sauvignon',
  aliases_identity_safe: ['Eleven Eleven'],
  aliases_noisy_recall: ['일레븐 일레븐 2017'],
  producer: 'Eleven Eleven',
  region: 'Napa Valley',
  search_text_en: 'Eleven Eleven',
  search_text_ko: '2017 Eleven Eleven',
  semantic_summary: '2017 Eleven Eleven',
  body: 0.5,
  sweetness: 0.5,
  style: 'medium red',
  price_band: 'premium',
  pairing: ['Cheese', 'cheese'],
  availability: true,
  popularity_score: 0,
  vintage_year: 2017,
  acidity: 0.5,
  tannin: 0.5,
  wine_type: 'red',
  critic_score_normalized: 0.9,
  price_usd: 115,
  rating_avg: 4.5,
  ratings_count: 0,
  organic: false,
  biodynamic: false,
  drinking_window_start: 2018,
  drinking_window_end: 2023,
  drinking_window_model_version: 'v1.0-heuristic-20260405',
  region_hierarchy: ['United States', 'California'],
  price_band_numeric: 3,
  gift_suitability_score: 0.35,
  beginner_suitability_score: 0.5,
  source_record_refs_json: '[{"sourceRecordId":"vivino-1","sourceSystem":"vivino"}]',
};
try {
  const doc = fromVespaFields(fields);
  console.log('PARSED OK:', JSON.stringify({ entityId: doc.entityId, canonicalLabel: doc.canonicalLabel, producer: doc.producer, region: doc.region }, null, 2));
} catch (err) {
  console.error('PARSE FAILED:');
  console.error('  Error name:', (err as Error).name);
  console.error('  Error message:', (err as Error).message);
  if ((err as any).fieldKey) console.error('  Field key:', (err as any).fieldKey);
  console.error('  Stack:', (err as Error).stack);
}
