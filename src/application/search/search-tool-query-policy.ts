import { buildSearchToolStyleQueryTerms } from './search-tool-contract.js';

interface SearchToolSoftClauseInput {
  readonly exclude_grapes?: readonly string[] | undefined;
  readonly exclude_regions?: readonly string[] | undefined;
  readonly min_price_krw?: number | undefined;
  readonly max_price_krw?: number | undefined;
  readonly max_alcohol_pct?: number | undefined;
  readonly style?: string | undefined;
  readonly styles?: readonly string[] | undefined;
  readonly certification?: string | undefined;
  readonly occasion?: readonly string[] | undefined;
}

function formatKrwAsManWon(krw: number): string {
  const manWon = krw / 10_000;
  return Number.isInteger(manWon) ? String(manWon) : manWon.toString();
}

export function buildSearchToolPriceClauses(input: {
  readonly min_price_krw?: number | undefined;
  readonly max_price_krw?: number | undefined;
}): readonly string[] {
  if (input.min_price_krw !== undefined && input.max_price_krw !== undefined) {
    return [`${formatKrwAsManWon(input.min_price_krw)}~${formatKrwAsManWon(input.max_price_krw)}만원`];
  }

  const clauses: string[] = [];
  if (input.min_price_krw !== undefined) {
    clauses.push(`${input.min_price_krw}원 이상`);
  }
  if (input.max_price_krw !== undefined) {
    clauses.push(`${input.max_price_krw}원 이하`);
  }
  return clauses;
}

export function appendStructuredQueryClauses(
  baseQuery: string,
  clauses: readonly string[],
): string {
  if (clauses.length === 0) {
    return baseQuery;
  }
  if (baseQuery.length === 0) {
    return clauses.join(', ');
  }
  return `${baseQuery}, ${clauses.join(', ')}`;
}

export function buildSearchToolSoftClauses(
  input: SearchToolSoftClauseInput,
): readonly string[] {
  const clauses: string[] = [];
  for (const grape of input.exclude_grapes ?? []) {
    clauses.push(`not ${grape}`);
  }
  for (const region of input.exclude_regions ?? []) {
    clauses.push(`not ${region}`);
  }
  clauses.push(...buildSearchToolPriceClauses(input));
  if (input.max_alcohol_pct !== undefined) {
    clauses.push(`low alcohol ${input.max_alcohol_pct}% 이하`);
  }
  for (const style of buildSearchToolStyleQueryTerms(input)) {
    clauses.push(style);
  }
  for (const occasion of input.occasion ?? []) {
    clauses.push(occasion.replace(/_/gu, ' '));
  }
  if (input.certification !== undefined) {
    clauses.push(input.certification);
  }
  return clauses;
}
