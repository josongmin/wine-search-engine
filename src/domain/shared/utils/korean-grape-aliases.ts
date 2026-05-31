/**
 * Korean (+ abbreviated English) grape-surface → canonical grape SSoT.
 *
 * Single source of truth for the regex-based mapping from Korean grape name
 * fragments (and common English abbreviations) to their canonical English
 * grape variety display names. Previously this table was duplicated, with
 * *divergent* content, in:
 *   - src/domain/query/service/search-constraint-extractor.ts (20 entries,
 *     used for Vespa `grape_primary` / `grapes` filtering)
 *   - src/domain/evaluation/service/claim-extractor.ts (14 entries, used for
 *     RFC-020 claim extraction)
 *
 * The drift was a latent correctness bug per CLAUDE.md rule 25/30: a query
 * mentioning a grape only present in one list (e.g. Viognier, Zinfandel,
 * Gewürztraminer) would be filtered at retrieval time but NOT recognized as a
 * grape claim during answer grounding — so the claim verifier could not check
 * a constraint the retriever had already enforced.
 *
 * Layer placement: `domain/shared` (composite leaf). The table is pure regex
 * data with zero domain imports, so it is DAG-safe for every domain consumer.
 *
 * ── Merge / domain decisions (union = superset of both prior lists) ─────────
 *  - Korean surfaces use the *broadest* prior variant so neither consumer
 *    loses coverage:
 *      • Cabernet Sauvignon: `까?베르네` (optional ㄲ; covers both 카베르네 /
 *        까베르네) ∪ claim-extractor's `까쇼` shorthand.
 *      • Sauvignon Blanc: `쇼비뇽?` covers both `쇼비` (claim) and `쇼비뇽`
 *        (search).
 *      • Chardonnay: `샤르도네` ∪ `샤도네이` (both common Korean romanizations).
 *  - Canonical *values* are kept in display case (e.g. 'Cabernet Sauvignon',
 *    'Pinot Grigio', 'Gewürztraminer') because search-constraint-extractor
 *    writes them straight into the Vespa filter, while claim-extractor
 *    additionally lowercases + runs them through `resolveGrapeAlias()`. Display
 *    case is therefore the only value shape safe for BOTH callers.
 *  - Order matters: more specific Cabernet Sauvignon precedes Cabernet Franc,
 *    and the first matching pattern wins (both consumers iterate in order and
 *    return on first hit). To keep that ordering safe, the Cabernet Sauvignon
 *    entry's bare `까?베르네` alternative uses a negative lookahead `(?!\s*프랑)`
 *    so it cannot pre-empt the Korean Cabernet *Franc* surface `카베르네 프랑`.
 *
 * Each pattern carries the `/iu` flags (case-insensitive + Unicode) so the
 * non-ASCII Korean alternations are evaluated correctly (CLAUDE.md non-ASCII
 * regex rule). No `\b` is used — Korean has no ASCII word boundaries.
 */
export const KOREAN_GRAPE_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  // Cabernet Sauvignon — `까?베르네` covers 카베르네/까베르네; `까쇼` is the
  // common Korean shorthand merged in from claim-extractor. The bare
  // `까?베르네` alternative carries a negative lookahead `(?!\s*프랑)` so it does
  // NOT swallow the Korean Cabernet *Franc* surface `카베르네 프랑` (W2 merge
  // regression: first-match-wins previously misclassified Franc as Sauvignon).
  [/까?베르네\s*소비뇽|까?베르네소비뇽|까?베르네(?!\s*프랑)|까쇼|cab(?:ernet)?\s*sauv(?:ignon)?/iu, 'Cabernet Sauvignon'],
  // `까?베르네\s*프랑` is symmetric with the Sauvignon entry's `까?베르네` so the
  // ㄲ-romanization `까베르네 프랑` resolves to Franc (not null). Without the
  // optional `까`, the Sauvignon lookahead blocks `까베르네 프랑` AND this entry
  // misses it → null (self-audit R3 regression from the lookahead fix).
  [/까?베르네\s*프랑|cab(?:ernet)?\s*franc/iu, 'Cabernet Franc'],
  [/메를로|merlot/iu, 'Merlot'],
  [/피노\s*누아르?|피노누아|pinot\s*noir/iu, 'Pinot Noir'],
  [/피노\s*그리(?:지오)?|pinot\s*gri(?:gio|s)/iu, 'Pinot Grigio'],
  [/피노\s*블랑|pinot\s*blanc/iu, 'Pinot Blanc'],
  // Sauvignon Blanc — `쇼비뇽?` covers both `쇼비` (claim) and `쇼비뇽` (search).
  [/소비뇽\s*블랑|쇼비뇽?|sauvignon\s*blanc/iu, 'Sauvignon Blanc'],
  // Chardonnay — both Korean romanizations 샤르도네 / 샤도네이.
  [/샤르도네|샤도네이|chardonnay/iu, 'Chardonnay'],
  [/시라(?:즈)?|shiraz|syrah/iu, 'Syrah'],
  [/리슬링|riesling/iu, 'Riesling'],
  [/그르나슈|grenache|garnacha/iu, 'Grenache'],
  [/산지오베제|sangiovese/iu, 'Sangiovese'],
  [/템프라니요|tempranillo/iu, 'Tempranillo'],
  [/네비올로|nebbiolo/iu, 'Nebbiolo'],
  [/말벡|malbec/iu, 'Malbec'],
  [/무스카|muscat|moscato/iu, 'Muscat'],
  [/게뷔르츠트라미너|gewürztraminer|gewurztraminer/iu, 'Gewürztraminer'],
  [/비오니에|viognier/iu, 'Viognier'],
  [/진판델|zinfandel/iu, 'Zinfandel'],
  [/피노타지|pinotage/iu, 'Pinotage'],
];
