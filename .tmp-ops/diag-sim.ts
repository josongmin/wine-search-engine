import { damerauLevenshteinOsa, jaroWinklerSimilarity, editDistanceSimilarity } from '../src/domain/alias/service/edit-distance.js';
import { buildNormalizedQueryViews } from '../src/domain/query/service/query-normalizer.js';

const compact = (s:string)=> s.normalize('NFKD').replace(/\p{Diacritic}/gu,'').replace(/[^\p{L}\p{N}]+/gu,'').toLowerCase();
function trigram(a:string,b:string,n=3){
  const grams=(s:string)=>{const g=new Set<string>();for(let i=0;i<=s.length-n;i++)g.add(s.slice(i,i+n));return g;};
  const A=grams(a),B=grams(b); if(A.size===0||B.size===0)return 0;
  let inter=0; for(const x of A)if(B.has(x))inter++; return inter/(A.size+B.size-inter);
}
const cand = compact('2022 Vinas Mora kaamen III');
console.log('candidate compact:', cand);
const v = buildNormalizedQueryViews('Viña Espectro Maipo Valley Carmenere');
const variants = new Set<string>([compact('Viña Espectro Maipo Valley Carmenere'), ...v.lookupVariants.map(compact)]);
for (const q of variants) {
  if(!q) continue;
  const d = damerauLevenshteinOsa(q, cand);
  const dsim = editDistanceSimilarity(q, cand, d);
  const jw = jaroWinklerSimilarity(q, cand);
  const tg = trigram(q,cand,3), bg = trigram(q,cand,2);
  const best = Math.max(dsim, jw, tg, bg);
  if (best >= 0.5) console.log(`q=${JSON.stringify(q)} dsim=${dsim.toFixed(3)} jw=${jw.toFixed(3)} tri=${tg.toFixed(3)} bi=${bg.toFixed(3)} => BEST=${best.toFixed(3)}`);
}
