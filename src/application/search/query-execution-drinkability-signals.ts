import { hasDrinkabilityKeyword } from '../../domain/query/service/exact-entity-metadata-signals.js';

/**
 * Drinkability / cellaring intent detectors shared between the search-defaults
 * builder ({@link buildSearchDefaults}) and the top-level contract builder's
 * drinkability-check gate. Pure regex classifiers over the accentless-normalized
 * query form. Extracted as a single source of truth so both consumers agree on
 * the exact cellaring / immediate-drink / current-drink cue vocabularies.
 */

export function hasCellaringIntent(normalized: string): boolean {
  return /(?:셀러|cellar(?:ing)?|지금\s*마시면\s*아까운|숙성(?:용|할|해둘|해서|가능|잠재력)?|ageworthy|aging\s+potential|long[\s-]?term\s+aging|hold\s+for|hold(?=$|[^\p{L}\p{N}])|성인\s*될\s*때)/iu.test(normalized);
}

export function hasImmediateDrinkabilityIntent(normalized: string): boolean {
  return /(?:지금\s*바로\s*마셔야|바로\s*마셔야|must\s+drink\s+now|drink\s+now\s+or\s+soon|ready\s+now)/iu.test(normalized);
}

export function hasCurrentDrinkabilityIntent(normalized: string): boolean {
  return hasDrinkabilityKeyword(normalized)
    && /(?:^|[^\p{L}\p{N}])(?:지금|현재|currently|now)(?=$|[^\p{L}\p{N}])/iu.test(normalized);
}
