import { describe, expect, it, vi } from 'vitest';

vi.mock(
  '../core/workflow/findings/raw-finding-id-allocation-hash.js',
  () => ({
    hashRawFindingIdAllocationContent: () => 'forced-collision',
  }),
);

import { foldRawFindingEvidence } from '../core/workflow/findings/finding-evidence-fold.js';
import {
  canonicalizeReviewerRawFinding,
  createReviewerRawFindingCandidates,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import type {
  FindingLedger,
  RawAmbiguityCode,
} from '../core/workflow/findings/types.js';

const context = {
  workflowName: 'peer-review',
  callNamespace: '',
  parentStepName: 'reviewers',
  stepIteration: 1,
  runId: 'run-1',
  reviewerPersonaKey: 'arch-review',
  reviewerStepName: 'arch-review',
} as const;

const ledger: FindingLedger = {
  workflowName: 'peer-review',
  nextId: 1,
  updatedAt: '2026-07-26T00:00:00.000Z',
  rawFindings: [],
  conflicts: [],
  interpretations: [],
  findings: [],
};

function project(items: readonly unknown[]) {
  const candidates = createReviewerRawFindingCandidates(items, context);
  const priorCodesByRawId: Record<string, RawAmbiguityCode[]> = {
    'z-clarification': ['relation-target-mismatch'],
  };
  const canonicals = candidates.map((candidate) => {
    const priorCodes = candidate.reviewerRawFindingId !== undefined
      ? priorCodesByRawId[candidate.reviewerRawFindingId]
      : undefined;
    return canonicalizeReviewerRawFinding(candidate, {
      ledger,
      clarificationAttempted: true,
      ...(priorCodes !== undefined ? { priorAmbiguityCodes: priorCodes } : {}),
    }).canonical;
  });
  const rawFindings = canonicals.map(toLedgerRawFinding);
  return {
    idsByTitle: Object.fromEntries(candidates.map((candidate) => [
      candidate.title,
      candidate.reviewerRawFindingId,
    ])),
    intakeIdsByTitle: Object.fromEntries(candidates.map((candidate) => [
      candidate.title,
      candidate.intakeId,
    ])),
    clarification: candidates.find(
      (candidate) => candidate.reviewerRawFindingId === 'z-clarification',
    ),
    clarificationCanonical: canonicals.find(
      (canonical) => canonical.title === 'Clarification',
    ),
    evidence: foldRawFindingEvidence(rawFindings),
  };
}

describe('duplicate rawFindingId allocation under hash collision', () => {
  const first = {
    rawFindingId: 'duplicate',
    familyTag: 'correctness',
    severity: 'high',
    title: 'Alpha',
    location: 'src/alpha.ts:1',
    description: 'Alpha evidence',
    suggestion: 'Fix alpha',
    relation: 'new',
    evidenceKind: 'source_quote',
    verbatimExcerpt: 'const alpha = true;',
    snapshotId: 'snapshot-1',
  };
  const second = {
    rawFindingId: 'duplicate',
    familyTag: 'correctness',
    severity: 'medium',
    title: 'Beta',
    location: 'src/beta.ts:2',
    description: 'Beta evidence',
    suggestion: 'Fix beta',
    relation: 'new',
    evidenceKind: 'source_quote',
    verbatimExcerpt: 'const beta = true;',
    snapshotId: 'snapshot-1',
  };
  const clarification = {
    rawFindingId: 'z-clarification',
    familyTag: 'correctness',
    severity: 'low',
    title: 'Clarification',
    description: 'Clarification evidence',
    relation: 'new',
    evidenceKind: 'locationless',
  };

  it('uses complete normalized content after the hash before input index', () => {
    const forward = project([first, second, clarification]);
    const reversed = project([second, first, clarification]);

    expect(forward.idsByTitle).toEqual(reversed.idsByTitle);
    expect(forward.evidence).toEqual(reversed.evidence);
    expect(forward.clarification?.reviewerRawFindingId).toBe('z-clarification');
    expect(forward.clarificationCanonical?.provenance.ambiguityOrigin).toBe(true);
    expect(forward.clarificationCanonical?.provenance.ambiguityCodes)
      .toContain('relation-target-mismatch');
  });

  it.each([
    ['NFC and decomposed accents', 'é', 'e\u0301'],
    ['letter case', 'Alpha', 'alpha'],
    ['supplementary code points', '\u{1F600}', '\u{1F601}'],
  ])('allocates colliding %s by content independently of input order', (
    _case,
    leftTitle,
    rightTitle,
  ) => {
    const left = { ...first, title: leftTitle };
    const right = { ...second, title: rightTitle };
    const forward = project([left, right, clarification]);
    const reversed = project([right, left, clarification]);

    expect(forward.idsByTitle).toEqual(reversed.idsByTitle);
    expect(new Set(Object.values(forward.idsByTitle)).size).toBe(3);
  });

  it('uses input index only when normalized contents are identical', () => {
    const candidates = createReviewerRawFindingCandidates([
      { ...first },
      { ...first },
    ], context);

    expect(candidates.map((candidate) => candidate.reviewerRawFindingId))
      .toEqual(['duplicate', 'duplicate-dup2']);
    expect(new Set(candidates.map((candidate) => candidate.intakeId)).size).toBe(2);
  });

  it('allocates missing IDs by complete content under a hash collision', () => {
    const firstWithoutId = { ...first, rawFindingId: undefined };
    const secondWithoutId = { ...second, rawFindingId: undefined };

    const forward = project([firstWithoutId, secondWithoutId]);
    const reversed = project([secondWithoutId, firstWithoutId]);

    expect(forward.intakeIdsByTitle).toEqual(reversed.intakeIdsByTitle);
    expect(new Set(Object.values(forward.intakeIdsByTitle)).size).toBe(2);
  });

  it('uniquifies completely identical missing-ID candidates with the final input-position tie break', () => {
    const identicalWithoutId = { ...first, rawFindingId: undefined };
    const candidates = createReviewerRawFindingCandidates([
      { ...identicalWithoutId },
      { ...identicalWithoutId },
    ], context);

    expect(new Set(candidates.map((candidate) => candidate.intakeId)).size).toBe(2);
    expect(candidates[0]?.intakeId.endsWith('item-forced-collision')).toBe(true);
    expect(candidates[1]?.intakeId.endsWith('item-forced-collision-dup2')).toBe(true);
  });

  it('preserves an existing explicit suffixed ID while allocating duplicates', () => {
    const candidates = createReviewerRawFindingCandidates([
      first,
      {
        ...second,
        rawFindingId: 'duplicate-dup2',
        title: 'Existing suffix',
      },
      second,
    ], context);
    const idsByTitle = Object.fromEntries(candidates.map((candidate) => [
      candidate.title,
      candidate.reviewerRawFindingId,
    ]));

    expect(idsByTitle['Existing suffix']).toBe('duplicate-dup2');
    expect(new Set(candidates.map((candidate) => candidate.reviewerRawFindingId)).size)
      .toBe(3);
  });
});
