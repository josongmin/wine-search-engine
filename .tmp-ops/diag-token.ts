import { damerauLevenshteinOsa, jaroWinklerSimilarity, editDistanceSimilarity } from '../src/domain/alias/service/edit-distance.js';
for (const [a,b] of [['vina','vinas'],['viña','vinas'],['vinaespectro','vinasmora'],['espectro','vinas']]) {
  const d=damerauLevenshteinOsa(a,b);
  console.log(`${a} vs ${b}: dsim=${editDistanceSimilarity(a,b,d).toFixed(3)} jw=${jaroWinklerSimilarity(a,b).toFixed(3)} damerau=${d}`);
}
