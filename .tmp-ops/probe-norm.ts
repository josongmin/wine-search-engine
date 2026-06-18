import { buildNormalizedQueryViews } from '../src/domain/query/service/query-normalizer.js';
for (const q of ['돔페리뇽','돔 페리뇽','돔페리뇽 2012','오푸','오푸스 원','보르도 와인']) {
  const v = buildNormalizedQueryViews(q);
  console.log(JSON.stringify(q), '→', JSON.stringify(v.lookupVariants));
}
