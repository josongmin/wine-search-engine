import { buildNormalizedQueryViews } from '../src/domain/query/service/query-normalizer.js';
const qs = [
  ['2013 vineyard 29 estate cabernet sauvignon 13', 'expect keep "29", drop leading 2013 + trailing 13'],
  ['2017 bindi sergardi mocenni numero 89 gran selezione chianti classico 17', 'expect keep "89", drop 2017 + 17'],
  ['Margaux 15', 'expect 15 -> 2015 (trailing shorthand feature)'],
  ['Penfolds Bin 28', 'trailing 28 unchanged (behaviour preserved)'],
  ['Opus One 2018', 'leading/standalone 4-digit vintage'],
  ['샤또 마고 2015', 'Korean + 4-digit vintage'],
  ['보르도 95 와인', 'Korean: 95 followed by name word 와인 -> keep'],
];
for (const [q, note] of qs) {
  const v = buildNormalizedQueryViews(q);
  console.log(`\nQ ${JSON.stringify(q)}  // ${note}`);
  console.log('  vintageStripped:', JSON.stringify(v.vintageStripped));
  console.log('  vintageCanonicalized:', JSON.stringify(v.vintageCanonicalized));
}
