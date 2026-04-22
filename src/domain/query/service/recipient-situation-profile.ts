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
