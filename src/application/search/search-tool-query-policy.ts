import { resolveSemanticStyleQueryTerms } from '../../domain/query/service/semantic-style-query-terms.js';

export interface SearchToolSoftClauseInput {
  readonly exclude_grapes?: readonly string[] | undefined;
  readonly exclude_regions?: readonly string[] | undefined;
  readonly max_price_krw?: number | undefined;
  readonly style?: string | undefined;
  readonly styles?: readonly string[] | undefined;
  readonly certification?: string | undefined;
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
  if (input.max_price_krw !== undefined) {
    clauses.push(`${input.max_price_krw}원 이하`);
  }
  for (const style of resolveSemanticStyleQueryTerms(input)) {
    clauses.push(style);
  }
  if (input.certification !== undefined) {
    clauses.push(input.certification);
  }
  return clauses;
}
