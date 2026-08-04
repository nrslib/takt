import { describe, expect, it } from 'vitest';
import {
  computeConflictRawClaimLandingId,
  findingContentAddress,
} from '../core/models/finding-contract-identity.js';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import { createAnchorAdjudication } from '../core/models/finding-anchor-relevance.js';
import { formatConflictId } from '../core/models/finding-conflict-identity.js';
import type {
  FindingLedger,
  FindingManagerOutput,
  RawFinding,
} from '../core/workflow/findings/types.js';
import {
  reconcileFindingLedgerPlan,
  reconcileLedgerConflicts,
} from '../core/workflow/findings/reconciler.js';
import { storedRawReconcileProvenance } from './helpers/finding-integrity.js';
import {
  canonicalRawFindingFixture,
  rawCanonicalSnapshotFixture,
} from './helpers/finding-lifecycle-fixture.js';

const OBSERVATION = {
  runId: 'run-reconciler',
  stepName: 'reviewers',
  timestamp: '2026-08-02T00:00:00.000Z',
};

function ledger(): FindingLedger {
  return {
    workflowName: 'peer-review',
    nextId: 1,
    updatedAt: OBSERVATION.timestamp,
    findings: [],
    evidenceRecords: [],
    rawFindings: [],
    conflicts: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    ...createEmptyFindingContractRegistries(),
  };
}

function raw(rawFindingId = 'raw-reconciler'): RawFinding {
  return canonicalRawFindingFixture({
    rawFindingId,
    stepName: OBSERVATION.stepName,
    reviewer: 'reviewer',
    familyTag: 'bug',
    severity: 'high',
    title: 'Reconciler contract',
    description: 'The reconciler must preserve explicit raw ownership.',
    suggestion: 'Keep the ownership transition explicit.',
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: ['src/reconciler.ts'] },
    evidence: [],
  });
}

function output(overrides: Partial<FindingManagerOutput> = {}): FindingManagerOutput {
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
    ...overrides,
  };
}

function anchoredOutput(
  source: RawFinding,
  decision: 'new' | 'conflict',
  overrides: Partial<FindingManagerOutput>,
): FindingManagerOutput {
  return output({
    anchorAdjudications: [createAnchorAdjudication({
      rawFindingId: source.rawFindingId,
      decision,
      anchorRelevance: 'not_applicable',
      evidence: 'The code target does not require anchor adjudication.',
    })],
    ...overrides,
  });
}

function reconcile(previousLedger: FindingLedger, rawFindings: RawFinding[], managerOutput: FindingManagerOutput) {
  return reconcileFindingLedgerPlan({
    previousLedger,
    rawFindings,
    managerOutput,
    provisionalFindings: [],
    entityProvisionalMutations: [],
    terminalEntityAttachmentFindingIds: new Set(),
    rawProvenanceByRawFindingId: new Map(rawFindings.map((rawFinding) => [
      rawFinding.rawFindingId,
      storedRawReconcileProvenance(
        rawFinding,
        findingContentAddress('reviewer-stable-key', { rawFindingId: rawFinding.rawFindingId }),
        findingContentAddress('lineage-key', { rawFindingId: rawFinding.rawFindingId }),
      ),
    ])),
    verifiedEvidenceRecordsByRawFindingId: new Map(),
    context: {
      workflowName: previousLedger.workflowName,
      stepName: OBSERVATION.stepName,
      runId: OBSERVATION.runId,
      timestamp: OBSERVATION.timestamp,
    },
  });
}

describe('finding reconciler contract', () => {
  it('creates a product finding only from an explicit new outcome', () => {
    const source = raw();
    const plan = reconcile(ledger(), [source], anchoredOutput(source, 'new', {
      newFindings: [{
        rawFindingIds: [source.rawFindingId],
        title: source.title,
        severity: source.severity,
      }],
    }));

    expect(plan.ledger.findings).toEqual([
      expect.objectContaining({
        id: 'F-0001',
        status: 'open',
        rawFindingIds: [source.rawFindingId],
      }),
    ]);
    expect(plan.lifecycleCommands).toHaveLength(1);
    expect(plan.lifecycleCommands[0]?.operation).toBe('create_finding');
  });

  it('creates a normal manager conflict command without resolving it', () => {
    const source = raw('raw-conflict');
    const plan = reconcile(ledger(), [source], anchoredOutput(source, 'conflict', {
      conflicts: [{
        findingIds: [],
        rawFindingIds: [source.rawFindingId],
        description: 'The raw claim requires conflict adjudication.',
      }],
    }));

    expect(plan.ledger.conflicts).toEqual([
      expect.objectContaining({ status: 'active', rawFindingIds: [source.rawFindingId] }),
    ]);
    expect(plan.lifecycleCommands[0]?.operation).toBe('create_conflict');
  });

  it('rejects manager-authored conflict resolution', () => {
    expect(() => reconcile(ledger(), [], output({
      resolvedConflicts: [{ conflictId: 'C-0001', evidence: 'Provider assertion.' }],
    }))).toThrow(/verified conflict adjudication/u);
  });

  it('rejects one raw referenced by multiple manager outcomes', () => {
    const source = raw('raw-duplicate-outcome');
    expect(() => reconcile(ledger(), [source], anchoredOutput(source, 'new', {
      newFindings: [{
        rawFindingIds: [source.rawFindingId],
        title: source.title,
        severity: source.severity,
      }],
      conflicts: [{
        findingIds: [],
        rawFindingIds: [source.rawFindingId],
        description: 'A second incompatible outcome.',
      }],
    }))).toThrow(/multiple manager decisions|multiple explicit reconcile outcomes|exactly one reconcile outcome/u);
  });

  it('requires every Finding Contract registry on the input ledger', () => {
    const incomplete = ledger();
    const { rawCanonicalSnapshots: _snapshots, ...withoutRegistry } = incomplete;
    expect(() => reconcile(withoutRegistry as FindingLedger, [], output()))
      .toThrow();
  });

  it('keeps a resolved conflict unchanged when every observed raw already has exact ownership', () => {
    const existingRaw = raw('raw-existing-conflict');
    const conflictShape = {
      findingIds: ['F-0001'],
      rawFindingIds: [existingRaw.rawFindingId],
    };
    const conflictId = formatConflictId(conflictShape);
    const snapshot = rawCanonicalSnapshotFixture(existingRaw, OBSERVATION);
    const landingIdentity = {
      conflictId,
      rawFindingId: existingRaw.rawFindingId,
      rawCanonicalSnapshotId: snapshot.rawCanonicalSnapshotId,
      rawPayloadDigest: snapshot.rawPayloadDigest,
      claimSnapshotDigest: 'claim-snapshot-existing',
    };
    const previousLedger: FindingLedger = {
      ...ledger(),
      rawFindings: [existingRaw],
      rawCanonicalSnapshots: [snapshot],
      conflicts: [{
        id: conflictId,
        ...conflictShape,
        description: 'Resolved conflict',
        status: 'resolved',
        revision: 2,
        firstSeen: OBSERVATION,
        lastSeen: OBSERVATION,
        resolvedAt: OBSERVATION.timestamp,
        resolvedEvidence: 'Verified adjudication.',
      }],
      conflictRawClaimLandings: [{
        rawClaimLandingId: computeConflictRawClaimLandingId(landingIdentity),
        ...landingIdentity,
        holdingAllocationId: 'holding-allocation-existing',
        holdingFindingId: 'F-0002',
        holdingHeadAfterLanding: {
          entityKind: 'finding',
          entityId: 'F-0002',
          revision: 1,
          eventId: 'holding-event-existing',
          projectionDigest: 'holding-projection-existing',
        },
        landingEventId: 'holding-event-existing',
        landedAt: OBSERVATION,
      }],
    };
    const result = reconcileLedgerConflicts({
      previousLedger,
      managerOutput: anchoredOutput(existingRaw, 'conflict', {
        conflicts: [{ ...conflictShape, description: 'Observed again' }],
      }),
      knownFindingIds: new Set(['F-0001']),
      rawFindingIds: new Set([existingRaw.rawFindingId]),
      usedRawFindingIds: new Set(),
      context: { workflowName: 'peer-review', ...OBSERVATION },
      rawFindings: [existingRaw],
    });

    expect(result.conflicts).toEqual(previousLedger.conflicts);
    expect(result.lifecycleCommands).toEqual([]);
  });

  it('reactivates a resolved conflict when a genuinely new raw claim arrives', () => {
    const existingRaw = raw('raw-old-conflict');
    const newRaw = raw('raw-new-conflict');
    const conflictShape = {
      findingIds: ['F-0001'],
      rawFindingIds: [existingRaw.rawFindingId, newRaw.rawFindingId],
    };
    const conflictId = formatConflictId(conflictShape);
    const previousLedger: FindingLedger = {
      ...ledger(),
      rawFindings: [existingRaw],
      conflicts: [{
        id: conflictId,
        findingIds: ['F-0001'],
        rawFindingIds: [existingRaw.rawFindingId],
        description: 'Resolved conflict',
        status: 'resolved',
        revision: 2,
        firstSeen: OBSERVATION,
        lastSeen: OBSERVATION,
        resolvedAt: OBSERVATION.timestamp,
        resolvedEvidence: 'Verified adjudication.',
      }],
    };
    const managerOutput = output({
      anchorAdjudications: [existingRaw, newRaw].map((source) => createAnchorAdjudication({
        rawFindingId: source.rawFindingId,
        decision: 'conflict',
        anchorRelevance: 'not_applicable',
        evidence: 'The code target does not require anchor adjudication.',
      })),
      conflicts: [{ ...conflictShape, description: 'New claim reactivates the conflict' }],
    });
    const result = reconcileLedgerConflicts({
      previousLedger,
      managerOutput,
      knownFindingIds: new Set(['F-0001']),
      rawFindingIds: new Set(conflictShape.rawFindingIds),
      usedRawFindingIds: new Set(),
      context: { workflowName: 'peer-review', ...OBSERVATION },
      rawFindings: [existingRaw, newRaw],
    });

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        id: conflictId,
        status: 'active',
        revision: 3,
        rawFindingIds: [newRaw.rawFindingId, existingRaw.rawFindingId],
      }),
    ]);
    expect(result.conflicts[0]).not.toHaveProperty('resolvedAt');
    expect(result.lifecycleCommands).toEqual([
      expect.objectContaining({ operation: 'observe_conflict' }),
    ]);
  });
});
