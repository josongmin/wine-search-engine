import { buildNormalizedQueryViews } from '../src/domain/query/service/query-normalizer.js';
const qs = [
  '2013 vineyard 29 estate cabernet sauvignon 13',
  '2017 bindi sergardi mocenni numero 89 gran selezione chianti classico 17',
];
for (const q of qs) {
  const v = buildNormalizedQueryViews(q);
  console.log('\nQ', JSON.stringify(q));
  console.log('  vintageStripped:', JSON.stringify(v.vintageStripped));
  console.log('  vintageCanonicalized:', JSON.stringify(v.vintageCanonicalized));
  console.log('  lookupVariants:', JSON.stringify(v.lookupVariants));
}
