// Models
export {
  type Alias,
  type AliasType,
  type AliasScope,
  type CreateAliasParams,
  ALIAS_TYPES,
  ALIAS_SCOPES,
  createAlias,
} from './model/alias.js';

export {
  type AliasConflict,
  type AliasConflictEntry,
  type AliasConflictResolution,
} from './model/alias-conflict.js';

export {
  type AmbiguityRegistryEntry,
  createAmbiguityEntry,
} from './model/ambiguity-registry.js';

// Ports
export { type AliasRepository } from './port/alias-repository.port.js';

// Services
export {
  AliasMatcher,
  type AliasMatchResult,
  editDistance,
  normalizeForMatch,
} from './service/alias-matcher.js';

export {
  Transliterator,
  type TransliterationResult,
  type SourceLang,
} from './service/transliterator.js';

export {
  CharNgramIndex,
  type CharNgramMatch,
} from './service/char-ngram-index.js';

export { ConflictResolver } from './service/conflict-resolver.js';

export {
  AdversarialGuard,
  type AdversarialCheckResult,
} from './service/adversarial-guard.js';
