import { describe, expect, it } from 'vitest';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import { computeConflictHoldingAllocationId } from '../core/models/finding-contract-identity.js';
import { formatConflictId } from '../core/models/finding-conflict-identity.js';
import { collectFindingLedgerProjectionInvariantViolations } from '../core/models/finding-ledger-invariants.js';
import { computeFileQuoteEvidenceRecordId } from '../core/models/finding-evidence-record.js';
import { parseFindingLedger } from '../core/models/finding-schemas.js';
import type {
  FindingLedger,
  FindingLifecycleEntityHead,
} from '../core/workflow/findings/types.js';
import {
  appendFreshConflictAdjudicationSnapshot,
  freshConflictAdjudicationSnapshot,
  isActiveConflictUnadjudicated,
} from '../core/workflow/findings/conflict-adjudication-model.js';
import { landUnownedConflictRawClaims } from '../core/workflow/findings/conflict-claim-landing.js';
import { captureFindingLifecycleHead } from '../core/workflow/findings/lifecycle-mutation.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
} from './helpers/finding-lifecycle-fixture.js';

const OBSERVATION = {
  runId: 'run-ladder',
  stepName: 'finding-manager',
  timestamp: '2026-08-02T00:00:00.000Z',
};

const SOURCE_RAW = canonicalRawFindingFixture({
  rawFindingId: 'raw-conflict-landing',
  stepName: 'reviewer',
  reviewer: 'reviewer',
  familyTag: 'bug',
  severity: 'high',
  title: 'Conflicting raw claim',
  description: 'This claim must not disappear while adjudication is pending.',
  suggestion: 'Keep the raw claim in a durable holding.',
  relation: 'new',
  targetFindingId: null,
  target: { kind: 'code', paths: ['src/conflict.ts'] },
  evidence: [{
    kind: 'file_quote',
    path: 'src/conflict.ts',
    startLine: 1,
    endLine: 1,
    verbatimExcerpt: 'export const conflict = true;',
    snapshotId: 'a'.repeat(64),
  }],
});

const SECOND_SOURCE_RAW = canonicalRawFindingFixture({
  rawFindingId: 'raw-conflict-landing-second',
  stepName: 'reviewer',
  reviewer: 'reviewer',
  familyTag: 'bug',
  severity: 'high',
  title: 'Second conflicting raw claim',
  description: 'This independent claim needs its own conflict holding allocation.',
  suggestion: 'Preserve its exact holding ownership.',
  relation: 'new',
  targetFindingId: null,
  target: { kind: 'code', paths: ['src/conflict-second.ts'] },
  evidence: [{
    kind: 'file_quote',
    path: 'src/conflict-second.ts',
    startLine: 1,
    endLine: 1,
    verbatimExcerpt: 'export const secondConflict = true;',
    snapshotId: 'b'.repeat(64),
  }],
});

function evidenceRecordFor(source: typeof SOURCE_RAW, fileHash: string) {
  const quote = source.evidence[0]!;
  if (quote.kind !== 'file_quote') {
    throw new Error('Expected a file quote fixture');
  }
  const payload = {
    ...quote,
    claimIdentityHash: source.claimIdentityHash,
    fileHash,
  };
  return { evidenceId: computeFileQuoteEvidenceRecordId(payload), ...payload };
}

function activeConflictLedger(): FindingLedger {
  const authorized = authorizeFindingLedgerFixture({
    workflowName: 'peer-review',
    nextId: 1,
    updatedAt: OBSERVATION.timestamp,
    findings: [],
    evidenceRecords: [],
    rawFindings: [SOURCE_RAW],
    conflicts: [{
      id: 'C-0001',
      findingIds: [],
      rawFindingIds: [SOURCE_RAW.rawFindingId],
      description: 'The manager recorded a raw-only conflict.',
      status: 'active',
      revision: 1,
      lastSeen: OBSERVATION,
    }],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    ...createEmptyFindingContractRegistries(),
  });
  return {
    ...authorized,
    evidenceRecords: [...authorized.evidenceRecords, evidenceRecordFor(SOURCE_RAW, '1'.repeat(64))],
  };
}

function activeConflictLedgerWithTwoSingletonAllocations(): FindingLedger {
  const conflictShape = {
    findingIds: ['F-0001'],
    rawFindingIds: [SOURCE_RAW.rawFindingId, SECOND_SOURCE_RAW.rawFindingId],
  };
  const conflictId = formatConflictId(conflictShape);
  const authorized = authorizeFindingLedgerFixture({
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: OBSERVATION.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      target: structuredClone(SOURCE_RAW.target),
      targetIdentityHash: SOURCE_RAW.targetIdentityHash,
      claimIdentityHash: SOURCE_RAW.claimIdentityHash,
      semanticClaimIdentityHash: SOURCE_RAW.semanticClaimIdentityHash,
      severity: SOURCE_RAW.severity,
      title: 'Existing product finding',
      description: 'A product finding anchors the active conflict.',
      evidenceIds: [],
      reviewers: ['reviewer'],
      rawFindingIds: [],
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
      revision: 1,
    }],
    evidenceRecords: [
      evidenceRecordFor(SOURCE_RAW, '1'.repeat(64)),
      evidenceRecordFor(SECOND_SOURCE_RAW, '2'.repeat(64)),
    ],
    rawFindings: [SOURCE_RAW, SECOND_SOURCE_RAW],
    conflicts: [{
      id: conflictId,
      ...conflictShape,
      description: 'The manager recorded two independent raw conflict claims.',
      status: 'active',
      revision: 1,
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
    }],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    ...createEmptyFindingContractRegistries(),
  });
  const landed = landUnownedConflictRawClaims({ ledger: authorized, observation: OBSERVATION });
  return appendFreshConflictAdjudicationSnapshot({
    ledger: landed,
    conflictId,
    originStep: OBSERVATION.stepName,
    createdAt: OBSERVATION,
  }).ledger;
}

function transitionProduct(input: {
  ledger: FindingLedger;
  status: 'open' | 'resolved';
  lifecycle: 'reopened' | 'resolved';
  operation: 'reopen_finding' | 'resolve_finding';
}): FindingLedger {
  const current = input.ledger.findings[0]!;
  const before = captureFindingLifecycleHead(input.ledger, 'finding', current.id)!;
  const after: FindingLifecycleEntityHead = {
    entityKind: 'finding',
    entityId: current.id,
    revision: before.revision + 1,
    eventId: `event-${input.operation}-${before.revision + 1}`,
    projectionDigest: `projection-${input.operation}-${before.revision + 1}`,
  };
  return {
    ...input.ledger,
    findings: [{
      ...current,
      status: input.status,
      lifecycle: input.lifecycle,
      revision: current.revision + 1,
    }],
    lifecycleEvents: [...input.ledger.lifecycleEvents, {
      eventId: after.eventId,
      mutationId: `mutation-${after.eventId}`,
      reservationId: `reservation-${after.eventId}`,
      operation: input.operation,
      transitions: [{ before, after }],
      evidenceBindingIds: [],
      outcome: { kind: 'projection_applied' },
      resultDigest: `result-${after.eventId}`,
      occurredAt: OBSERVATION,
    }],
  };
}

describe('finding ladder durability', () => {
  it('lands every manager conflict raw into exactly one durable holding', () => {
    const landed = landUnownedConflictRawClaims({
      ledger: activeConflictLedger(),
      observation: OBSERVATION,
    });
    expect(landed.conflictRawClaimLandings).toHaveLength(1);
    const landing = landed.conflictRawClaimLandings[0]!;
    expect(landing).toMatchObject({
      conflictId: 'C-0001',
      rawFindingId: SOURCE_RAW.rawFindingId,
    });
    expect(landed.findings.find(({ id }) => id === landing.holdingFindingId)).toMatchObject({
      status: 'open',
      provisional: {
        kind: 'raw-adjudication-unresolved',
        sourceRawFindingIds: [SOURCE_RAW.rawFindingId],
        gateEffect: 'block',
      },
    });
  });

  it('is idempotent for an already-owned raw claim', () => {
    const first = landUnownedConflictRawClaims({
      ledger: activeConflictLedger(),
      observation: OBSERVATION,
    });
    const resumed = landUnownedConflictRawClaims({
      ledger: first,
      observation: { ...OBSERVATION, timestamp: '2026-08-02T00:01:00.000Z' },
    });
    expect(resumed.conflictRawClaimLandings).toEqual(first.conflictRawClaimLandings);
    expect(resumed.findings).toEqual(first.findings);
    expect(resumed.lifecycleEvents).toEqual(first.lifecycleEvents);
  });

  it('recomputes the canonical raw claim snapshot digest in ledger invariants', () => {
    const landed = landUnownedConflictRawClaims({
      ledger: activeConflictLedger(),
      observation: OBSERVATION,
    });
    const cleanMessages = collectFindingLedgerProjectionInvariantViolations(landed)
      .map(({ message }) => message);
    expect(cleanMessages.some((message) => (
      /Conflict raw landing.*invalid identity or owner/u.test(message)
    ))).toBe(false);
    const tampered: FindingLedger = {
      ...landed,
      conflictRawClaimLandings: landed.conflictRawClaimLandings.map((landing) => ({
        ...landing,
        claimSnapshotDigest: '0'.repeat(64),
      })),
    };
    const tamperedMessages = collectFindingLedgerProjectionInvariantViolations(tampered)
      .map(({ message }) => message);
    expect(tamperedMessages.some((message) => (
      /Conflict raw landing.*invalid identity or owner/u.test(message)
    ))).toBe(true);
  });

  it('rejects one allocation rewritten to reference two distinct singleton holdings at load', () => {
    const landed = activeConflictLedgerWithTwoSingletonAllocations();
    expect(() => parseFindingLedger(landed)).not.toThrow();
    const conflictId = landed.conflicts[0]!.id;
    const combinedAllocationId = computeConflictHoldingAllocationId(
      conflictId,
      landed.conflictRawClaimLandings.map(({ rawClaimLandingId }) => rawClaimLandingId),
    );
    const malformed: FindingLedger = {
      ...landed,
      conflictRawClaimLandings: landed.conflictRawClaimLandings.map((landing) => ({
        ...landing,
        holdingAllocationId: combinedAllocationId,
      })),
    };

    expect(() => parseFindingLedger(malformed)).toThrow(/allocation.*multiple owners/u);
  });

  it('derives unadjudicated state only from the current durable snapshot', () => {
    const landed = landUnownedConflictRawClaims({
      ledger: activeConflictLedger(),
      observation: OBSERVATION,
    });
    const refreshed = appendFreshConflictAdjudicationSnapshot({
      ledger: landed,
      conflictId: 'C-0001',
      originStep: 'finding-manager',
      createdAt: OBSERVATION,
    }).ledger;
    const snapshot = freshConflictAdjudicationSnapshot(refreshed, 'C-0001');
    expect(snapshot.subjects).toEqual([
      expect.objectContaining({
        role: 'holding_provisional',
        rawClaimLandingIds: [refreshed.conflictRawClaimLandings[0]!.rawClaimLandingId],
      }),
    ]);
    expect(isActiveConflictUnadjudicated(refreshed, 'C-0001')).toBe(true);
  });

  it('selects the fresh snapshot after product lifecycle changes and excludes terminal products', () => {
    const landed = landUnownedConflictRawClaims({
      ledger: activeConflictLedger(),
      observation: OBSERVATION,
    });
    const holding = landed.findings[0]!;
    const { provisional: _provisional, ...product } = holding;
    const productLedger: FindingLedger = {
      ...landed,
      findings: [product],
      conflicts: landed.conflicts.map((conflict) => ({
        ...conflict,
        findingIds: [product.id],
        rawFindingIds: [],
      })),
      conflictRawClaimLandings: [],
    };
    const initial = appendFreshConflictAdjudicationSnapshot({
      ledger: productLedger,
      conflictId: 'C-0001',
      originStep: 'finding-manager',
      createdAt: OBSERVATION,
    });
    expect(initial.snapshot.subjects).toEqual([
      expect.objectContaining({ role: 'product_finding', findingId: product.id }),
    ]);

    const resolved = transitionProduct({
      ledger: initial.ledger,
      status: 'resolved',
      lifecycle: 'resolved',
      operation: 'resolve_finding',
    });
    const afterResolution = appendFreshConflictAdjudicationSnapshot({
      ledger: resolved,
      conflictId: 'C-0001',
      originStep: 'finding-manager',
      createdAt: OBSERVATION,
    });
    expect(afterResolution.snapshot.conflictSnapshotId).not.toBe(initial.snapshot.conflictSnapshotId);
    expect(afterResolution.snapshot.subjects).toEqual([]);
    expect(freshConflictAdjudicationSnapshot(afterResolution.ledger, 'C-0001'))
      .toEqual(afterResolution.snapshot);

    const reopened = transitionProduct({
      ledger: afterResolution.ledger,
      status: 'open',
      lifecycle: 'reopened',
      operation: 'reopen_finding',
    });
    const afterReopen = appendFreshConflictAdjudicationSnapshot({
      ledger: reopened,
      conflictId: 'C-0001',
      originStep: 'finding-manager',
      createdAt: OBSERVATION,
    });
    expect(afterReopen.snapshot.subjects).toEqual([
      expect.objectContaining({ role: 'product_finding', findingId: product.id }),
    ]);
    expect(freshConflictAdjudicationSnapshot(afterReopen.ledger, 'C-0001'))
      .toEqual(afterReopen.snapshot);
  });
});
