import { Transliterator } from '../src/domain/alias/service/transliterator.js';
import { correctKoreanWineTypos } from '../src/domain/query/service/korean-wine-aliases.js';
console.log('romanizeWineTerm("오푸") =', JSON.stringify(Transliterator.romanizeWineTerm('오푸')));
console.log('romanizeWineTermPrefix("오푸") =', JSON.stringify(Transliterator.romanizeWineTermPrefix('오푸')));
console.log('correctKoreanWineTypos("오푸") =', JSON.stringify(correctKoreanWineTypos('오푸')));
console.log('romanizeWineTerm("돔페리뇽") =', JSON.stringify(Transliterator.romanizeWineTerm('돔페리뇽')));
