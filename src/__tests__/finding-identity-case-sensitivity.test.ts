import { describe, expect, it } from 'vitest';
import { settleProvisionalsWithCleanEvidence } from '../core/workflow/findings/manager-provisional-settlement.js';
import { buildLadderCommitPlan } from '../core/workflow/findings/manager-ladder-commit-plan.js';
import {
  canonicalizeReviewerRawFinding,
  createReviewerRawFindingCandidates,
} from '../core/workflow/findings/raw-canonicalization.js';
import type { LadderResult } from '../core/workflow/findings/manager-contracts.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingManagerOutput,
  RawFinding,
} from '../core/workflow/findings/types.js';

const observation = { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-18T00:00:00.000Z' };

function finding(id: string, title: string, provisional = false): FindingLedgerEntry {
  return {
    id,
    status: 'open',
    lifecycle: 'new',
    severity: 'high',
    title,
    location: 'src/Path.ts:10',
    description: 'Case-sensitive description',
    reviewers: ['reviewer'],
    rawFindingIds: [],
    firstSeen: observation,
    lastSeen: observation,
    ...(provisional ? {
      provisional: {
        kind: 'raw-meaning-ambiguous' as const,
        stableKey: `stable-${id}`,
        lineageKey: `lineage-${id}`,
        sourceRawFindingIds: [],
        reason: 'ambiguous',
        firstObservedAt: observation,
        lastObservedAt: observation,
        interpretationEpochs: 1,
        gateEffect: 'block' as const,
      },
    } : {}),
  };
}

function ledger(findings: FindingLedgerEntry[], rawFindings: RawFinding[] = []): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: findings.length + 1,
    updatedAt: observation.timestamp,
    findings,
    rawFindings,
    conflicts: [],
  };
}

function raw(rawFindingId: string, title: string): RawFinding {
  return {
    rawFindingId,
    stepName: 'reviewer',
    reviewer: 'reviewer',
    familyTag: 'identity',
    severity: 'high',
    title,
    location: 'src/Path.ts:10',
    description: 'Case-sensitive description',
    relation: 'new',
  };
}

function emptyOutput(): FindingManagerOutput {
  return {
    matches: [],
    newFindings: [],
    resolvedFindings: [],
    reopenedFindings: [],
    conflicts: [],
    resolvedConflicts: [],
    waivedFindings: [],
    disputeNotes: [],
    invalidatedFindings: [],
    duplicateFindings: [],
  };
}

describe('finding identity case sensitivity', () => {
  it('should not promote a provisional from a clean new finding that differs only by case', () => {
    const wire = raw('raw-new', 'Parser Path');
    const output = { ...emptyOutput(), newFindings: [{ rawFindingIds: [wire.rawFindingId], title: wire.title, severity: wire.severity }] };

    const result = settleProvisionalsWithCleanEvidence({
      output,
      cleanRawIds: new Set([wire.rawFindingId]),
      wireById: new Map([[wire.rawFindingId, wire]]),
      freshLedger: ledger([finding('F-0001', 'Parser PATH', true)]),
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set(),
      healthyReviewerStableKeys: new Set(),
      replayOrigins: new Map(),
    });

    expect(result.promotedFindingIds.size).toBe(0);
    expect(result.output.newFindings).toEqual(output.newFindings);
  });

  it('should not resolve a provisional against a target whose identity differs only by case', () => {
    const wire = raw('raw-match', 'Parser Path');
    const target = finding('F-0001', 'Parser Path');
    const provisional = finding('F-0002', 'Parser PATH', true);

    const result = settleProvisionalsWithCleanEvidence({
      output: { ...emptyOutput(), matches: [{ findingId: target.id, rawFindingIds: [wire.rawFindingId], evidence: 'matched' }] },
      cleanRawIds: new Set([wire.rawFindingId]),
      wireById: new Map([[wire.rawFindingId, wire]]),
      freshLedger: ledger([target, provisional]),
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set(),
      healthyReviewerStableKeys: new Set(),
      replayOrigins: new Map(),
    });

    expect(result.resolvedByMapping.size).toBe(0);
  });

  it('should keep an applied reattachment provisional when the existing identity differs only by case', () => {
    const wire = raw('raw-reattach', 'Parser Path');
    const currentLedger = ledger([finding('F-0001', 'Parser PATH')]);
    const candidate = createReviewerRawFindingCandidates([wire], {
      workflowName: 'peer-review',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 1,
      runId: 'run-2',
      reviewerStepName: 'reviewer',
      reviewerPersonaKey: 'reviewer',
    })[0]!;
    const canonical = canonicalizeReviewerRawFinding(candidate, { ledger: currentLedger }).canonical;
    const ladder: LadderResult = {
      interpretationReservations: new Map(),
      deferredRawFindingIds: new Set(),
      pendingSameWithProof: [],
      pendingIndependentNew: [],
      pendingConflicts: [],
      provisionalSpecs: [],
      provisionalByInterpretationKey: new Map(),
      recoveryProvisionalInterpretationKeys: new Set(),
      pendingAppliedReattach: [{
        target: {
          wire,
          canonical,
          baseInterpretationKey: 'interpretation-base-1',
          interpretationKey: 'interpretation-1',
          attemptOrdinal: 1,
        },
        applicationResult: 'created',
      }],
      stats: {} as LadderResult['stats'],
    };

    const result = buildLadderCommitPlan(ladder, currentLedger);

    expect(result.output.matches).toEqual([]);
    expect(result.provisionalSpecs).toHaveLength(1);
  });
});
