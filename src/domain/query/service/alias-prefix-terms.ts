import { Transliterator } from '../../alias/service/transliterator.js';
import { buildNormalizedQueryViews } from './query-normalizer.js';
import { expandKoreanWineTypoVariants } from './korean-wine-aliases.js';

const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/u;

function trimDeduped(values: Iterable<string>): readonly string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

function addNormalizedSurfaceTerms(target: Set<string>, surface: string): void {
  const views = buildNormalizedQueryViews(surface);
  for (const value of [
    views.strict,
    views.punctuationStripped,
    views.vintageStripped,
    views.compact,
  ]) {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    target.add(trimmed);
  }
}

function addCuratedKoreanVariants(target: Set<string>, surface: string): void {
  const exceptionSurface = Transliterator.koreanExceptionSurfaceForLatinTerm(surface);
  if (exceptionSurface === undefined) {
    return;
  }
  addNormalizedSurfaceTerms(target, exceptionSurface);
  for (const typoVariant of expandKoreanWineTypoVariants(exceptionSurface)) {
    addNormalizedSurfaceTerms(target, typoVariant);
  }
}

export function isEligiblePrefixQuery(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return HANGUL_RE.test(trimmed) ? trimmed.length >= 2 : trimmed.length >= 3;
}

export function buildAliasPrefixTerms(
  surfaces: readonly string[],
): readonly string[] {
  const terms = new Set<string>();
  for (const surface of surfaces) {
    const trimmed = surface.trim();
    if (trimmed.length === 0) {
      continue;
    }
    addNormalizedSurfaceTerms(terms, trimmed);
    if (!HANGUL_RE.test(trimmed)) {
      addCuratedKoreanVariants(terms, trimmed);
    }
  }
  return trimDeduped(terms);
}
