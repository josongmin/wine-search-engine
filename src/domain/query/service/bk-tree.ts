interface BKNode {
  readonly term: string;
  readonly children: Map<number, BKNode>;
}

export class BKTree {
  private constructor(private readonly root: BKNode | null) {}

  static build(terms: readonly string[], distFn: (a: string, b: string) => number): BKTree {
    if (terms.length === 0) return new BKTree(null);
    const root: BKNode = { term: terms[0]!, children: new Map() };
    for (let i = 1; i < terms.length; i++) {
      BKTree.insert(root, terms[i]!, distFn);
    }
    return new BKTree(root);
  }

  search(query: string, maxDistance: number, distFn: (a: string, b: string) => number): Array<{ term: string; distance: number }> {
    if (!this.root) return [];
    const results: Array<{ term: string; distance: number }> = [];
    BKTree.searchNode(this.root, query, maxDistance, distFn, results);
    return results;
  }

  private static insert(node: BKNode, term: string, distFn: (a: string, b: string) => number): void {
    const d = distFn(node.term, term);
    const existing = node.children.get(d);
    if (existing) {
      BKTree.insert(existing, term, distFn);
    } else {
      node.children.set(d, { term, children: new Map() });
    }
  }

  private static searchNode(node: BKNode, query: string, max: number, distFn: (a: string, b: string) => number, out: Array<{ term: string; distance: number }>): void {
    const d = distFn(node.term, query);
    if (d <= max) out.push({ term: node.term, distance: d });
    for (const [k, child] of node.children) {
      if (k >= d - max && k <= d + max) BKTree.searchNode(child, query, max, distFn, out);
    }
  }
}

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[m]![n]!;
}
