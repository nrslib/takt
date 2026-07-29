import { describe, expect, it } from 'vitest';
import type {
  FindingLedger,
  FindingManagerOutput,
  RawFinding,
} from '../core/workflow/findings/types.js';
import { captureFindingPreconditions } from '../core/workflow/findings/finding-preconditions.js';
import { revalidateManagerPlan } from '../core/workflow/findings/manager-commit-revalidation.js';
import { createEmptyManagerOutput } from '../core/workflow/findings/manager-output.js';
import { reconcileFindingLedger } from '../core/workflow/findings/reconciler.js';
import {
  applyResolutionRenotificationTransitions,
  type ResolutionRenotificationTransition,
} from '../core/workflow/findings/resolution-renotification.js';
import { storedRawReconcileProvenance } from './helpers/finding-integrity.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
} from './helpers/finding-lifecycle-fixture.js';
import { createAnchorAdjudication } from '../core/models/finding-anchor-relevance.js';
import type { FindingManagerRawDecision } from '../core/models/finding-types.js';
import { captureFindingLifecycleHead } from '../core/workflow/findings/lifecycle-mutation.js';
import { applyFindingLifecycleCommands } from '../core/workflow/findings/lifecycle-transaction.js';
import { attachCapturedConflictHeads } from '../core/workflow/findings/manager-commit-plan.js';
import { computeConflictEvidenceHash } from '../core/workflow/findings/adjudication-evidence.js';
import type { ManagerDecisionStageResult } from '../core/workflow/findings/manager-contracts.js';

const OBSERVATION = {
  runId: 'run-1',
  stepName: 'reviewers',
  timestamp: '2026-07-26T00:00:00.000Z',
};

function raw(overrides: Partial<RawFinding> & Pick<RawFinding, 'rawFindingId'>): RawFinding {
  const base = canonicalRawFindingFixture({
    rawFindingId: overrides.rawFindingId,
    stepName: 'reviewers',
    reviewer: 'reviewer',
    familyTag: 'bug',
    severity: 'high',
    title: 'Issue',
    description: 'Issue evidence.',
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    evidence: [],
  });
  const {
    target,
    sourceBinding,
    targetIdentityHash: _targetIdentityHash,
    claimIdentityHash: _claimIdentityHash,
    semanticClaimIdentityHash: _semanticClaimIdentityHash,
    candidateIdentityHash: _candidateIdentityHash,
    ...input
  } = { ...base, ...overrides };
  return canonicalRawFindingFixture({ ...input, target, sourceBinding });
}

function ledger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  const originalRaw = raw({ rawFindingId: 'raw-original' });
  return {
    workflowName: 'test',
    nextId: 2,
    updatedAt: OBSERVATION.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      target: originalRaw.target,
      targetIdentityHash: originalRaw.targetIdentityHash,
      claimIdentityHash: originalRaw.claimIdentityHash,
      semanticClaimIdentityHash: originalRaw.semanticClaimIdentityHash,
      severity: 'high',
      title: 'Issue',
      evidenceIds: [],
      description: 'Issue evidence.',
      reviewers: ['reviewer'],
      rawFindingIds: ['raw-original'],
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
      revision: 1,
    }],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawRecoveryAttempts: [],
    rawRecoveryResults: [],
    rawFindings: [originalRaw],
    conflicts: [],
    interpretations: [],
    ...overrides,
  };
}

function withAnchorAdjudications(
  output: FindingManagerOutput,
): FindingManagerOutput {
  if (output.anchorAdjudications.length > 0) {
    return output;
  }
  const decisions: FindingManagerRawDecision[] = [
    ...output.matches.flatMap((match) => match.rawFindingIds.map((rawFindingId) => ({
      rawFindingId,
      decision: 'same' as const,
      findingId: match.findingId,
      anchorRelevance: 'not_applicable' as const,
      evidence: match.evidence ?? 'Fixture match decision.',
    }))),
    ...output.resolvedFindings.flatMap((finding) => finding.rawFindingIds.map((rawFindingId) => ({
      rawFindingId,
      decision: 'resolved' as const,
      findingId: finding.findingId,
      anchorRelevance: 'not_applicable' as const,
      evidence: finding.evidence,
    }))),
    ...output.reopenedFindings.flatMap((finding) => finding.rawFindingIds.map((rawFindingId) => ({
      rawFindingId,
      decision: 'reopened' as const,
      findingId: finding.findingId,
      anchorRelevance: 'not_applicable' as const,
      evidence: finding.evidence,
    }))),
  ];
  return {
    ...output,
    anchorAdjudications: decisions.map(createAnchorAdjudication),
  };
}

function revalidate(input: {
  managerOutput: FindingManagerOutput;
  capturedLedger: FindingLedger;
  freshLedger: FindingLedger;
  cleanWire: RawFinding[];
  capturedConflictHeads?: ManagerDecisionStageResult['conflictTargetHeads'];
  reviewScopeSnapshotId?: string;
}) {
  return revalidateManagerPlan({
    managerOutput: withAnchorAdjudications(input.managerOutput),
    freshLedger: input.freshLedger,
    cleanWire: input.cleanWire,
    cleanWireById: new Map(input.cleanWire.map((item) => [item.rawFindingId, item])),
    cleanCanonicalById: new Map(),
    capturedPreconditions: captureFindingPreconditions(input.capturedLedger),
    capturedConflictHeads: input.capturedConflictHeads,
    reviewScopeSnapshotId: input.reviewScopeSnapshotId ?? 'scope-test',
    runInput: {
      workflowName: 'test',
      cwd: process.cwd(),
      callNamespace: '',
      parentStep: { name: 'reviewers' },
    } as never,
  });
}

describe('resolution/renotification exact authority', () => {
  it('rejects only a stale conflict resolve and retains an independent manager decision', () => {
    const base = ledger();
    const conflict = {
      id: 'C-0001',
      status: 'active' as const,
      findingIds: ['F-0001'],
      rawFindingIds: [],
      description: 'Captured conflict evidence.',
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
      revision: 1,
    };
    const capturedLedger = authorizeFindingLedgerFixture(ledger({ conflicts: [conflict] }));
    const freshLedger = authorizeFindingLedgerFixture(ledger({
      conflicts: [{
        ...conflict,
        description: 'Fresh evidence changed the conflict.',
        revision: 2,
        lastSeen: { ...OBSERVATION, timestamp: '2026-07-26T00:01:00.000Z' },
      }],
    }));
    const managerOutput = {
      ...createEmptyManagerOutput(),
      resolvedConflicts: [{
        conflictId: conflict.id,
        evidence: 'Resolve using the captured evidence.',
      }],
      disputeNotes: [{
        findingId: base.findings[0]!.id,
        reason: 'Keep the independent note.',
        evidence: 'Independent manager decision.',
      }],
    };

    const result = revalidate({
      managerOutput,
      capturedLedger,
      freshLedger,
      cleanWire: [],
      capturedConflictHeads: new Map([[
        conflict.id,
        {
          lifecycleHead:
            captureFindingLifecycleHead(capturedLedger, 'conflict', conflict.id) ?? null,
          evidenceSetHash: computeConflictEvidenceHash(
            capturedLedger.conflicts[0]!,
            capturedLedger,
            'scope-test',
          ),
          reviewScopeSnapshotId: 'scope-test',
        },
      ]]),
    });

    expect(result.output.resolvedConflicts).toEqual([]);
    expect(result.output.disputeNotes).toEqual(managerOutput.disputeNotes);
    expect(result.staleRejections).toContain(
      'conflictDecisions: conflict "C-0001" (resolve) rejected at commit: captured lifecycle head no longer matches the fresh ledger',
    );
  });

  it.each([
    'referenced raw',
    'referenced finding',
    'review scope',
  ] as const)(
    'rejects a resolve when only the %s dependency changes and retains another decision',
    (changedDependency) => {
      const conflict = {
        id: 'C-0001',
        status: 'active' as const,
        findingIds: ['F-0001'],
        rawFindingIds: [],
        description: 'Stable conflict projection.',
        firstSeen: OBSERVATION,
        lastSeen: OBSERVATION,
        revision: 1,
      };
      const capturedLedger = authorizeFindingLedgerFixture(ledger({ conflicts: [conflict] }));
      const freshLedger = (() => {
        if (changedDependency === 'referenced raw') {
          return {
            ...capturedLedger,
            rawFindings: capturedLedger.rawFindings.map((item) => (
              item.rawFindingId === 'raw-original'
                ? { ...item, description: 'Later raw evidence changed.' }
                : item
            )),
          };
        }
        if (changedDependency === 'referenced finding') {
          return {
            ...capturedLedger,
            findings: capturedLedger.findings.map((finding) => (
              finding.id === 'F-0001'
                ? { ...finding, description: 'Later finding evidence changed.' }
                : finding
            )),
          };
        }
        return capturedLedger;
      })();
      const captured = {
        lifecycleHead:
          captureFindingLifecycleHead(capturedLedger, 'conflict', conflict.id) ?? null,
        evidenceSetHash: computeConflictEvidenceHash(
          capturedLedger.conflicts[0]!,
          capturedLedger,
          'scope-test',
        ),
        reviewScopeSnapshotId: 'scope-test',
      };
      const managerOutput = {
        ...createEmptyManagerOutput(),
        resolvedConflicts: [{
          conflictId: conflict.id,
          evidence: 'Resolve using the captured dependency set.',
        }],
        disputeNotes: [{
          findingId: 'F-0001',
          reason: 'Independent note remains valid.',
          evidence: 'Independent manager decision.',
        }],
      };

      expect(captureFindingLifecycleHead(freshLedger, 'conflict', conflict.id))
        .toEqual(captured.lifecycleHead);
      const result = revalidate({
        managerOutput,
        capturedLedger,
        freshLedger,
        cleanWire: [],
        capturedConflictHeads: new Map([[conflict.id, captured]]),
        reviewScopeSnapshotId: changedDependency === 'review scope'
          ? 'scope-fresh'
          : 'scope-test',
      });

      expect(result.output.resolvedConflicts).toEqual([]);
      expect(result.output.disputeNotes).toEqual(managerOutput.disputeNotes);
      expect(result.staleRejections).toContain(
        'conflictDecisions: conflict "C-0001" (resolve) rejected at commit: captured lifecycle head no longer matches the fresh ledger',
      );
    },
  );

  it('uses the captured conflict head as lifecycle expectedBefore', () => {
    const conflict = {
      id: 'C-0001',
      status: 'active' as const,
      findingIds: ['F-0001'],
      rawFindingIds: [],
      description: 'Captured conflict evidence.',
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
      revision: 1,
    };
    const capturedLedger = authorizeFindingLedgerFixture(ledger({ conflicts: [conflict] }));
    const freshLedger = authorizeFindingLedgerFixture(ledger({
      conflicts: [{
        ...conflict,
        description: 'Fresh evidence changed the conflict.',
        revision: 2,
      }],
    }));
    const freshConflict = freshLedger.conflicts[0]!;
    const { revision: _revision, ...resolvedConflict } = {
      ...freshConflict,
      status: 'resolved' as const,
      resolvedAt: OBSERVATION.timestamp,
      resolvedEvidence: 'Captured manager decision.',
    };
    void _revision;

    const capturedHead = captureFindingLifecycleHead(
      capturedLedger,
      'conflict',
      conflict.id,
    ) ?? null;
    const capturedConflictHead = {
      lifecycleHead: capturedHead,
      evidenceSetHash: computeConflictEvidenceHash(
        capturedLedger.conflicts[0]!,
        capturedLedger,
        'scope-test',
      ),
      reviewScopeSnapshotId: 'scope-test',
    };
    const commands = attachCapturedConflictHeads({
      commands: [{
        operation: 'resolve_conflict',
        changes: { findings: [], conflicts: [resolvedConflict] },
        authority: {
          kind: 'engine_policy',
          decisionKind: 'resolve_conflict',
          decisionDigest: 'a'.repeat(64),
        },
        evidenceSourcesByTarget: new Map(),
      }],
      resolvedConflictIds: new Set([conflict.id]),
      capturedConflictHeads: new Map([[conflict.id, capturedConflictHead]]),
      cwd: process.cwd(),
    });

    expect(commands[0]?.expectedHeadsByTarget?.get(`conflict\0${conflict.id}`))
      .toEqual(capturedHead);
    expect(() => applyFindingLifecycleCommands({
      ledger: freshLedger,
      commands,
      occurredAt: OBSERVATION,
    })).toThrow('Conflict evidence dependency CAS failed for "C-0001"');
  });

  it.each(['match', 'reopen'] as const)(
    'folds normal %s evidence independently of manager and raw input order',
    (mode) => {
      const open = ledger();
      const previousLedger = mode === 'match'
        ? open
        : ledger({
            findings: [{
              ...open.findings[0]!,
              status: 'resolved',
              lifecycle: 'resolved',
              revision: 2,
              resolvedAt: OBSERVATION.timestamp,
              resolvedEvidence: 'Previously fixed.',
            }],
          });
      const observed = captureFindingPreconditions(previousLedger)
        .get('F-0001')!.precondition;
      const relation = mode === 'match' ? 'persists' as const : 'reopened' as const;
      const rawA = raw({
        rawFindingId: 'raw-a',
        relation,
        targetFindingId: 'F-0001',
        targetPrecondition: observed,
        reviewer: 'reviewer-a',
        description: 'Canonical primary evidence.',
        suggestion: 'Apply the canonical fix.',
      });
      const rawZ = raw({
        rawFindingId: 'raw-z',
        relation,
        targetFindingId: 'F-0001',
        targetPrecondition: observed,
        reviewer: 'reviewer-z',
        description: 'Lexically later evidence.',
        suggestion: 'Apply another fix.',
      });
      const reconcile = (rawFindings: RawFinding[], rawFindingIds: string[]) => (
        reconcileFindingLedger({
          previousLedger,
          rawFindings,
          managerOutput: withAnchorAdjudications({
            ...createEmptyManagerOutput(),
            ...(mode === 'match'
              ? { matches: [{ findingId: 'F-0001', rawFindingIds }] }
              : {
                  reopenedFindings: [{
                    findingId: 'F-0001',
                    rawFindingIds,
                    evidence: 'The issue is present again.',
                  }],
                }),
          }),
          context: {
            workflowName: 'test',
            stepName: OBSERVATION.stepName,
            runId: OBSERVATION.runId,
            timestamp: OBSERVATION.timestamp,
          },
          provisionalFindings: [],
          rawFindingDispositions: [],
          verifiedEvidenceRecordsByRawFindingId: new Map(),
          rawProvenanceByRawFindingId: new Map([
            [
              rawA.rawFindingId,
              storedRawReconcileProvenance(rawA, 'reviewer-a', 'lineage-a'),
            ],
            [
              rawZ.rawFindingId,
              storedRawReconcileProvenance(rawZ, 'reviewer-z', 'lineage-z'),
            ],
          ]),
        })
      );

      const forward = reconcile([rawA, rawZ], [rawA.rawFindingId, rawZ.rawFindingId]);
      const reverse = reconcile([rawZ, rawA], [rawZ.rawFindingId, rawA.rawFindingId]);

      expect(reverse).toEqual(forward);
      expect(forward.findings[0]).toMatchObject({
        status: 'open',
        lifecycle: mode === 'match' ? 'persists' : 'reopened',
        description: rawA.description,
        suggestion: rawA.suggestion,
        reviewers: ['reviewer', 'reviewer-a', 'reviewer-z'],
        rawFindingIds: ['raw-a', 'raw-original', 'raw-z'],
      });
    },
  );

  it.each([
    {
      name: 'B→A does not treat an evidence-free anomaly raw outside canonical finding evidence as a resolution',
      managerOutput: {
        ...createEmptyManagerOutput(),
        matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-persists'] }],
      },
      currentRaw: raw({
        rawFindingId: 'raw-persists',
        relation: 'persists',
        targetFindingId: 'F-0001',
      }),
      concurrentRaw: raw({
        rawFindingId: 'raw-anomaly-confirmation',
        relation: 'resolution_confirmation',
        targetFindingId: 'F-0001',
        evidence: [],
      }),
      freshStatus: 'resolved' as const,
      freshLifecycle: 'resolved' as const,
      attachConcurrentRaw: false,
    },
    {
      name: 'A→B does not treat an unverified raw outside canonical finding evidence as renotification authority',
      managerOutput: {
        ...createEmptyManagerOutput(),
        resolvedFindings: [{
          findingId: 'F-0001',
          rawFindingIds: ['raw-confirmation'],
          evidence: 'Fixed.',
        }],
      },
      currentRaw: raw({
        rawFindingId: 'raw-confirmation',
        relation: 'resolution_confirmation',
        targetFindingId: 'F-0001',
      }),
      concurrentRaw: raw({
        rawFindingId: 'raw-anomaly-persists',
        relation: 'persists',
        targetFindingId: 'F-0001',
        evidence: [],
      }),
      freshStatus: 'open' as const,
      freshLifecycle: 'persists' as const,
      attachConcurrentRaw: false,
    },
  ])('$name', (testCase) => {
    const capturedLedger = ledger();
    const observed = captureFindingPreconditions(capturedLedger)
      .get('F-0001')!.precondition;
    const currentRaw = {
      ...testCase.currentRaw,
      targetPrecondition: observed,
    };
    const concurrentRaw = {
      ...testCase.concurrentRaw,
      targetPrecondition: observed,
    };
    const freshLedger = ledger({
      findings: [{
        ...capturedLedger.findings[0]!,
        status: testCase.freshStatus,
        lifecycle: testCase.freshLifecycle,
        revision: 2,
        rawFindingIds: testCase.attachConcurrentRaw
          ? ['raw-original', concurrentRaw.rawFindingId]
          : ['raw-original'],
        ...(testCase.freshStatus === 'resolved'
          ? { resolvedAt: OBSERVATION.timestamp, resolvedEvidence: 'Fixed.' }
          : {}),
      }],
      rawFindings: [...capturedLedger.rawFindings, concurrentRaw],
    });

    const plan = revalidate({
      managerOutput: testCase.managerOutput,
      capturedLedger,
      freshLedger,
      cleanWire: [currentRaw],
    });

    expect(plan.resolutionRenotifications).toEqual([]);
  });

  it('rejects an unrelated intermediate revision even when the current head matches the loose endpoint fields', () => {
    const base = ledger();
    const current = ledger({
      findings: [{
        ...base.findings[0]!,
        revision: 3,
        lifecycle: 'persists',
      }],
      rawFindings: [
        ...base.rawFindings,
        raw({
          rawFindingId: 'raw-confirmation',
          relation: 'resolution_confirmation',
          targetFindingId: 'F-0001',
        }),
        raw({
          rawFindingId: 'raw-persists',
          relation: 'persists',
          targetFindingId: 'F-0001',
        }),
      ],
    });
    const observed = captureFindingPreconditions(base).get('F-0001')!.precondition;
    const expectedTarget = captureFindingPreconditions(current)
      .get('F-0001')!.precondition;
    const transition: ResolutionRenotificationTransition = {
      findingId: 'F-0001',
      observed,
      expectedTarget,
      resolutionRawFindingIds: ['raw-confirmation'],
      renotificationRawFindingIds: ['raw-persists'],
    };

    expect(() => applyResolutionRenotificationTransitions({
      ledger: current,
      transitions: [transition],
      observation: OBSERVATION,
    })).toThrow(/invalid revision transition|CAS failed/i);
  });

  it('folds competing evidence deterministically regardless of raw and transition order', () => {
    const base = ledger();
    const observed = captureFindingPreconditions(base).get('F-0001')!.precondition;
    const confirmationA = raw({
      rawFindingId: 'raw-b-confirmation',
      relation: 'resolution_confirmation',
      targetFindingId: 'F-0001',
      targetPrecondition: observed,
    });
    const confirmationZ = raw({
      rawFindingId: 'raw-y-confirmation',
      relation: 'resolution_confirmation',
      targetFindingId: 'F-0001',
      targetPrecondition: observed,
    });
    const persistsA = raw({
      rawFindingId: 'raw-a-persists',
      relation: 'persists',
      targetFindingId: 'F-0001',
      targetPrecondition: observed,
      reviewer: 'reviewer-a',
      description: 'Deterministic primary evidence.',
      suggestion: 'Apply the deterministic fix.',
    });
    const persistsZ = raw({
      rawFindingId: 'raw-z-persists',
      relation: 'persists',
      targetFindingId: 'F-0001',
      targetPrecondition: observed,
      reviewer: 'reviewer-z',
      description: 'Later lexical evidence.',
      suggestion: 'Apply another fix.',
    });
    const current = ledger({
      findings: [{
        ...base.findings[0]!,
        revision: 2,
        lifecycle: 'persists',
        rawFindingIds: ['raw-original', persistsZ.rawFindingId, persistsA.rawFindingId],
      }],
      rawFindings: [
        persistsZ,
        confirmationZ,
        ...base.rawFindings,
        confirmationA,
        persistsA,
      ],
    });
    const expectedTarget = captureFindingPreconditions(current)
      .get('F-0001')!.precondition;
    const transition = (
      resolutionRawFindingIds: string[],
      renotificationRawFindingIds: string[],
    ): ResolutionRenotificationTransition => ({
      findingId: 'F-0001',
      observed,
      expectedTarget,
      resolutionRawFindingIds,
      renotificationRawFindingIds,
    });

    const forward = applyResolutionRenotificationTransitions({
      ledger: current,
      transitions: [
        transition([confirmationZ.rawFindingId], [persistsZ.rawFindingId]),
        transition([confirmationA.rawFindingId], [persistsA.rawFindingId]),
      ],
      observation: OBSERVATION,
    });
    const reverse = applyResolutionRenotificationTransitions({
      ledger: current,
      transitions: [
        transition([confirmationA.rawFindingId], [persistsA.rawFindingId]),
        transition([confirmationZ.rawFindingId], [persistsZ.rawFindingId]),
      ],
      observation: OBSERVATION,
    });

    expect(reverse).toEqual(forward);
    expect(forward.findings[0]).toMatchObject({
      status: 'open',
      lifecycle: 'reopened',
      revision: 3,
      description: persistsA.description,
      suggestion: persistsA.suggestion,
      reviewers: ['reviewer', 'reviewer-a', 'reviewer-z'],
      rawFindingIds: [
        persistsA.rawFindingId,
        confirmationA.rawFindingId,
        'raw-original',
        confirmationZ.rawFindingId,
        persistsZ.rawFindingId,
      ],
    });
    expect(forward.conflicts[0]?.rawFindingIds).toEqual([
      persistsA.rawFindingId,
      confirmationA.rawFindingId,
      confirmationZ.rawFindingId,
      persistsZ.rawFindingId,
    ]);
  });

  it('rejects replay after the exact transition has already advanced the head', () => {
    const base = ledger();
    const observed = captureFindingPreconditions(base).get('F-0001')!.precondition;
    const confirmation = raw({
      rawFindingId: 'raw-confirmation',
      relation: 'resolution_confirmation',
      targetFindingId: 'F-0001',
      targetPrecondition: observed,
    });
    const persists = raw({
      rawFindingId: 'raw-persists',
      relation: 'persists',
      targetFindingId: 'F-0001',
      targetPrecondition: observed,
    });
    const current = ledger({
      findings: [{
        ...base.findings[0]!,
        revision: 2,
        lifecycle: 'persists',
        rawFindingIds: ['raw-original', persists.rawFindingId],
      }],
      rawFindings: [...base.rawFindings, confirmation, persists],
    });
    const transition: ResolutionRenotificationTransition = {
      findingId: 'F-0001',
      observed,
      expectedTarget: captureFindingPreconditions(current).get('F-0001')!.precondition,
      resolutionRawFindingIds: [confirmation.rawFindingId],
      renotificationRawFindingIds: [persists.rawFindingId],
    };
    const applied = applyResolutionRenotificationTransitions({
      ledger: current,
      transitions: [transition],
      observation: OBSERVATION,
    });

    expect(() => applyResolutionRenotificationTransitions({
      ledger: applied,
      transitions: [transition],
      observation: OBSERVATION,
    })).toThrow(/CAS failed/i);
  });
});
