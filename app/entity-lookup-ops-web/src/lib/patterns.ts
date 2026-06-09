// Superseded by residue.ts (evidence-based classifier) — kept as a re-export so
// existing imports resolve. The earlier heuristic "latest-vintage flagship" was
// removed per repo policy (decisions must be evidence-based, not heuristic).
export { classifyResidue, groupByBucket, GAP_LABEL, CLASS_LABEL } from './residue';
