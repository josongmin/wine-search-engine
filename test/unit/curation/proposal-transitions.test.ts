import { describe, expect, it } from 'vitest';
import {
  PROPOSAL_STATUSES,
  assertTransition,
  canTransition,
  isProposalKind,
  isProposalStatus,
  reviewDecisionToStatus,
  IllegalProposalTransitionError,
  type ProposalStatus,
} from '../../../src/domain/curation/model/proposal.js';

/**
 * T-ELV2-07 — curation proposal lifecycle invariants.
 *
 * The legal graph is:
 *   pending  → approved | rejected
 *   approved → published | rejected
 *   rejected / published are terminal.
 * Everything else is illegal (notably: publish a pending proposal, or mutate a
 * terminal one). This is the precision-first guard for staged runtime changes.
 */
const LEGAL: ReadonlyArray<readonly [ProposalStatus, ProposalStatus]> = [
  ['pending', 'approved'],
  ['pending', 'rejected'],
  ['approved', 'published'],
  ['approved', 'rejected'],
];

describe('canTransition — full legality matrix', () => {
  it('accepts exactly the legal transitions and rejects all others', () => {
    for (const from of PROPOSAL_STATUSES) {
      for (const to of PROPOSAL_STATUSES) {
        const expected = LEGAL.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to)).toBe(expected);
      }
    }
  });

  it('treats rejected and published as terminal (no outgoing transitions)', () => {
    for (const to of PROPOSAL_STATUSES) {
      expect(canTransition('rejected', to)).toBe(false);
      expect(canTransition('published', to)).toBe(false);
    }
  });

  it('never allows skipping review (pending → published is illegal)', () => {
    expect(canTransition('pending', 'published')).toBe(false);
  });

  it('disallows self-transitions', () => {
    for (const s of PROPOSAL_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });
});

describe('assertTransition', () => {
  it('throws IllegalProposalTransitionError on an illegal step', () => {
    expect(() => assertTransition('pending', 'published')).toThrow(IllegalProposalTransitionError);
    expect(() => assertTransition('published', 'approved')).toThrow(IllegalProposalTransitionError);
  });

  it('does not throw on a legal step', () => {
    expect(() => assertTransition('pending', 'approved')).not.toThrow();
    expect(() => assertTransition('approved', 'published')).not.toThrow();
  });
});

describe('reviewDecisionToStatus', () => {
  it('maps approve→approved and reject→rejected', () => {
    expect(reviewDecisionToStatus('approve')).toBe('approved');
    expect(reviewDecisionToStatus('reject')).toBe('rejected');
  });
});

describe('type guards', () => {
  it('isProposalStatus accepts the four states and rejects junk', () => {
    expect(isProposalStatus('pending')).toBe(true);
    expect(isProposalStatus('published')).toBe(true);
    expect(isProposalStatus('PENDING')).toBe(false);
    expect(isProposalStatus('archived')).toBe(false);
    expect(isProposalStatus('')).toBe(false);
  });

  it('isProposalKind accepts the three kinds and rejects junk', () => {
    expect(isProposalKind('alias')).toBe(true);
    expect(isProposalKind('ambiguity')).toBe(true);
    expect(isProposalKind('suppression')).toBe(true);
    expect(isProposalKind('threshold')).toBe(false);
    expect(isProposalKind('')).toBe(false);
  });
});
