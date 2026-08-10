import { describe, expect, it } from 'vitest';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import { computeConflictRawClaimLandingId } from '../core/models/finding-contract-identity.js';
import { buildConflictAdjudicationSnapshot } from '../core/workflow/findings/conflict-adjudication-model.js';
import {
  applyProvisionalSettlement,
  settleProvisionalsWithCleanEvidence,
} from '../core/workflow/findings/manager-provisional-settlement.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingManagerOutput,
  FindingLifecycleEvent,
  RawFinding,
} from '../core/workflow/findings/types.js';
import {
  canonicalRawFindingFixture,
  rawCanonicalSnapshotFixture,
} from './helpers/finding-lifecycle-fixture.js';

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

function lifecycleEvent(
  operation: FindingLifecycleEvent['operation'],
  head: {
    entityKind: 'finding' | 'conflict';
    entityId: string;
    revision: number;
    eventId: string;
    projectionDigest: string;
  },
): FindingLifecycleEvent {
  return {
    eventId: head.eventId,
    mutationId: `mutation-${head.eventId}`,
    reservationId: `reservation-${head.eventId}`,
    operation,
    transitions: [{ before: null, after: head }],
    evidenceBindingIds: [],
    outcome: { kind: 'projection_applied' },
    resultDigest: `result-${head.eventId}`,
    occurredAt: observation,
  };
}

function conflictHoldingLedger(status: 'active' | 'resolved'): {
  ledger: FindingLedger;
  resolutionRaw: RawFinding;
} {
  const holding = finding('F-0001', 'Conflict holding', true);
  const conflictRaw = raw('raw-conflict', 'Conflicting claim');
  const resolutionRaw = {
    ...raw('raw-resolution', 'Resolution confirmation'),
    relation: 'resolution_confirmation' as const,
    targetFindingId: holding.id,
  };
  const rawSnapshot = rawCanonicalSnapshotFixture(conflictRaw, observation);
  const conflictId = 'C-0001';
  const holdingHead = {
    entityKind: 'finding' as const,
    entityId: holding.id,
    revision: holding.revision,
    eventId: 'event-F-0001-1',
    projectionDigest: 'projection-F-0001-1',
  };
  const conflictHead = {
    entityKind: 'conflict' as const,
    entityId: conflictId,
    revision: 1,
    eventId: 'event-C-0001-1',
    projectionDigest: 'projection-C-0001-1',
  };
  const landingIdentity = {
    conflictId,
    rawFindingId: conflictRaw.rawFindingId,
    rawCanonicalSnapshotId: rawSnapshot.rawCanonicalSnapshotId,
    rawPayloadDigest: rawSnapshot.rawPayloadDigest,
    claimSnapshotDigest: 'claim-snapshot-conflict',
  };
  const landing = {
    rawClaimLandingId: computeConflictRawClaimLandingId(landingIdentity),
    ...landingIdentity,
    holdingAllocationId: 'allocation-F-0001',
    holdingFindingId: holding.id,
    holdingHeadAfterLanding: holdingHead,
    landingEventId: holdingHead.eventId,
    landedAt: observation,
  };
  return {
    ledger: {
      ...ledger([holding], [conflictRaw]),
      updatedAt: observation.timestamp,
      rawCanonicalSnapshots: [rawSnapshot],
      conflicts: [{
        id: conflictId,
        status,
        findingIds: [],
        rawFindingIds: [conflictRaw.rawFindingId],
        description: 'Conflicting claim requires adjudication.',
        firstSeen: observation,
        lastSeen: observation,
        revision: 1,
        ...(status === 'resolved'
          ? {
              resolvedAt: observation.timestamp,
              resolvedEvidence: 'Conflict adjudication completed.',
            }
          : {}),
      }],
      conflictRawClaimLandings: [landing],
      lifecycleEvents: [
        lifecycleEvent('create_finding', holdingHead),
        lifecycleEvent('create_conflict', conflictHead),
      ],
    },
    resolutionRaw,
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

  it('should keep an unsettled active conflict holding provisional until adjudication finishes', () => {
    const fixture = conflictHoldingLedger('active');
    const output = {
      ...emptyOutput(),
      resolvedFindings: [{
        findingId: 'F-0001',
        rawFindingIds: [fixture.resolutionRaw.rawFindingId],
        evidence: 'The finding is no longer present.',
      }],
    };
    const settlement = settleProvisionalsWithCleanEvidence({
      output,
      cleanRawIds: new Set([fixture.resolutionRaw.rawFindingId]),
      wireById: new Map([[fixture.resolutionRaw.rawFindingId, fixture.resolutionRaw]]),
      freshLedger: {
        ...fixture.ledger,
        rawFindings: [...fixture.ledger.rawFindings, fixture.resolutionRaw],
      },
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set(),
      healthyReviewerStableKeys: new Set(),
    });
    const settled = applyProvisionalSettlement(
      fixture.ledger,
      settlement,
      observation.timestamp,
    );

    expect(settlement.resolvedByEvidence.size).toBe(0);
    expect(settled.findings[0]).toMatchObject({
      id: 'F-0001',
      status: 'open',
      provisional: expect.any(Object),
    });
    expect(() => buildConflictAdjudicationSnapshot({
      ledger: settled,
      conflictId: 'C-0001',
      originStep: 'reviewer',
      createdAt: observation,
    })).not.toThrow();
  });

  it('should settle the same provisional after the conflict is adjudicated', () => {
    const fixture = conflictHoldingLedger('resolved');
    const resolutionRaw = fixture.resolutionRaw;
    const settlement = settleProvisionalsWithCleanEvidence({
      output: {
        ...emptyOutput(),
        resolvedFindings: [{
          findingId: 'F-0001',
          rawFindingIds: [resolutionRaw.rawFindingId],
          evidence: 'The finding is no longer present.',
        }],
      },
      cleanRawIds: new Set([resolutionRaw.rawFindingId]),
      wireById: new Map([[resolutionRaw.rawFindingId, resolutionRaw]]),
      freshLedger: {
        ...fixture.ledger,
        rawFindings: [...fixture.ledger.rawFindings, resolutionRaw],
      },
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set(),
      healthyReviewerStableKeys: new Set(),
    });

    expect(settlement.resolvedByEvidence).toEqual(new Map([
      ['F-0001', 'The finding is no longer present.'],
    ]));
  });

});
