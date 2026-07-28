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

const OBSERVATION = {
  runId: 'run-1',
  stepName: 'reviewers',
  timestamp: '2026-07-26T00:00:00.000Z',
};

function raw(overrides: Partial<RawFinding> & Pick<RawFinding, 'rawFindingId'>): RawFinding {
  return {
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
    ...overrides,
  };
}

function ledger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    workflowName: 'test',
    nextId: 2,
    updatedAt: OBSERVATION.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
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
    rawFindings: [raw({ rawFindingId: 'raw-original' })],
    conflicts: [],
    interpretations: [],
    ...overrides,
  };
}

function revalidate(input: {
  managerOutput: FindingManagerOutput;
  capturedLedger: FindingLedger;
  freshLedger: FindingLedger;
  cleanWire: RawFinding[];
}) {
  return revalidateManagerPlan({
    managerOutput: input.managerOutput,
    freshLedger: input.freshLedger,
    cleanWire: input.cleanWire,
    cleanWireById: new Map(input.cleanWire.map((item) => [item.rawFindingId, item])),
    cleanCanonicalById: new Map(),
    capturedPreconditions: captureFindingPreconditions(input.capturedLedger),
    runInput: {
      workflowName: 'test',
      cwd: process.cwd(),
      callNamespace: '',
      parentStep: { name: 'reviewers' },
    } as never,
  });
}

describe('resolution/renotification exact authority', () => {
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
          managerOutput: {
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
          },
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
