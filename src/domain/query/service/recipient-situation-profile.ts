export const RECIPIENT_PROFILE_VALUES = [
  'parents_first_time',
  'senior_colleague_gift',
  'unknown_preference_recipient',
] as const;

export type RecipientProfileValue = (typeof RECIPIENT_PROFILE_VALUES)[number];

export type RecipientProfileEvidenceAxis =
  | 'sweet_light'
  | 'fruit_forward'
  | 'light_rose'
  | 'low_tannin_red'
  | 'gentle_acidity'
  | 'soft_structure'
  | 'classic_gift_region'
  | 'formal_prestige'
  | 'celebration_context'
  | 'crowd_pleasing_white'
  | 'crowd_pleasing_sparkling'
  | 'crowd_pleasing_red'
  | 'broad_recognition';

export interface RecipientProfileCandidate {
  readonly wineType?: string | undefined;
  readonly style?: string | undefined;
  readonly grapePrimary?: string | undefined;
  readonly grapes?: readonly string[] | undefined;
  readonly region?: string | undefined;
  readonly occasion?: readonly string[] | undefined;
  readonly body?: number | undefined;
  readonly tannin?: number | undefined;
  readonly acidity?: number | undefined;
  readonly sweetness?: number | undefined;
  readonly producerPrestige?: number | undefined;
  readonly popularityScore?: number | undefined;
}

function normalizeText(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeWineType(value: string | undefined): string {
  const normalized = normalizeText(value);
  return normalized === 'rose' ? 'rosé' : normalized;
}

function normalizeSensory01(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  if (value <= 1) {
    return Math.max(0, value);
  }
  return Math.max(0, Math.min(1, value / 5));
}

function candidateTextBag(candidate: RecipientProfileCandidate): readonly string[] {
  return [
    candidate.wineType,
    candidate.style,
    candidate.grapePrimary,
    candidate.region,
    ...(candidate.grapes ?? []),
    ...(candidate.occasion ?? []),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(normalizeText);
}

function containsAny(values: readonly string[], needles: readonly string[]): boolean {
  return values.some((value) => needles.some((needle) => value.includes(needle)));
}

function containsRoseStyleSignal(values: readonly string[]): boolean {
  return values.some((value) =>
    value === 'rose'
    || value.includes('rose wine')
    || value.includes('light rose')
    || value.includes('rose style'));
}

function uniqueAxes(axes: readonly RecipientProfileEvidenceAxis[]): readonly RecipientProfileEvidenceAxis[] {
  return [...new Set(axes)];
}

function parentsFirstTimeProfileEvidenceAxes(
  candidate: RecipientProfileCandidate,
): readonly RecipientProfileEvidenceAxis[] {
  const textBag = candidateTextBag(candidate);
  const wineType = normalizeWineType(candidate.wineType);
  const tannin = normalizeSensory01(candidate.tannin);
  const acidity = normalizeSensory01(candidate.acidity);
  const sweetness = normalizeSensory01(candidate.sweetness);
  const body = normalizeSensory01(candidate.body);

  const lowTannin = tannin !== undefined && tannin <= 0.3;
  const notTooDry = sweetness !== undefined && sweetness >= 0.2;
  const notHighAcid = acidity === undefined || acidity <= 0.75;
  const gentleBody = body === undefined || body <= 0.6;
  const hasMoscatoFamily = containsAny(textBag, ['moscato', 'muscat']);
  const hasGamayFamily = containsAny(textBag, ['beaujolais', 'gamay']);
  const hasFruitForwardSignal = hasMoscatoFamily
    || hasGamayFamily
    || containsAny(textBag, ['prosecco', 'glera', 'fruity', 'fruit forward']);
  const hasRoseSignal = wineType === 'rosé' || containsRoseStyleSignal(textBag);
  const whiteOrSparkling = wineType === 'white' || wineType === 'sparkling' || wineType === 'dessert';
  const offDryStyleSignal = containsAny(textBag, ['off dry', 'off-dry', 'slightly sweet', 'sweet']);

  const axes: RecipientProfileEvidenceAxis[] = [];
  if (
    hasMoscatoFamily
    || ((whiteOrSparkling || hasRoseSignal || offDryStyleSignal) && lowTannin && notTooDry && notHighAcid)
  ) {
    axes.push('sweet_light');
  }
  if (hasFruitForwardSignal) {
    axes.push('fruit_forward');
  }
  if (hasRoseSignal && (lowTannin || tannin === undefined) && gentleBody) {
    axes.push('light_rose');
  }
  if (hasGamayFamily || (wineType === 'red' && lowTannin && gentleBody)) {
    axes.push('low_tannin_red');
  }
  if (acidity !== undefined && notHighAcid) {
    axes.push('gentle_acidity');
  }
  if (lowTannin && gentleBody) {
    axes.push('soft_structure');
  }

  return uniqueAxes(axes);
}

function matchesParentsFirstTimeProfile(candidate: RecipientProfileCandidate): boolean {
  return parentsFirstTimeProfileEvidenceAxes(candidate).some((axis) =>
    axis === 'sweet_light' || axis === 'light_rose' || axis === 'low_tannin_red');
}

function seniorColleagueGiftProfileEvidenceAxes(
  candidate: RecipientProfileCandidate,
): readonly RecipientProfileEvidenceAxis[] {
  const textBag = candidateTextBag(candidate);
  const prestige = candidate.producerPrestige;
  const axes: RecipientProfileEvidenceAxis[] = [];

  if (containsAny(textBag, ['champagne', 'bordeaux', 'napa', 'tuscany', 'gift', 'celebration', 'special occasion'])) {
    axes.push('classic_gift_region');
  }
  if (containsAny(textBag, ['celebration', 'special occasion', 'gift'])) {
    axes.push('celebration_context');
  }
  if (prestige !== undefined && prestige >= 0.7) {
    axes.push('formal_prestige');
  }
  return uniqueAxes(axes);
}

function matchesSeniorColleagueGiftProfile(candidate: RecipientProfileCandidate): boolean {
  return seniorColleagueGiftProfileEvidenceAxes(candidate).length > 0;
}

function unknownPreferenceRecipientProfileEvidenceAxes(
  candidate: RecipientProfileCandidate,
): readonly RecipientProfileEvidenceAxis[] {
  const textBag = candidateTextBag(candidate);
  const popularity = candidate.popularityScore;
  const axes: RecipientProfileEvidenceAxis[] = [];
  if (containsAny(textBag, ['pinot grigio', 'pinot gris'])) {
    axes.push('crowd_pleasing_white');
  }
  if (containsAny(textBag, ['prosecco', 'cava'])) {
    axes.push('crowd_pleasing_sparkling');
  }
  if (containsAny(textBag, ['merlot', 'pinot noir', 'gamay'])) {
    axes.push('crowd_pleasing_red');
  }
  if (popularity !== undefined && popularity >= 0.6) {
    axes.push('broad_recognition');
  }
  return uniqueAxes(axes);
}

function matchesUnknownPreferenceRecipientProfile(candidate: RecipientProfileCandidate): boolean {
  return unknownPreferenceRecipientProfileEvidenceAxes(candidate).length > 0;
}

export function isRecipientProfileValue(value: string): value is RecipientProfileValue {
  return (RECIPIENT_PROFILE_VALUES as readonly string[]).includes(value);
}

export function recipientProfileToRetrievalTerms(profile: string): readonly string[] {
  switch (profile) {
    case 'parents_first_time':
      return ['moscato', 'muscat', 'light rosé', 'beaujolais', 'gamay', 'prosecco', 'slightly sweet', 'fruit forward', 'low tannin'];
    case 'senior_colleague_gift':
      return ['champagne', 'bordeaux', 'napa', 'tuscany', 'classic gift', 'prestige', 'celebration'];
    case 'unknown_preference_recipient':
      return ['pinot grigio', 'prosecco', 'merlot', 'pinot noir', 'crowd pleasing'];
    default:
      return [];
  }
}

export function candidateMatchesRecipientProfile(
  candidate: RecipientProfileCandidate,
  profile: string,
): boolean | undefined {
  switch (profile) {
    case 'parents_first_time':
      return matchesParentsFirstTimeProfile(candidate);
    case 'senior_colleague_gift':
      return matchesSeniorColleagueGiftProfile(candidate);
    case 'unknown_preference_recipient':
      return matchesUnknownPreferenceRecipientProfile(candidate);
    default:
      return undefined;
  }
}

export function recipientProfileEvidenceAxes(
  candidate: RecipientProfileCandidate,
  profile: string,
): readonly RecipientProfileEvidenceAxis[] {
  switch (profile) {
    case 'parents_first_time':
      return parentsFirstTimeProfileEvidenceAxes(candidate);
    case 'senior_colleague_gift':
      return seniorColleagueGiftProfileEvidenceAxes(candidate);
    case 'unknown_preference_recipient':
      return unknownPreferenceRecipientProfileEvidenceAxes(candidate);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Query-string classifier (maturity 2 -> 3)
//
// Lightweight, deterministic recipient-situation classifier over the raw user
// query. Complements the candidate-based axis voting above by surfacing a
// top-profile + confidence + runner-up tuple at NLU time, before retrieval
// runs. No randomness, no locale-dependent string ops, no \b on non-ASCII.
// ---------------------------------------------------------------------------

export interface RecipientProfileScore {
  readonly profile: RecipientProfileValue;
  readonly confidence: number;
}

export interface RecipientProfileClassification {
  readonly profile?: RecipientProfileValue;
  readonly confidence: number;
  readonly runnerUp?: RecipientProfileScore;
}

// Confidence threshold below which we treat the top profile as "no signal".
// 1 evidence hit / ~5 max evidence = 0.2 floor; we require >= ~2 hits worth of
// evidence (or one very strong hit) to surface a profile.
const QUERY_PROFILE_CONFIDENCE_FLOOR = 0.2;

// Per-profile signal vocabularies. Korean tokens are matched as raw substrings
// (no \b - CLAUDE.md rule 8). English tokens are matched after lowercasing.
// Each entry contributes 1 evidence point per distinct hit.
const PARENTS_FIRST_TIME_QUERY_SIGNALS: readonly string[] = [
  // Korean - parent terms
  '부모님',
  '부모',
  '엄마',
  '어머니',
  '아빠',
  '아버지',
  '어른',
  // Korean - first-time / gentle drinking
  '처음',
  '입문',
  '달달',
  '달콤',
  '가벼운',
  '순한',
  // English - parent + first-time terms
  'parent',
  'parents',
  'mom',
  'mother',
  'dad',
  'father',
  'first time',
  'first-time',
  'beginner',
  'introductory',
  'sweet',
  'light',
  'moscato',
  'muscat',
  'fruit forward',
  'fruit-forward',
  'low tannin',
];

const SENIOR_COLLEAGUE_GIFT_QUERY_SIGNALS: readonly string[] = [
  // Korean - senior / formal gift
  '상사',
  '직장',
  '윗사람',
  '회식',
  '접대',
  '선물',
  '고급',
  '격식',
  '예우',
  // English - senior / prestige / gift
  'boss',
  'senior',
  'supervisor',
  'colleague',
  'manager',
  'executive',
  'gift',
  'present',
  'prestige',
  'prestigious',
  'formal',
  'celebration',
  'special occasion',
  'champagne',
  'bordeaux',
  'napa',
  'tuscany',
];

const UNKNOWN_PREFERENCE_RECIPIENT_QUERY_SIGNALS: readonly string[] = [
  // Korean - unknown taste / crowd-pleasing
  '모르는',
  '모르겠',
  '취향',
  '무난',
  '대중적',
  '누구나',
  '안전한',
  // English - unknown preference / crowd-pleaser
  "don't know",
  'dont know',
  'do not know',
  'not sure',
  'unsure',
  'unknown taste',
  'unknown preference',
  'crowd pleasing',
  'crowd-pleasing',
  'crowd pleaser',
  'safe',
  'universal',
  'easy drinking',
  'pinot grigio',
  'pinot gris',
  'prosecco',
  'cava',
  'merlot',
  'pinot noir',
];

const QUERY_PROFILE_SIGNAL_MAP: Readonly<Record<RecipientProfileValue, readonly string[]>> = {
  parents_first_time: PARENTS_FIRST_TIME_QUERY_SIGNALS,
  senior_colleague_gift: SENIOR_COLLEAGUE_GIFT_QUERY_SIGNALS,
  unknown_preference_recipient: UNKNOWN_PREFERENCE_RECIPIENT_QUERY_SIGNALS,
};

// Per-profile saturation point: number of distinct signal hits at which we
// treat the evidence as "full confidence (1.0)". Calibrated so a query with
// ~3 strong cues saturates; smaller dictionaries don't get penalized for
// being short.
const QUERY_PROFILE_SATURATION = 3;

function normalizeQueryForClassification(query: string): string {
  return query.toLowerCase().normalize('NFC');
}

function countDistinctSignalHits(normalizedQuery: string, signals: readonly string[]): number {
  if (normalizedQuery.length === 0) {
    return 0;
  }
  const seen = new Set<string>();
  for (const signal of signals) {
    const needle = signal.toLowerCase();
    if (needle.length === 0) {
      continue;
    }
    if (normalizedQuery.includes(needle) && !seen.has(needle)) {
      seen.add(needle);
    }
  }
  return seen.size;
}

function scoreFromHits(hits: number): number {
  if (hits <= 0) {
    return 0;
  }
  return Math.min(1, hits / QUERY_PROFILE_SATURATION);
}

/**
 * Classify a raw user query into a recipient-situation profile.
 *
 * Deterministic: no Math.random, no locale-dependent ops, no \b on non-ASCII.
 * Ties broken by canonical RECIPIENT_PROFILE_VALUES order (parents_first_time
 * > senior_colleague_gift > unknown_preference_recipient).
 *
 * Confidence is in [0, 1]; profile is omitted when confidence falls below
 * QUERY_PROFILE_CONFIDENCE_FLOOR. runnerUp is the second-highest scoring
 * profile when it has any evidence at all.
 */
export function classifyRecipientSituationProfile(query: string): RecipientProfileClassification {
  const normalized = normalizeQueryForClassification(query.trim());

  // Score every profile in canonical order so ties are deterministic.
  const scores: readonly RecipientProfileScore[] = RECIPIENT_PROFILE_VALUES.map((profile) => ({
    profile,
    confidence: scoreFromHits(countDistinctSignalHits(normalized, QUERY_PROFILE_SIGNAL_MAP[profile])),
  }));

  // Find top score with deterministic tie-break (first wins -> canonical order).
  let topIdx = 0;
  for (let i = 1; i < scores.length; i += 1) {
    const current = scores[i];
    const best = scores[topIdx];
    if (current === undefined || best === undefined) {
      continue;
    }
    if (current.confidence > best.confidence) {
      topIdx = i;
    }
  }

  const top = scores[topIdx];
  if (top === undefined || top.confidence < QUERY_PROFILE_CONFIDENCE_FLOOR) {
    return { confidence: 0 };
  }

  // Runner-up: highest-scoring profile that is not the top one and has
  // strictly positive evidence. Deterministic tie-break via canonical order.
  let runnerUp: RecipientProfileScore | undefined;
  for (let i = 0; i < scores.length; i += 1) {
    if (i === topIdx) {
      continue;
    }
    const candidate = scores[i];
    if (candidate === undefined || candidate.confidence <= 0) {
      continue;
    }
    if (runnerUp === undefined || candidate.confidence > runnerUp.confidence) {
      runnerUp = candidate;
    }
  }

  return {
    profile: top.profile,
    confidence: top.confidence,
    ...(runnerUp !== undefined ? { runnerUp } : {}),
  };
}
