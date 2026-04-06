/**
 * BK-tree data structure for approximate string matching.
 *
 * Stores terms in a tree where edges are labelled by Levenshtein distance.
 * Supports efficient range queries: given a query term and a maximum edit
 * distance, the tree prunes subtrees whose distances fall outside the
 * triangle-inequality window.
 */

/**
 * Computes the Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Optimisation: use a single-row DP array.
  const row: number[] = Array.from({ length: n + 1 }, (_, i) => i);

  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(
        (row[j] ?? 0) + 1,          // deletion
        (row[j - 1] ?? 0) + 1,      // insertion
        prev + cost,                  // substitution
      );
      prev = row[j] ?? 0;
      row[j] = val;
    }
  }

  return row[n] ?? 0;
}

interface BKNode {
  readonly term: string;
  readonly children: Map<number, BKNode>;
}

export interface BKSearchResult {
  readonly term: string;
  readonly editDistance: number;
}

/**
 * BK-tree supporting build-once, query-many approximate lookups.
 */
export class BKTree {
  private root: BKNode | undefined;

  /**
   * Inserts a term into the tree.
   */
  insert(term: string): void {
    if (this.root === undefined) {
      this.root = { term, children: new Map() };
      return;
    }

    let current = this.root;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const d = levenshteinDistance(term, current.term);
      if (d === 0) return; // duplicate
      const child = current.children.get(d);
      if (child === undefined) {
        current.children.set(d, { term, children: new Map() });
        return;
      }
      current = child;
    }
  }

  /**
   * Searches for all terms within `maxDistance` edit distance of `query`.
   */
  search(query: string, maxDistance: number): readonly BKSearchResult[] {
    if (this.root === undefined) return [];

    const results: BKSearchResult[] = [];
    const stack: BKNode[] = [this.root];

    while (stack.length > 0) {
      const node = stack.pop()!;
      const d = levenshteinDistance(query, node.term);

      if (d <= maxDistance) {
        results.push({ term: node.term, editDistance: d });
      }

      // Triangle inequality pruning: only visit children with edge labels
      // in the range [d - maxDistance, d + maxDistance].
      const lo = d - maxDistance;
      const hi = d + maxDistance;
      for (const [edge, child] of node.children) {
        if (edge >= lo && edge <= hi) {
          stack.push(child);
        }
      }
    }

    return results;
  }
}
