import { describe, expect, it } from 'vitest';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import { settleProvisionalsWithCleanEvidence } from '../core/workflow/findings/manager-provisional-settlement.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingManagerOutput,
  RawFinding,
} from '../core/workflow/findings/types.js';
import { canonicalRawFindingFixture } from './helpers/finding-lifecycle-fixture.js';

const observation = { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-18T00:00:00.000Z' };

function finding(id: string, title: string, provisional = false): FindingLedgerEntry {
  const identityRaw = raw(`identity-${id}`, title);
  return {
    id,
    status: 'open',
    lifecycle: 'new',
    target: identityRaw.target,
    targetIdentityHash: identityRaw.targetIdentityHash,
    claimIdentityHash: identityRaw.claimIdentityHash,
    semanticClaimIdentityHash: identityRaw.semanticClaimIdentityHash,
    revision: 1,
    severity: 'high',
    title,
    evidenceIds: [],
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
        gateEffect: 'block' as const,
        firstObservedRound: 1,
      },
    } : {}),
  };
}

function ledger(findings: FindingLedgerEntry[], rawFindings: RawFinding[] = []): FindingLedger {
  return {
    workflowName: 'peer-review',
    nextId: findings.length + 1,
    updatedAt: observation.timestamp,
    findings,
    evidenceRecords: [],
    evidenceBindings: [],
    rawFindings,
    conflicts: [],
    ...createEmptyFindingContractRegistries(),
  };
}

function raw(rawFindingId: string, title: string): RawFinding {
  return canonicalRawFindingFixture({
    rawFindingId,
    stepName: 'reviewer',
    reviewer: 'reviewer',
    familyTag: 'identity',
    severity: 'high',
    title,
    description: 'Case-sensitive description',
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    evidence: [],
  });
}

function emptyOutput(): FindingManagerOutput {
  return {
    anchorAdjudications: [],
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
    dismissedFindings: [],
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
});
