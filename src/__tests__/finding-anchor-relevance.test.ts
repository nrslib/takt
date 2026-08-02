import { describe, expect, it } from 'vitest';
import {
  computeCandidateIdentityHash,
  computeClaimIdentityHash,
  computeSemanticClaimIdentityHash,
  computeTargetIdentityHash,
} from '../core/models/finding-claim-identity.js';
import type {
  CandidateSourceBinding,
  FindingLedger,
  FindingManagerDecisions,
  FindingTarget,
  RawFinding,
} from '../core/models/finding-types.js';
import {
  assembleManagerOutput,
  flattenManagerOutputToDecisions,
} from '../core/workflow/findings/decision-assembly.js';
import {
  authorityAnchorAdjudications,
  computeAnchorRelevanceDecisionDigest,
} from '../core/models/finding-anchor-relevance.js';
import { FindingLifecycleAuthoritySchema } from '../core/models/finding-schemas.js';
import {
  adaptProviderRawDecision,
} from '../core/workflow/findings/manager-raw-decision-adapter.js';

const target: FindingTarget = {
  kind: 'absence',
  predicate: {
    kind: 'path_state',
    path: 'src/required.ts',
    expected: 'absent',
  },
};
const sourceBinding: CandidateSourceBinding = {
  reportDigest: '1'.repeat(64),
  startByte: 0,
  endByte: 32,
  excerptDigest: '2'.repeat(64),
};
const claimIdentityHash = computeClaimIdentityHash({
  target,
  familyTag: 'structure',
  severity: 'high',
  title: 'Required module is absent',
  description: 'The registered task requires src/required.ts.',
  suggestion: 'Add the required module.',
});
const raw: RawFinding = {
  rawFindingId: 'raw-1',
  stepName: 'review',
  reviewer: 'reviewer',
  familyTag: 'structure',
  severity: 'high',
  title: 'Required module is absent',
  description: 'The registered task requires src/required.ts.',
  suggestion: 'Add the required module.',
  target,
  targetIdentityHash: computeTargetIdentityHash(target),
  claimIdentityHash,
  semanticClaimIdentityHash: computeSemanticClaimIdentityHash({
    target,
    title: 'Required module is absent',
    description: 'The registered task requires src/required.ts.',
  }),
  candidateIdentityHash: computeCandidateIdentityHash({
    claimIdentityHash,
    sourceBinding,
  }),
  sourceBinding,
  relation: 'new',
  targetFindingId: null,
  evidence: [],
};
const ledger: FindingLedger = {
  workflowName: 'workflow',
  nextId: 1,
  updatedAt: '2026-07-29T00:00:00.000Z',
  findings: [],
  evidenceRecords: [],
  evidenceBindings: [],
  lifecycleReservations: [],
  lifecycleEvents: [],
  rawFindings: [],
  conflicts: [],
};

function decisions(
  anchorRelevance: FindingManagerDecisions['rawDecisions'][number]['anchorRelevance'] | undefined,
): FindingManagerDecisions {
  return {
    rawDecisions: [{
      rawFindingId: raw.rawFindingId,
      decision: 'new',
      anchorRelevance,
      evidence: 'The quote explicitly requires src/required.ts.',
    }],
    disputeDecisions: [],
    conflictDecisions: [],
    invalidateDecisions: [],
    duplicateDecisions: [],
    dismissDecisions: [],
  } as unknown as FindingManagerDecisions;
}

describe('absence anchor relevance adjudication', () => {
  it('derives the internal sentinel only for non-absence decisions', () => {
    const codeRaw = {
      ...raw,
      target: { kind: 'code' as const, paths: ['src/required.ts'] },
    };
    const adapted = adaptProviderRawDecision({
      rawFindingId: codeRaw.rawFindingId,
      decision: 'new',
      evidence: 'Independent code issue.',
    }, codeRaw);

    expect(adapted.anchorRelevance).toBe('not_applicable');
    expect(() => adaptProviderRawDecision({
      rawFindingId: codeRaw.rawFindingId,
      decision: 'new',
      anchorRelevance: 'not_applicable',
      evidence: 'Legacy external sentinel.',
    }, codeRaw)).toThrow(/must omit anchorRelevance/);
  });

  it('requires an explicit binary anchor decision for absence targets', () => {
    expect(adaptProviderRawDecision({
      rawFindingId: raw.rawFindingId,
      decision: 'new',
      anchorRelevance: 'relevant',
      evidence: 'The task quote establishes the obligation.',
    }, raw).anchorRelevance).toBe('relevant');
    expect(adaptProviderRawDecision({
      rawFindingId: raw.rawFindingId,
      decision: 'new',
      anchorRelevance: 'not_relevant',
      evidence: 'The quote does not establish the obligation.',
    }, raw).anchorRelevance).toBe('not_relevant');
    expect(() => adaptProviderRawDecision({
      rawFindingId: raw.rawFindingId,
      decision: 'new',
      evidence: 'No explicit anchor decision.',
    }, raw)).toThrow(/requires anchorRelevance/);
    expect(() => adaptProviderRawDecision({
      rawFindingId: raw.rawFindingId,
      decision: 'new',
      anchorRelevance: 'not_applicable',
      evidence: 'Legacy external sentinel.',
    }, raw)).toThrow(/requires anchorRelevance/);
  });

  it.each([
    ['missing', undefined],
    ['not relevant', 'not_relevant' as const],
  ])('does not grant product output when relevance is %s', (_label, relevance) => {
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [raw],
      decisions: decisions(relevance),
      checkMissingDecisions: true,
    });

    expect(result.output.newFindings).toEqual([]);
    expect(result.rejectedRawDecisions[0]?.reason).toMatch(
      /requires an explicit relevant anchor adjudication/,
    );
  });

  it('allows assembly only after an explicit relevant decision', () => {
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [raw],
      decisions: decisions('relevant'),
      checkMissingDecisions: true,
    });

    expect(result.rejectedRawDecisions).toEqual([]);
    expect(result.output.newFindings).toEqual([{
      rawFindingIds: [raw.rawFindingId],
      title: raw.title,
      severity: raw.severity,
    }]);
    expect(result.output.anchorAdjudications).toHaveLength(1);
    expect(flattenManagerOutputToDecisions(result.output).decisions.rawDecisions).toEqual(
      decisions('relevant').rawDecisions,
    );
  });

  it('does not synthesize anchor relevance during flattening', () => {
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [raw],
      decisions: decisions('relevant'),
      checkMissingDecisions: true,
    });

    expect(() => flattenManagerOutputToDecisions({
      ...result.output,
      anchorAdjudications: [],
    })).toThrow(/missing anchor adjudication/);
  });

  it('rejects a tampered manager output binding while keeping rationale non-authoritative', () => {
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [raw],
      decisions: decisions('relevant'),
      checkMissingDecisions: true,
    });
    const adjudication = result.output.anchorAdjudications[0]!;
    expect(() => flattenManagerOutputToDecisions({
      ...result.output,
      anchorAdjudications: [{
        ...adjudication,
        decision: 'not_relevant',
      }],
    })).toThrow(/mismatched manager output binding/);

    expect(flattenManagerOutputToDecisions({
      ...result.output,
      anchorAdjudications: [{
        ...adjudication,
        rationale: 'Changed audit-only rationale.',
      }],
    }).decisions.rawDecisions[0]?.anchorRelevance).toBe('relevant');
  });

  it('binds lifecycle authority to raw identity, explicit decision, and manager output binding', () => {
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [raw],
      decisions: decisions('relevant'),
      checkMissingDecisions: true,
    });
    const authorityAdjudications = authorityAnchorAdjudications({
      rawFindingIds: [raw.rawFindingId],
      adjudications: result.output.anchorAdjudications,
    });
    const digest = computeAnchorRelevanceDecisionDigest({
      operation: 'create_finding',
      rawFindings: [raw],
      adjudications: authorityAdjudications,
    });

    expect(computeAnchorRelevanceDecisionDigest({
      operation: 'create_finding',
      rawFindings: [raw],
      adjudications: authorityAdjudications,
    })).toBe(digest);
    expect(computeAnchorRelevanceDecisionDigest({
      operation: 'create_finding',
      rawFindings: [{
        ...raw,
        candidateIdentityHash: 'f'.repeat(64),
      }],
      adjudications: authorityAdjudications,
    })).not.toBe(digest);
    expect(computeAnchorRelevanceDecisionDigest({
      operation: 'create_finding',
      rawFindings: [raw],
      adjudications: [{
        ...authorityAdjudications[0]!,
        managerOutputBinding: 'e'.repeat(64),
      }],
    })).not.toBe(digest);
    expect(() => computeAnchorRelevanceDecisionDigest({
      operation: 'create_finding',
      rawFindings: [raw],
      adjudications: [{
        ...authorityAdjudications[0]!,
        decision: 'not_relevant' as never,
      }],
    })).toThrow(/rejects raw finding/);
  });

  it('requires explicit adjudications in persisted anchor lifecycle authority', () => {
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [raw],
      decisions: decisions('relevant'),
      checkMissingDecisions: true,
    });
    const anchorAdjudications = authorityAnchorAdjudications({
      rawFindingIds: [raw.rawFindingId],
      adjudications: result.output.anchorAdjudications,
    });
    const decisionDigest = computeAnchorRelevanceDecisionDigest({
      operation: 'create_finding',
      rawFindings: [raw],
      adjudications: anchorAdjudications,
    });

    expect(() => FindingLifecycleAuthoritySchema.parse({
      kind: 'engine_policy',
      decisionKind: 'anchor_relevance',
      decisionDigest,
    })).toThrow();
    expect(FindingLifecycleAuthoritySchema.parse({
      kind: 'engine_policy',
      decisionKind: 'anchor_relevance',
      decisionDigest,
      anchorAdjudications,
    })).toEqual({
      kind: 'engine_policy',
      decisionKind: 'anchor_relevance',
      decisionDigest,
      anchorAdjudications,
    });
  });
});
